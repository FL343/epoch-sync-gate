'use strict';
// fetch.js - job "fetch": decide whether this batch may go through the gated push at all. Executes no batch code.
//   1. gate files on the main repo's master must be byte-identical to what was deployed here (gate.json pins);
//      the gate code is then loaded from those exact bytes.
//   2. the gate must say "es-wait" for this batch evaluated without cloud-test results (fine-grained tokens cannot read
//      check runs, so a batch that needs cloud tests is held and goes to the maintainer instead).
//   3. push mode only: the main repo landing bot (github-actions[bot]) must also have marked this head as es-wait.
// Outputs: series (patch-series fingerprint), master (main-repo commit evaluated against), es_min / job_min (time limits of
//   the epoch-sync test step and of the test job, from input es_min clamped by vlib.esLimits - O612).
// Env: MAIN_REPO MAIN_READ BATCH PR HEAD_SHA MODE MASTER_IN ES_BASE_IN LEGACY_IN ES_MIN_IN RUNNER_TEMP
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const V = require('./vlib.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(process.env.RUNNER_TEMP || '/tmp', 'out');
const DETAIL = path.join(OUT, 'fetch-detail.jsonl');

V.finish(() => {
  const token = V.need('MAIN_READ', /^github_pat_\w+$/);
  const batch = V.need('BATCH', /^B\d{3,4}$/);
  const pr = V.need('PR', /^\d+$/);
  const head = V.need('HEAD_SHA', /^[0-9a-f]{40}$/);
  const mode = V.need('MODE', /^(dry|push)$/);
  const masterIn = String(process.env.MASTER_IN || '').trim();
  if (masterIn && !/^[0-9a-f]{40}$/.test(masterIn)) throw new V.Hold('bad-master-input');
  if (masterIn && mode === 'push') throw new V.Hold('rehearsal-master-only-in-dry-mode');
  const esBaseIn = String(process.env.ES_BASE_IN || '').trim();
  if (esBaseIn && (!/^[0-9a-f]{40}$/.test(esBaseIn) || mode === 'push' || !masterIn)) throw new V.Hold('rehearsal-es-base-only-with-master-in-dry-mode');
  // rehearsal of an already-landed batch only: pr 0 = the batch never had a PR; legacy=notes = read its old free-text
  //   declaredLocal lines as notes (they predate the declared kinds). Both need a pinned master, i.e. dry mode.
  const legacyNotes = String(process.env.LEGACY_IN || '') === 'notes';
  if ((pr === '0' || legacyNotes) && !masterIn) throw new V.Hold('rehearsal-flags-only-with-master-in-dry-mode');
  fs.mkdirSync(OUT, { recursive: true });

  const dir = path.join(process.env.RUNNER_TEMP || '/tmp', 'main');
  V.mainClone(dir, token, [
    '+refs/heads/master:refs/remotes/origin/master',
    '+refs/heads/' + V.AUDIT_REF + ':refs/remotes/origin/' + V.AUDIT_REF,
    '+refs/heads/' + V.BACKLOG_REF + ':refs/remotes/origin/' + V.BACKLOG_REF,
    head,
  ].concat(pr !== '0' ? ['+refs/pull/' + pr + '/head:refs/remotes/pr/head'] : [], masterIn ? [masterIn] : []));
  if (mode === 'push' && V.git(dir, ['rev-parse', 'pr/head']).out !== head) throw new V.Hold('pr-head-moved');
  const master = masterIn || V.git(dir, ['rev-parse', 'origin/master']).out;

  // 1. gate pins: current master gate files must match the deployed fingerprints
  const gate = JSON.parse(fs.readFileSync(path.join(ROOT, 'gate.json'), 'utf8'));
  const gdir = path.join(process.env.RUNNER_TEMP || '/tmp', 'gate');
  for (const [file, want] of Object.entries(gate.pins || {})) {
    const r = V.git(dir, ['show', 'origin/master:' + file], { token, buffer: true, ok: false });
    if (r.status !== 0) throw new V.Hold('gate-file-missing', file);
    const got = crypto.createHash('sha256').update(r.stdout).digest('hex');
    if (got !== want) throw new V.Hold('gate-drift', file + ' on master changed since the last deploy (redeploy from the maintainer machine)');
    fs.mkdirSync(path.join(gdir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(gdir, file), r.stdout);
  }
  const LV = require(path.join(gdir, 'infra', 'workbench', 'land-verify.js'));
  const rules = JSON.parse(fs.readFileSync(path.join(gdir, 'infra', 'workbench', 'land-rules.json'), 'utf8'));

  // 2. gate verdict without cloud-test results (lazy blob fetches need the token: pass it through the environment of git)
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'http.extraheader';
  process.env.GIT_CONFIG_VALUE_0 = V.basicAuth(token);
  let input, res;
  try {
    input = LV.collect({ repo: dir, head, master, audit: 'origin/' + V.AUDIT_REF, backlog: 'origin/' + V.BACKLOG_REF });
    if (legacyNotes && input.batch && Array.isArray(input.batch.declaredLocal)) {
      input.batch.declared = (input.batch.declared || []).concat(input.batch.declaredLocal.map((t) => ({ kind: 'note', text: String(t) })));
      delete input.batch.declaredLocal;
    }
    res = LV.evaluate(input, rules);
  } finally { delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0; }
  // testedShas: the batch head plus the commits that only differ from it in the batch-notes directory (the final review is
  //   committed after the cloud tests, so its head= is usually one of these) - the reviewer needs them to check the final review
  fs.writeFileSync(path.join(OUT, 'gate-result.json'), JSON.stringify({ batch, head, master, testedShas: input.testedShas || [], res }, null, 2));
  if (!input.batch || input.batch.batch !== batch) throw new V.Hold('batch-id-mismatch');
  if (res.verdict !== 'es-wait') throw new V.Hold('gate-' + res.verdict, (res.reasons || []).concat(res.local || []).join('\n'));

  // 3. push mode: the landing bot must agree (its marker comment on the PR, written by github-actions[bot])
  if (mode === 'push') {
    const r = V.run('curl', ['-fsS', '-H', 'Authorization: Bearer ' + token, '-H', 'Accept: application/vnd.github+json',
      'https://api.github.com/repos/' + V.mainRepo() + '/issues/' + pr + '/comments?per_page=100']);
    if (r.status !== 0) throw new V.Hold('pr-comments-unreadable');
    const ok = JSON.parse(r.stdout).some((c) => c.user && c.user.login === 'github-actions[bot]' &&
      new RegExp('<!--\\s*gmt-land head=' + head + ' master=[0-9a-f]{40} armed=[01] state=es-wait\\s*-->').test(c.body || ''));
    if (!ok) throw new V.Hold('bot-not-es-wait');
  }
  // O612: the verifier box's estimate for the epoch-sync step (from the last measured per-file times); missing or out of
  //   range = clamped, never a hold (a missing estimate just means the old fixed 60 minutes)
  const lim = V.esLimits(process.env.ES_MIN_IN);
  console.log('gate: es-wait · series ' + res.seriesHash.slice(0, 12) + ' · master ' + master.slice(0, 8) + ' · epoch-sync step limit ' + lim.esMin + ' min, test job ' + lim.jobMin + ' min');
  V.setOutput({ series: res.seriesHash, master, hold: '', es_min: lim.esMin, job_min: lim.jobMin });
}, DETAIL);
