'use strict';
// replay-cmp.js - runs as the unprivileged test user. Replays every recent cloud-test game (its ledger records) through
// epoch-sync twice - before (A = main at the tested base) and after the series (B) - and compares what settles:
// which match keys get processed and every account's resulting numbers, plus "watch" log lines that only B prints.
//   node replay-cmp.js <replay dir: tool/ in/<run>/> <esA> <esB> <out.json>
// A settlement difference is a "change" (the gate holds it for the maintainer: honest games must keep settling the same);
// only-new watch lines are "notes" for the reviewer.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const [dir, esA, esB, outFile] = process.argv.slice(2);
const TOOL = path.join(dir, 'tool', 'cron-replay.js');
const WATCH = /not counted|start-split|roster contest|hold|held|wrote seat|suspect|inconsistent [1-9]|disagree/i;

function replay(cron, run, tag) {
  const out = path.join(dir, 'out', tag, run);
  const preset = run.split('-').slice(2).join('-');
  cp.spawnSync(process.execPath, [TOOL, '--cron=' + cron, '--in=' + path.join(dir, 'in', run), '--out=' + out, '--preset=' + preset], { encoding: 'utf8', timeout: 600000 });
  try { return JSON.parse(fs.readFileSync(path.join(out, 'replay-result.json'), 'utf8')); } catch (e) { return null; }
}
const norm = (j) => j && JSON.stringify({ v: j.verdict, keys: (j.keys || []).map((k) => k.key + ':' + k.processed).sort(), acc: (j.accounts || []).map((a) => JSON.stringify(a)).sort(), problems: j.problems });
// Durations are blanked too (2026-10-13, B020 rehearsal): the replay clock is "tick time + real time spent inside the cron
// process", and the absent-seat grace is exactly one tick long, so whether a tick prints "grace 0s left, deferred" or has
// already settled depends on milliseconds of run time, not on the series (the same game showed the line in A on one run and
// in B on another; what settles is compared by norm() above and stayed the same).
const watchNorm = (l) => l.replace(/\d{6,}_\d+_\d+/g, 'KEY').replace(/\b\d+(?:\.\d+)?(ms|s|min|h)\b/g, 'N$1');
const watchLines = (j) => { const s = new Set(); if (j) for (const t of j.ticks || []) for (const l of t.lines || []) if (WATCH.test(l)) s.add(watchNorm(l)); return [...s]; };

const res = { runs: 0, same: 0, changes: [], notes: [], noResult: [] };
for (const run of fs.readdirSync(path.join(dir, 'in')).sort()) {
  res.runs++;
  const a = replay(esA, run, 'A'), b = replay(esB, run, 'B');
  if (!a && !b) { res.noResult.push(run); continue; }
  const wa = watchLines(a), newW = watchLines(b).filter((l) => !wa.includes(l));
  if (norm(a) !== norm(b)) {
    const d = { run, a: a ? a.verdict + ' ' + a.reason : 'no result', b: b ? b.verdict + ' ' + b.reason : 'no result' };
    if (a && b) {
      const ka = (a.keys || []).map((k) => k.key + ':' + k.processed), kb = (b.keys || []).map((k) => k.key + ':' + k.processed);
      if (ka.join() !== kb.join()) d.keys = [ka, kb];
      const am = new Map((a.accounts || []).map((x) => [x.sid, JSON.stringify(x)])), bm = new Map((b.accounts || []).map((x) => [x.sid, JSON.stringify(x)]));
      d.accounts = [...new Set([...am.keys(), ...bm.keys()])].filter((k) => am.get(k) !== bm.get(k)).map((k) => [am.get(k) || '-', bm.get(k) || '-']);
    }
    res.changes.push(d);
  } else res.same++;
  if (newW.length) res.notes.push({ run, lines: newW.slice(0, 10) });
}
fs.writeFileSync(outFile, JSON.stringify(res, null, 2));
console.log('replay: ' + res.runs + ' run(s), ' + res.same + ' same, ' + res.changes.length + ' changed, ' + res.notes.length + ' with new watch lines, ' + res.noResult.length + ' without result');
