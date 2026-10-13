'use strict';
// run-tests.js - job "test", untrusted part. Every command that executes batch code runs as the unprivileged
// "vtest" user with a scrubbed environment; this wrapper (runner user) only records exit codes, so a test cannot
// rewrite its own verdict. Public log: counts only. Full logs: RUNNER_TEMP/out (sealed afterwards).
//   1. epoch-sync test/*.js x4 clocks (esrun.js)
//   2. node --check validate.js / trueskill.js (what the private pre-push hook ran)
//   3. main repo test:all on the merged tree, with the patched epoch-sync as CRON_DIR (both halves together)
// Outputs: result=pass|fail
const fs = require('fs');
const path = require('path');
const V = require('./vlib.js');

const W = '/opt/vwork';
const OUT = path.join(process.env.RUNNER_TEMP || '/tmp', 'out');
fs.mkdirSync(OUT, { recursive: true });
const NODE_BIN = path.dirname(process.execPath);

function asTester(cwd, cmd, args, extraEnv, logName, timeoutMin) {
  const env = ['HOME=/home/vtest', 'PATH=' + NODE_BIN + ':/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'CI=1'].concat(Object.entries(extraEnv || {}).map(([k, v]) => k + '=' + v));
  const t0 = Date.now();
  const r = V.run('sudo', ['-u', 'vtest', '-H', 'env', '-i'].concat(env, [cmd], args), { cwd, timeout: (timeoutMin || 30) * 60000 });
  fs.writeFileSync(path.join(OUT, logName), String(r.stdout || '') + '\n--- stderr ---\n' + String(r.stderr || ''));
  return { code: r.status === null ? 'timeout' : r.status, sec: Math.round((Date.now() - t0) / 1000), stdout: String(r.stdout || '') };
}
const lastLine = (s, re) => { const l = String(s).split('\n').filter((x) => re.test(x)); return l.length ? l[l.length - 1].trim() : ''; };

const res = {};
// 1. epoch-sync tests
const es = asTester(W, 'node', [path.join(W, 'vt', 'esrun.js'), path.join(W, 'es'), path.join(W, 'logs', 'es.json')], {}, 'es-tests.log', 60);
res.es = { code: es.code, sec: es.sec, line: lastLine(es.stdout, /^epoch-sync tests: \d+ \/ \d+ green$/) };
try { fs.copyFileSync(path.join(W, 'logs', 'es.json'), path.join(OUT, 'es.json')); } catch (e) { /* missing = failed early */ }
// 2. syntax checks the private hook ran
res.check = ['validate.js', 'trueskill.js'].map((f) => ({ file: f, code: asTester(path.join(W, 'es'), 'node', ['--check', f], {}, 'check-' + f + '.log', 2).code }));
// 3. main repo test:all, both halves together
const mvp = path.join(W, 'main', 'mvp');
const ci = asTester(mvp, 'npm', ['ci', '--no-audit', '--no-fund'], { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }, 'npm-ci.log', 20);
const pits = ci.code === 0 ? asTester(mvp, 'node', ['native/eac-guard/build-pits.js'], {}, 'pits.log', 20) : { code: 'skipped' };
const ta = (ci.code === 0 && pits.code === 0) ? asTester(mvp, 'npm', ['run', 'test:all'], { GMT_SKIP_ASSET_CHECKS: '1', CRON_DIR: path.join(W, 'es'), GMT_EPOCH_SYNC: path.join(W, 'es') }, 'test-all.log', 45) : { code: 'skipped', stdout: '' };
res.npmci = ci.code; res.pits = pits.code;
res.testall = { code: ta.code, sec: ta.sec, line: lastLine(ta.stdout, /^\[test:all\] \d+\/\d+ /).replace(/[^\x20-\x7e]+/g, ' ').trim() };

const pass = res.es.code === 0 && res.check.every((c) => c.code === 0) && ci.code === 0 && pits.code === 0 && ta.code === 0;
res.pass = pass;
fs.writeFileSync(path.join(OUT, 'test-result.json'), JSON.stringify(res, null, 2));
console.log('epoch-sync tests: ' + (res.es.line || 'exit ' + res.es.code));
console.log('syntax checks: ' + res.check.map((c) => c.file + '=' + c.code).join(' '));
console.log('npm ci=' + ci.code + ' pits=' + pits.code + ' test:all: ' + (res.testall.line || 'exit ' + ta.code));
console.log('result: ' + (pass ? 'pass' : 'fail'));
V.setOutput({ result: pass ? 'pass' : 'fail' });
