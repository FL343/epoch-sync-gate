'use strict';
// stage.js - job "test", trusted part: lay out everything the untrusted tests need, then hand it to a separate
// unprivileged user (no sudo, cannot read the runner's memory or this job's token).
//   /opt/vwork/main   main repo: master + the batch merged (merge-tree, no batch code runs here)
//   /opt/vwork/es     epoch-sync main with the patch series applied (git am; series fingerprint checked first)
//   /opt/vwork/vt     copy of lib/es-common.js + the es test driver
//   /home/vtest/epoch-sync -> /opt/vwork/es   (some main-repo tests read ~/epoch-sync)
// Outputs: es_base (epoch-sync commit the series was tested on)
// Env: MAIN_REPO MAIN_READ BATCH HEAD_SHA MASTER SERIES ES_BASE_IN RUNNER_TEMP
const fs = require('fs');
const path = require('path');
const V = require('./vlib.js');
const ES = require('../lib/es-common.js');

const ROOT = path.join(__dirname, '..');
const W = '/opt/vwork';
const OUT = path.join(process.env.RUNNER_TEMP || '/tmp', 'out');

V.finish(() => {
  const token = V.need('MAIN_READ', /^github_pat_\w+$/);
  const batch = V.need('BATCH', /^B\d{3,4}$/);
  const head = V.need('HEAD_SHA', /^[0-9a-f]{40}$/);
  const master = V.need('MASTER', /^[0-9a-f]{40}$/);
  const series = V.need('SERIES', /^[0-9a-f]{64}$/);
  fs.mkdirSync(OUT, { recursive: true });
  V.run('sudo', ['mkdir', '-p', W]);
  V.run('sudo', ['chown', process.env.USER || 'runner', W]);

  // main repo: merged tree, checked out (file contents fetched on demand with the token, then the token is gone)
  const main = path.join(W, 'main');
  V.mainClone(main, token, [master, head]);
  const tree = V.git(main, ['merge-tree', '--write-tree', master, head], { token, ok: false });
  if (tree.status !== 0) throw new V.Hold('merge-conflict');
  const mc = V.git(main, ['-c', 'user.name=verify', '-c', 'user.email=verify@invalid', 'commit-tree', tree.out.split('\n')[0], '-p', master, '-p', head, '-m', 'merged for verification']).out;
  V.git(main, ['checkout', '-q', '--detach', mc], { token });

  // series: same fingerprint as the gate saw
  const b = V.readBatch(main, head, batch, token);
  const entries = V.seriesEntries(main, head, b, token);
  if (ES.seriesHash(entries) !== series) throw new V.Hold('series-fingerprint-mismatch');
  const pdir = path.join(W, 'patches');
  fs.mkdirSync(pdir, { recursive: true });
  const files = entries.map((e, i) => { const f = path.join(pdir, String(i).padStart(4, '0') + '.patch'); fs.writeFileSync(f, Buffer.concat([e.content, Buffer.from('\n')])); return f; });

  // epoch-sync (public) + series
  const es = path.join(W, 'es');
  V.run('git', ['clone', '-q', V.ES_REPO, es]);
  // rehearsal of an already-landed batch (fetch allows this only in dry mode with a pinned master): epoch-sync as it was then
  const esBaseIn = String(process.env.ES_BASE_IN || '').trim();
  if (esBaseIn) { if (!/^[0-9a-f]{40}$/.test(esBaseIn)) throw new V.Hold('bad-es-base'); V.git(es, ['checkout', '-q', '-B', 'main', esBaseIn]); }
  const base = V.git(es, ['rev-parse', 'HEAD']).out;
  const am = V.git(es, ['-c', 'user.name=verify', '-c', 'user.email=verify@invalid', 'am', '-3', '-q'].concat(files), { ok: false });
  if (am.status !== 0) { V.git(es, ['am', '--abort'], { ok: false }); throw new V.Hold('series-does-not-apply'); }

  // ledger replay inputs (user decision 10-13: replaying every recent cloud-test game before / after the series replaces the
  //   maintainer's "run a real cron locally"): the replay tool from today's master (pinned like the gate) + epoch-sync without
  //   the series (A) + the ledger records of each cloud-test game of the last REPLAY_DAYS days (one dir per run)
  const rdir = path.join(W, 'replay');
  fs.mkdirSync(path.join(rdir, 'tool'), { recursive: true });
  fs.mkdirSync(path.join(rdir, 'in'), { recursive: true });
  V.git(main, ['fetch', '-q', '--no-tags', '--filter=blob:none', 'origin', '+refs/heads/master:refs/remotes/origin/master', '+refs/heads/ci-cloud/pr-*:refs/remotes/origin/ci-cloud/pr-*'], { token, quiet: true });
  const gate = JSON.parse(fs.readFileSync(path.join(ROOT, 'gate.json'), 'utf8'));
  for (const f of ['infra/cloud-test/replay/cron-replay.js', 'infra/cloud-test/replay/fake-steam.js']) {
    const r = V.git(main, ['show', 'origin/master:' + f], { token, buffer: true });
    if (require('crypto').createHash('sha256').update(r.stdout).digest('hex') !== (gate.pins || {})[f]) throw new V.Hold('gate-drift', f);
    fs.writeFileSync(path.join(rdir, 'tool', path.basename(f)), r.stdout);
  }
  const days = Math.max(1, Math.min(14, +(process.env.REPLAY_DAYS || 4)));
  const runs = [];
  for (const ref of V.git(main, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/ci-cloud/pr-*']).out.split('\n').filter(Boolean)) {
    const pr = ref.split('/').pop().replace(/^pr-/, '');   // dir name <pr>-<sha8>-<preset> (replay-cmp reads the preset after the 2nd dash)
    for (const l of V.git(main, ['log', '--since=' + days + '.days', '--format=%H %ct %s', ref]).out.split('\n').filter(Boolean)) {
      const [sha, ct] = l.split(' ');
      const preset = (/^\S+ \S+ cloud (\S+) /.exec(l) || [])[1];
      if (!preset || !/^[a-z0-9]+$/.test(preset)) continue;
      const blobs = V.git(main, ['ls-tree', sha]).out.split('\n').map((x) => /^\d+ blob ([0-9a-f]{40})\t(ledger-raw-[\w.-]+\.txt)$/.exec(x)).filter(Boolean);
      if (blobs.length) runs.push({ pr, sha, ct: +ct, preset, blobs: blobs.map((m) => ({ oid: m[1], name: m[2] })) });
    }
  }
  runs.sort((a, b) => b.ct - a.ct);
  const picked = runs.slice(0, 300);
  const oids = picked.reduce((a, r) => a.concat(r.blobs.map((b) => b.oid)), []);
  if (oids.length) V.git(main, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', '--stdin', 'origin'], { token, input: oids.join('\n') + '\n', quiet: true });
  for (const r of picked) {
    const d = path.join(rdir, 'in', r.pr + '-' + r.sha.slice(0, 8) + '-' + r.preset);
    fs.mkdirSync(d, { recursive: true });
    for (const b of r.blobs) fs.writeFileSync(path.join(d, b.name), V.git(main, ['cat-file', 'blob', b.oid], { token, buffer: true }).stdout);
  }
  const esA = path.join(W, 'es-a');
  V.run('git', ['clone', '-q', es, esA]);
  V.git(esA, ['checkout', '-q', '--detach', base]);

  // test driver + shared module for the unprivileged user
  const vt = path.join(W, 'vt');
  fs.mkdirSync(vt, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'lib', 'es-common.js'), path.join(vt, 'es-common.js'));
  fs.copyFileSync(path.join(__dirname, 'esrun.js'), path.join(vt, 'esrun.js'));
  fs.copyFileSync(path.join(__dirname, 'replay-cmp.js'), path.join(vt, 'replay-cmp.js'));
  fs.mkdirSync(path.join(W, 'logs'), { recursive: true });
  console.log('replay inputs: ' + picked.length + ' cloud-test game(s) from the last ' + days + ' day(s)');

  V.run('sudo', ['useradd', '-m', '-s', '/bin/bash', 'vtest']);
  V.run('sudo', ['chown', '-R', 'vtest:vtest', path.join(W, 'main'), es, esA, rdir, path.join(W, 'logs')]);
  V.run('sudo', ['chown', '-R', 'root:root', vt, pdir]);
  V.run('sudo', ['chmod', '-R', 'a+rX', vt]);
  V.run('sudo', ['-u', 'vtest', 'ln', '-s', es, '/home/vtest/epoch-sync']);
  console.log('staged: merged tree ' + mc.slice(0, 8) + ' · epoch-sync ' + base.slice(0, 8) + ' + ' + files.length + ' patch file(s)');
  V.setOutput({ es_base: base, hold: '' });
}, path.join(OUT, 'stage-detail.jsonl'));
