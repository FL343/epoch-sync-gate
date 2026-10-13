'use strict';
// seal-out.js <job> - seal RUNNER_TEMP/out into RUNNER_TEMP/<job>.sealed with the public log key from gate.json.
// Logs may contain private main-repo text, and artifacts of a public repo are downloadable by anyone.
const fs = require('fs');
const path = require('path');
const S = require('../lib/seal.js');

const job = process.argv[2];
if (!/^[a-z]+$/.test(job || '')) { console.error('usage: seal-out.js <job>'); process.exit(2); }
const tmp = process.env.RUNNER_TEMP || '/tmp';
const out = path.join(tmp, 'out');
if (!fs.existsSync(out) || !fs.readdirSync(out).length) { console.log('nothing to seal'); process.exit(0); }
const gate = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gate.json'), 'utf8'));
fs.writeFileSync(path.join(tmp, job + '.sealed'), S.sealBuffer(S.tarDir(out), gate.logKey));
console.log('sealed ' + job + ' (' + fs.readdirSync(out).length + ' file(s))');
