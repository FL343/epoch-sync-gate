'use strict';
// es-apply.js - jobs "shadow" (dry mode) and "push" (after approval). Executes no batch code: only git am / rebase
// and text checks. Same order as the maintainer's land-batch:
//   series fingerprint == the one tested -> epoch-sync clone -> git am -3 -> author = public identity + drop the two
//   AI trailer lines -> commit message checks -> public-data checks over the whole tree (private word list)
//   dry : push the result to this repo as shadow/<batch> (the "would-be merge" kept for comparison)
//   push: epoch-sync runs must be green -> only bot state commits may have arrived since the tested base ->
//         push main (rebase over new state commits, at most 3 times) -> sign the "es landed" mark -> artifact mark.txt
// Env: MODE MAIN_REPO MAIN_READ BATCH HEAD_SHA SERIES ES_BASE WORDLIST ES_NAME ES_EMAIL GITHUB_TOKEN GITHUB_REPOSITORY
//      push only: ES_PUSH MARK_KEY
const fs = require('fs');
const path = require('path');
const V = require('./vlib.js');
const ES = require('../lib/es-common.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(process.env.RUNNER_TEMP || '/tmp', 'out');

V.finish(() => {
  const mode = V.need('MODE', /^(dry|push)$/);
  const token = V.need('MAIN_READ', /^github_pat_\w+$/);
  const batch = V.need('BATCH', /^B\d{3,4}$/);
  const head = V.need('HEAD_SHA', /^[0-9a-f]{40}$/);
  const series = V.need('SERIES', /^[0-9a-f]{64}$/);
  const esBase = V.need('ES_BASE', /^[0-9a-f]{40}$/);
  const name = V.need('ES_NAME', /^.{2,80}$/), email = V.need('ES_EMAIL', /^\S+@\S+$/);
  const wordSrc = String(process.env.WORDLIST || '');
  if (wordSrc.length < 8) throw new V.Hold('no-word-list');
  const wordRe = new RegExp(wordSrc, 'i');
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = process.env.RUNNER_TEMP || '/tmp';

  // series from the private repo, fingerprint must be the tested one
  const main = path.join(tmp, 'main-apply');
  V.mainClone(main, token, [head]);
  const entries = V.seriesEntries(main, head, V.readBatch(main, head, batch, token), token);
  if (ES.seriesHash(entries) !== series) throw new V.Hold('series-fingerprint-mismatch');
  const files = entries.map((e, i) => { const f = path.join(tmp, 'p' + String(i).padStart(4, '0') + '.patch'); fs.writeFileSync(f, Buffer.concat([e.content, Buffer.from('\n')])); return f; });

  // epoch-sync clone; dry mode replays exactly the tested base, push mode starts from today's main
  const es = path.join(tmp, 'es-apply');
  V.run('git', ['clone', '-q', V.ES_REPO, es]);
  V.git(es, ['config', 'user.name', name]);
  V.git(es, ['config', 'user.email', email]);
  V.git(es, ['cat-file', '-e', esBase + '^{commit}']);
  if (mode === 'dry') V.git(es, ['checkout', '-q', '-B', 'work', esBase]);
  else {
    const why = ES.esForeignSince(V.git(es, ['log', '--format=%H%x01%an%x01%s%x02', '--name-only', esBase + '..origin/main']).out);
    if (why) throw new V.Hold('es-moved-foreign', why);
    V.git(es, ['checkout', '-q', '-B', 'work', 'origin/main']);
  }
  const before = V.git(es, ['rev-parse', 'HEAD']).out;
  const am = V.git(es, ['am', '-3', '-q'].concat(files), { ok: false });
  if (am.status !== 0) { V.git(es, ['am', '--abort'], { ok: false }); throw new V.Hold('series-does-not-apply'); }
  const strip = V.git(es, ['rebase', '-q', '--exec', 'node ' + JSON.stringify(path.join(ROOT, 'lib', 'es-common.js')) + ' --amend-strip', before], { ok: false });
  if (strip.status !== 0) { V.git(es, ['rebase', '--abort'], { ok: false }); throw new V.Hold('re-author-failed'); }
  const stripped = (String(strip.stdout).match(/stripped (\d+) AI trailer/g) || []).reduce((a, s) => a + (+s.match(/\d+/)[0]), 0);
  const msg = ES.esMessageProblems(V.git(es, ['log', '--format=%H%x01%an%x01%B%x02', before + '..HEAD']).out);
  if (msg.length) throw new V.Hold('commit-message-not-public', msg.join('\n'));
  const tracked = V.git(es, ['ls-files', '-z']).out.split('\0').filter(Boolean);
  const data = ES.publicDataProblems(tracked.map((p) => ({ path: p, text: fs.readFileSync(path.join(es, p), 'utf8') })), wordRe);
  if (data.length) throw new V.Hold('public-data-check', data.length + ' finding(s)');   // never print the lines: they would publish the word list hits
  const pid = V.run('git', ['-C', es, 'patch-id', '--stable'], { input: V.git(es, ['log', '-p', '--reverse', before + '..HEAD']).out });
  const patchIds = String(pid.stdout || '').split('\n').map((l) => l.split(' ')[0]).filter(Boolean);
  const nCommits = +V.git(es, ['rev-list', '--count', before + '..HEAD']).out;

  if (mode === 'dry') {
    const auth = V.basicAuth(V.need('GITHUB_TOKEN', /^\S{20,}$/));
    const repo = V.need('GITHUB_REPOSITORY', /^[\w.-]+\/[\w.-]+$/);
    V.git(es, ['-c', 'http.extraheader=' + auth, 'push', '-q', '-f', 'https://github.com/' + repo + '.git', 'HEAD:refs/heads/shadow/' + batch]);
    const shadow = V.git(es, ['rev-parse', 'HEAD']).out;
    fs.writeFileSync(path.join(OUT, 'shadow.json'), JSON.stringify({ batch, head, series, esBase, shadow, commits: nCommits, patchIds, stripped }, null, 2));
    console.log('shadow/' + batch + ' = ' + shadow.slice(0, 12) + ' (' + nCommits + ' commit(s) on ' + esBase.slice(0, 8) + ', ' + stripped + ' trailer line(s) dropped)');
    V.setOutput({ shadow, hold: '' });
    return;
  }

  // push mode: epoch-sync's own workflows must be green right now (latest completed run of each, last 2 days)
  const runs = V.run('curl', ['-fsS', '-H', 'Authorization: Bearer ' + V.need('GITHUB_TOKEN', /^\S{20,}$/), '-H', 'Accept: application/vnd.github+json',
    'https://api.github.com/repos/FL343/epoch-sync/actions/runs?branch=main&status=completed&per_page=100']);
  if (runs.status !== 0) throw new V.Hold('es-runs-unreadable');
  const latest = {};
  for (const r of JSON.parse(runs.stdout).workflow_runs || []) if (!latest[r.workflow_id]) latest[r.workflow_id] = r;
  const since = Date.now() - 2 * 86400000;
  const red = Object.values(latest).filter((r) => Date.parse(r.updated_at) > since && !['success', 'skipped', 'cancelled'].includes(r.conclusion));
  if (red.length) throw new V.Hold('es-runs-red', red.map((r) => r.name + ' ' + r.conclusion + ' ' + r.html_url).join('\n'));

  const push = V.need('ES_PUSH', /^github_pat_\w+$/);
  const url = 'https://github.com/FL343/epoch-sync.git';
  let p = V.git(es, ['push', '-q', url, 'HEAD:refs/heads/main'], { token: push, ok: false });
  let base = esBase;
  for (let i = 0; i < 3 && p.status !== 0 && /fetch first|non-fast-forward|rejected/.test(String(p.stderr)); i++) {
    V.git(es, ['fetch', '-q', 'origin', 'main']);
    const why = ES.esForeignSince(V.git(es, ['log', '--format=%H%x01%an%x01%s%x02', '--name-only', base + '..origin/main']).out);
    if (why) throw new V.Hold('es-moved-foreign', why);
    const rb = V.git(es, ['rebase', '-q', 'origin/main'], { ok: false });
    if (rb.status !== 0) { V.git(es, ['rebase', '--abort'], { ok: false }); throw new V.Hold('rebase-conflict'); }
    base = V.git(es, ['rev-parse', 'origin/main']).out;
    p = V.git(es, ['push', '-q', url, 'HEAD:refs/heads/main'], { token: push, ok: false });
  }
  if (p.status !== 0) throw new V.Hold('push-failed', String(p.stderr || '').replace(/x-access-token:[^@\s]+/g, '***').slice(0, 400));
  const esHead = V.git(es, ['rev-parse', 'HEAD']).out;
  const m = { batch, head, series, es: esHead };
  const comment = ES.markComment(m, ES.signMark(m, V.need('MARK_KEY', /BEGIN PRIVATE KEY/)));
  fs.writeFileSync(path.join(OUT, 'mark.txt'), comment + '\n');
  fs.writeFileSync(path.join(OUT, 'pushed.json'), JSON.stringify({ batch, head, series, es: esHead, commits: nCommits, patchIds, stripped }, null, 2));
  console.log('pushed epoch-sync ' + esHead.slice(0, 12) + ' (' + nCommits + ' commit(s), ' + stripped + ' trailer line(s) dropped)');
  console.log(comment);
  V.setOutput({ es: esHead, hold: '' });
}, path.join(OUT, 'apply-detail.jsonl'));
