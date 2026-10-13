'use strict';
// esrun.js - runs as the unprivileged test user: epoch-sync test/*.js four times (three pinned clocks in UTC + the
// unpinned clock in the maintainer's timezone; the same passes the maintainer's land-batch runs).
//   node esrun.js <epoch-sync dir> <result.json>     exit 0 = all green
const fs = require('fs');
const ES = require('./es-common.js');

const [esDir, out] = process.argv.slice(2);
const r = ES.runEsTests(esDir, { localTz: 'Asia/Shanghai', timeoutMs: 600000 });
fs.writeFileSync(out, JSON.stringify(r, null, 2));
console.log('epoch-sync tests: ' + (r.total - r.bad.length) + ' / ' + r.total + ' green');
process.exit(r.bad.length ? 1 : 0);
