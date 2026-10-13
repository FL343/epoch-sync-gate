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

  // test driver + shared module for the unprivileged user
  const vt = path.join(W, 'vt');
  fs.mkdirSync(vt, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'lib', 'es-common.js'), path.join(vt, 'es-common.js'));
  fs.copyFileSync(path.join(__dirname, 'esrun.js'), path.join(vt, 'esrun.js'));
  fs.mkdirSync(path.join(W, 'logs'), { recursive: true });

  V.run('sudo', ['useradd', '-m', '-s', '/bin/bash', 'vtest']);
  V.run('sudo', ['chown', '-R', 'vtest:vtest', path.join(W, 'main'), es, path.join(W, 'logs')]);
  V.run('sudo', ['chown', '-R', 'root:root', vt, pdir]);
  V.run('sudo', ['chmod', '-R', 'a+rX', vt]);
  V.run('sudo', ['-u', 'vtest', 'ln', '-s', es, '/home/vtest/epoch-sync']);
  console.log('staged: merged tree ' + mc.slice(0, 8) + ' · epoch-sync ' + base.slice(0, 8) + ' + ' + files.length + ' patch file(s)');
  V.setOutput({ es_base: base, hold: '' });
}, path.join(OUT, 'stage-detail.jsonl'));
