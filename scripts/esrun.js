'use strict';
// esrun.js - runs as the unprivileged test user: epoch-sync test/*.js four times (three pinned clocks in UTC + the
// unpinned clock in the maintainer's timezone; the same passes the maintainer's land-batch runs).
//   node esrun.js <epoch-sync dir> <result.json>     exit 0 = all green
const fs = require('fs');
const ES = require('./es-common.js');

const [esDir, out] = process.argv.slice(2);
// One line per file before and after it runs: run-tests.js kills this whole step after 60 minutes, and then the sealed
// log is all there is - the last "start" without a "done" is the file that was running (W114).
const r = ES.runEsTests(esDir, { localTz: 'Asia/Shanghai', timeoutMs: 600000,
  onStart: (name) => console.log('start ' + name),
  onDone: (name, code, ms) => console.log('done ' + name + ' exit=' + code + ' ' + Math.round(ms / 1000) + 's') });
fs.writeFileSync(out, JSON.stringify(r, null, 2));
console.log('epoch-sync tests: ' + (r.total - r.bad.length) + ' / ' + r.total + ' green');
process.exit(r.bad.length ? 1 : 0);
