'use strict';
// vlib.js - small helpers shared by the verify jobs. Nothing here prints secrets or private text:
// public run logs only ever get short codes and counts; details go into sealed artifacts.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// The private main repo's name is itself on the public-data word list, so it is a secret (MAIN_REPO = owner/name), never in this repo.
function mainRepo() {
  const r = String(process.env.MAIN_REPO || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('bad input MAIN_REPO');
  return r;
}
const ES_REPO = 'https://github.com/FL343/epoch-sync';
const AUDIT_REF = 'claude/sweet-dijkstra-myyf2t';
const BACKLOG_REF = 'claude/cloud-workbench';

function basicAuth(token) {
  return 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64');
}
function run(cmd, args, opt) {
  const r = cp.spawnSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 512 << 20 }, opt || {}));
  if (r.error) throw r.error;
  return r;
}
// git with an optional one-shot auth header (passed with -c, never written to config; child git processes inherit it
// through GIT_CONFIG_PARAMETERS for partial-clone lazy fetches)
function git(dir, args, opt) {
  const o = opt || {};
  const pre = ['-C', dir, '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'advice.detachedHead=false'];
  if (o.token) pre.push('-c', 'http.extraheader=' + basicAuth(o.token));
  const r = run('git', pre.concat(args), { input: o.input, encoding: o.buffer ? null : 'utf8' });
  if (o.ok !== false && r.status !== 0) throw new Error('git ' + args[0] + ' failed (exit ' + r.status + ')' + (o.quiet ? '' : ': ' + String(r.stderr || '').trim().slice(0, 300)));
  return o.buffer ? r : Object.assign(r, { out: String(r.stdout || '').trim() });
}
function need(name, re) {
  const v = String(process.env[name] || '').trim();
  if (!re.test(v)) throw new Error('bad input ' + name);
  return v;
}
function setOutput(kv) {
  const f = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(kv).map(([k, v]) => k + '=' + String(v).replace(/[\r\n]/g, ' '));
  if (f) fs.appendFileSync(f, lines.join('\n') + '\n');
  for (const l of lines) console.log('output ' + l);
}
// Stop with a short public code; the long reason goes to the sealed detail file.
class Hold extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail || ''; } }
function finish(main, detailFile) {
  try { main(); }
  catch (e) {
    const code = e instanceof Hold ? e.code : 'error';
    if (detailFile) { fs.mkdirSync(path.dirname(detailFile), { recursive: true }); fs.appendFileSync(detailFile, JSON.stringify({ code, detail: e instanceof Hold ? e.detail : String(e.stack || e) }) + '\n'); }
    setOutput({ hold: code });
    console.log('HOLD ' + code);
    process.exit(1);
  }
}
// Fetch only what is needed from the private main repo (partial clone: file contents arrive on demand, with the same token).
function mainClone(dir, token, refs) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'origin', 'https://github.com/' + mainRepo()]);
  git(dir, ['config', 'remote.origin.promisor', 'true']);
  git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  git(dir, ['fetch', '-q', '--no-tags', '--filter=blob:none', 'origin'].concat(refs), { token, quiet: true });
}
// The batch description added by the batch: archive/MERGE_BATCHES/<batch>.json at the tested commit
function readBatch(dir, head, batch, token) {
  const r = git(dir, ['show', head + ':archive/MERGE_BATCHES/' + batch + '.json'], { token, ok: false });
  if (r.status !== 0) throw new Hold('no-batch-file');
  try { return JSON.parse(r.stdout); } catch (e) { throw new Hold('bad-batch-file'); }
}
function seriesEntries(dir, head, b, token) {
  const series = (b.epochSync && b.epochSync.series) || [];
  if (!series.length) throw new Hold('no-series');
  return series.map((p) => {
    if (!/^archive\/MERGE_BATCHES\/B\d+\/epoch-sync\/[A-Za-z0-9._-]+\.patch$/.test(p)) throw new Hold('bad-series-path');
    const r = git(dir, ['show', head + ':' + p], { token, buffer: true, ok: false });
    if (r.status !== 0) throw new Hold('series-missing');
    return { path: p, content: r.stdout };
  });
}

// O612: time limits of the epoch-sync test step and of the whole test job (GitHub expressions cannot add, so the fetch job
//   outputs both). The verifier box estimates the step from the last measured per-file times (sum / lanes x 1.3 + 10 minutes)
//   and passes it in as input es_min; it is clamped here, by fetch.js and again by run-tests.js (a bad or missing value = the
//   floor, i.e. the old fixed 60 minutes). The job limit keeps the old 60 minutes for the other steps on top of the step limit
//   and never goes below the old 120; ceil + rest = 360 = the most a GitHub-hosted job may run.
const ES_LIMIT = { floor: 60, ceil: 300, rest: 60, jobFloor: 120, jobMax: 360, lanes: 2 };
function esLimits(raw) {
  const t = String(raw === undefined || raw === null ? '' : raw).trim();
  const esMin = /^\d{1,4}$/.test(t) ? Math.min(ES_LIMIT.ceil, Math.max(ES_LIMIT.floor, +t)) : ES_LIMIT.floor;
  const jobMin = Math.min(ES_LIMIT.jobMax, Math.max(ES_LIMIT.jobFloor, esMin + ES_LIMIT.rest));
  return { esMin, jobMin };
}

module.exports = { mainRepo, ES_REPO, AUDIT_REF, BACKLOG_REF, basicAuth, run, git, need, setOutput, Hold, finish, mainClone, readBatch, seriesEntries, ES_LIMIT, esLimits };
