'use strict';
// esrun.js - runs as the unprivileged test user: epoch-sync test/*.js four times (three pinned clocks in UTC + the
// unpinned clock in the maintainer's timezone; the same passes the maintainer's land-batch runs).
//   node esrun.js <epoch-sync dir> <result.json>     exit 0 = all green
//   ES_JOBS = files at a time (default 2, at most 4; O612 - one after another the four passes outgrew the step limit);
//   the same file never runs under two passes at once (es-common.js runEsTestsPar)
const fs = require('fs');
const ES = require('./es-common.js');

const [esDir, out] = process.argv.slice(2);
const jobs = Math.max(1, Math.min(4, parseInt(process.env.ES_JOBS, 10) || 2));
console.log('lanes ' + jobs);
// One line per file before and after it runs: run-tests.js kills this whole step when it runs past its limit, and then the
// sealed log is all there is - a "start" without a "done" is a file that was running (W114). The "done" lines also carry
// each file's time; the verifier box sums the last ones to set the next run's step limit (O612).
ES.runEsTestsPar(esDir, { localTz: 'Asia/Shanghai', timeoutMs: 600000, jobs,
  onStart: (name) => console.log('start ' + name),
  onDone: (name, code, ms) => console.log('done ' + name + ' exit=' + code + ' ' + Math.round(ms / 1000) + 's') }).then((r) => {
  fs.writeFileSync(out, JSON.stringify(r, null, 2));
  console.log('epoch-sync tests: ' + (r.total - r.bad.length) + ' / ' + r.total + ' green');
  process.exit(r.bad.length ? 1 : 0);
});
