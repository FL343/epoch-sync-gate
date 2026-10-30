'use strict';
// run-tests.js - job "test", untrusted part. Every command that executes batch code runs as the unprivileged
// "vtest" user with a scrubbed environment; this wrapper (runner user) only records exit codes, so a test cannot
// rewrite its own verdict. Public log: counts only. Full logs: RUNNER_TEMP/out (sealed afterwards).
//   1. epoch-sync test/*.js x4 clocks (esrun.js)
//   2. node --check validate.js / trueskill.js (what the private pre-push hook ran)
//   3. main repo test:all on the merged tree, with the patched epoch-sync as CRON_DIR (both halves together)
// Outputs: result=pass|fail
// A step that runs past its time limit is killed and recorded as code "timeout" (res.timeout = { step, min, log }), its partial
//   log is kept, the steps after it are skipped and the result is fail (any timed-out step, the ledger replay included), so
//   test-result.json is written and the verifier takes the "tests failed" path (W114: before, the spawnSync ETIMEDOUT error
//   crashed this script, no result file was written, and the verifier box took the failed job for a machine problem and
//   re-ran the same hung tests twice). Note the step limits add up to more than the job limit: a step can still be cut by
//   the job limit itself (then it is the old "test job failed" path, no worse than before).
// A step killed by a signal that is not our timeout (out of memory and the like) is recorded as code "signal:<NAME>".
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const V = require('./vlib.js');

const W = '/opt/vwork';
const OUT = path.join(process.env.RUNNER_TEMP || '/tmp', 'out');
fs.mkdirSync(OUT, { recursive: true });
const NODE_BIN = path.dirname(process.execPath);

let timedOut = null;   // first step that ran past its limit: { step, min }
function asTester(cwd, cmd, args, extraEnv, logName, timeoutMin, step) {
  if (timedOut) return { code: 'skipped', sec: 0, stdout: '' };
  const env = ['HOME=/home/vtest', 'PATH=' + NODE_BIN + ':/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'CI=1'].concat(Object.entries(extraEnv || {}).map(([k, v]) => k + '=' + v));
  const t0 = Date.now(), min = timeoutMin || 30;
  // spawnSync directly (not V.run): on a timeout it still returns the output collected so far, V.run would throw it away
  const r = cp.spawnSync('sudo', ['-u', 'vtest', '-H', 'env', '-i'].concat(env, [cmd], args), { cwd, encoding: 'utf8', maxBuffer: 512 << 20, timeout: min * 60000 });
  const late = !!(r.error && r.error.code === 'ETIMEDOUT');
  if (r.error && !late) throw r.error;
  fs.writeFileSync(path.join(OUT, logName), String(r.stdout || '') + '\n--- stderr ---\n' + String(r.stderr || '') + (late ? '\n--- killed: ran past the ' + min + ' minute limit ---\n' : ''));
  if (late) { timedOut = { step: step || logName, min, log: logName }; console.log('timeout: ' + timedOut.step + ' killed after ' + min + ' min, later steps skipped'); }
  return { code: late ? 'timeout' : r.status === null ? 'signal:' + (r.signal || '?') : r.status, sec: Math.round((Date.now() - t0) / 1000), stdout: String(r.stdout || '') };
}
const lastLine = (s, re) => { const l = String(s).split('\n').filter((x) => re.test(x)); return l.length ? l[l.length - 1].trim() : ''; };

const res = {};
// 1. epoch-sync tests
const es = asTester(W, 'node', [path.join(W, 'vt', 'esrun.js'), path.join(W, 'es'), path.join(W, 'logs', 'es.json')], {}, 'es-tests.log', 60, 'es');
res.es = { code: es.code, sec: es.sec, line: lastLine(es.stdout, /^epoch-sync tests: \d+ \/ \d+ green$/) };
try { fs.copyFileSync(path.join(W, 'logs', 'es.json'), path.join(OUT, 'es.json')); } catch (e) { /* missing = failed early */ }
// 2. syntax checks the private hook ran
res.check = ['validate.js', 'trueskill.js'].map((f) => ({ file: f, code: asTester(path.join(W, 'es'), 'node', ['--check', f], {}, 'check-' + f + '.log', 2, 'check').code }));
// 3. main repo test:all, both halves together
const mvp = path.join(W, 'main', 'mvp');
const ci = asTester(mvp, 'npm', ['ci', '--no-audit', '--no-fund'], { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }, 'npm-ci.log', 20, 'npmci');
const pits = ci.code === 0 ? asTester(mvp, 'node', ['native/eac-guard/build-pits.js'], {}, 'pits.log', 20, 'pits') : { code: 'skipped' };
const ta = (ci.code === 0 && pits.code === 0) ? asTester(mvp, 'npm', ['run', 'test:all'], { GMT_SKIP_ASSET_CHECKS: '1', CRON_DIR: path.join(W, 'es'), GMT_EPOCH_SYNC: path.join(W, 'es') }, 'test-all.log', 45, 'testall') : { code: 'skipped', stdout: '' };
res.npmci = ci.code; res.pits = pits.code;
res.testall = { code: ta.code, sec: ta.sec, line: lastLine(ta.stdout, /^\[test:all\] \d+\/\d+ /).replace(/[^\x20-\x7e]+/g, ' ').trim() };
// 4. ledger replay of recent cloud-test games, epoch-sync before / after the series (reported separately from pass/fail:
//    a settlement change is not a test failure but the gate holds it for the maintainer)
const rp = asTester(W, 'node', [path.join(W, 'vt', 'replay-cmp.js'), path.join(W, 'replay'), path.join(W, 'es-a'), path.join(W, 'es'), path.join(W, 'logs', 'replay.json')], {}, 'replay.log', 40, 'replay');
let rj = null;
try { rj = JSON.parse(fs.readFileSync(path.join(W, 'logs', 'replay.json'), 'utf8')); fs.copyFileSync(path.join(W, 'logs', 'replay.json'), path.join(OUT, 'replay.json')); } catch (e) { rj = null; }
res.replay = rj ? { code: rp.code, runs: rj.runs, same: rj.same, changes: rj.changes.length, notes: rj.notes.length, noResult: rj.noResult.length } : { code: rp.code, missing: true };

// a timed-out step is a fail even when it does not count otherwise (the ledger replay: a settlement change is held for the
// maintainer, but a replay that hung must not send the batch to wait for approval with no replay result)
const pass = res.es.code === 0 && res.check.every((c) => c.code === 0) && ci.code === 0 && pits.code === 0 && ta.code === 0 && !timedOut;
res.pass = pass;
if (timedOut) res.timeout = timedOut;
fs.writeFileSync(path.join(OUT, 'test-result.json'), JSON.stringify(res, null, 2));
console.log('epoch-sync tests: ' + (res.es.line || 'exit ' + res.es.code));
console.log('syntax checks: ' + res.check.map((c) => c.file + '=' + c.code).join(' '));
console.log('npm ci=' + ci.code + ' pits=' + pits.code + ' test:all: ' + (res.testall.line || 'exit ' + ta.code));
console.log('ledger replay: ' + (res.replay.missing ? 'no result (exit ' + res.replay.code + ')' : res.replay.runs + ' game(s), ' + res.replay.same + ' same, ' + res.replay.changes + ' changed, ' + res.replay.notes + ' with new watch lines'));
console.log('result: ' + (pass ? 'pass' : 'fail'));
V.setOutput({ result: pass ? 'pass' : 'fail' });
