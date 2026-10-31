'use strict';
// ============================================================
// es-common.js - shared checks for epoch-sync patch series (O424, plan mvp/KNIFE_O424_PLAN.md section 11; 2026-10-13)
// ============================================================
// Used by BOTH the maintainer's land-batch.js and the public verifier repo (FL343/epoch-sync-gate): the verifier's
//   lib/es-common.js is a byte copy made by infra/verifier/deploy.js and pinned by fingerprint (tripwire mvp/test/o424-verifier.js).
//   Because it is published, this file stays English-only, names no private repo or game, and requires Node built-ins only.
// Contents: epoch-sync tests under four clocks - are the commits that arrived meanwhile only bot state commits - are commit
//   messages fit for the public repo - drop the two AI trailer lines - which surfaces a series touches (some need a human) -
//   series fingerprint - public-data checks (same rules as the private pre-push hook; the word list is passed in) -
//   the signed "epoch-sync landed" mark.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const CLOCKS = [null, '2026-12-02T00:00:00Z', '2027-03-15T00:00:00Z'];   // unpinned / after season 1 starts / next year

// Four passes: the three clocks in UTC (production reconciliation runs on UTC machines) + the unpinned clock in the
//   maintainer's timezone. localTz = timezone of the fourth pass: null = inherit (maintainer machine);
//   the verifier runs on UTC machines and passes 'Asia/Shanghai' to get the same set.
function esPasses(localTz) {
  return CLOCKS.map((clk) => ({ clk, tz: 'UTC' })).concat([{ clk: null, tz: localTz || null }]);
}
// epoch-sync test/*.js, one node process per file, four passes. Returns { total, bad: ['<clock> <tz> <file>'], fails: [{ name, out }] }
//   opts.env = base environment (default: this process) - opts.localTz see above - opts.timeoutMs per file (default 15 min)
//   opts.onStart(name) / opts.onDone(name, exitCode | 'timeout', ms) = progress per file (the verifier prints it, so a run that
//   is killed from outside still shows which file was running; W114)
function runEsTests(esDir, opts) {
  const o = opts || {};
  const files = fs.readdirSync(path.join(esDir, 'test')).filter((f) => f.endsWith('.js')).sort();
  const bad = [], fails = [];
  const passes = esPasses(o.localTz);
  for (const { clk, tz } of passes) {
    for (const f of files) {
      const env = Object.assign({}, o.env || process.env);
      if (clk) env.SEASON_NOW = clk; else delete env.SEASON_NOW;
      if (tz) env.TZ = tz; else delete env.TZ;
      const name = (clk || 'unpinned') + ' ' + (tz || 'local-tz') + ' ' + f, t0 = Date.now();
      if (o.onStart) o.onStart(name);
      const r = cp.spawnSync(o.node || process.execPath, [path.join('test', f)], { cwd: esDir, env, encoding: 'utf8', windowsHide: true, maxBuffer: 256 << 20, timeout: o.timeoutMs || 900000 });
      if (o.onDone) o.onDone(name, r.error && r.error.code === 'ETIMEDOUT' ? 'timeout' : r.status, Date.now() - t0);
      if (r.status !== 0) {
        bad.push(name);
        fails.push({ name, out: (String(r.stdout || '') + String(r.stderr || '') + (r.error ? '\n' + r.error.message : '')).slice(-4000) });
      }
    }
  }
  return { total: files.length * passes.length, bad, fails };
}

// Same tests and the same result as runEsTests, but opts.jobs files at a time (default 2) - the verifier's way (O612, 2026-10-30:
//   one file after another the four passes took 50-57 minutes and crossed the step limit). The files are independent within
//   a pass (epoch-sync's own CI runs them several at a time, tools/run-tests.js), but some write fixed-name scratch files in the
//   repo root, so the same file never runs under two passes at once. Results come back in runEsTests order whatever finished
//   first. Returns a Promise of { total, bad, fails }. opts as runEsTests (timeoutMs default 15 min, onStart / onDone the same).
function runEsTestsPar(esDir, opts) {
  const o = opts || {};
  const jobs = Math.max(1, Math.min(8, Math.floor(+o.jobs) || 2));
  const files = fs.readdirSync(path.join(esDir, 'test')).filter((f) => f.endsWith('.js')).sort();
  const queue = [];
  for (const { clk, tz } of esPasses(o.localTz)) for (const f of files) queue.push({ clk, tz, f, i: queue.length });
  const total = queue.length, results = new Array(total), busy = new Set();
  const limit = o.timeoutMs || 900000;
  let running = 0;
  const tail = (s) => (s.length > 65536 ? s.slice(-65536) : s);
  const runOne = (job) => new Promise((resolve) => {
    const env = Object.assign({}, o.env || process.env);
    if (job.clk) env.SEASON_NOW = job.clk; else delete env.SEASON_NOW;
    if (job.tz) env.TZ = job.tz; else delete env.TZ;
    const name = (job.clk || 'unpinned') + ' ' + (job.tz || 'local-tz') + ' ' + job.f, t0 = Date.now();
    if (o.onStart) o.onStart(name);
    let out = '', err = '', late = false, spawnErr = null, settled = false;
    const child = cp.spawn(o.node || process.execPath, [path.join('test', job.f)], { cwd: esDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { late = true; try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, limit);
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status = late ? 'timeout' : code;
      if (o.onDone) o.onDone(name, status, Date.now() - t0);
      resolve({ name, bad: status !== 0, out: (out + err + (late ? '\nkilled after ' + Math.round(limit / 1000) + ' s' : '') + (spawnErr ? '\n' + spawnErr.message : '')).slice(-4000) });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out = tail(out + d); });
    child.stderr.on('data', (d) => { err = tail(err + d); });
    child.on('error', (e) => { spawnErr = e; if (child.pid === undefined) settle(null); });
    child.on('close', (code) => settle(code));
  });
  return new Promise((resolve) => {
    const pump = () => {
      if (!queue.length && !running) {
        const bad = [], fails = [];
        for (const r of results) if (r.bad) { bad.push(r.name); fails.push({ name: r.name, out: r.out }); }
        return resolve({ total, bad, fails });
      }
      for (let k = 0; k < queue.length && running < jobs;) {
        const job = queue[k];
        if (busy.has(job.f)) { k++; continue; }
        queue.splice(k, 1);
        busy.add(job.f);
        running++;
        runOne(job).then((r) => { results[job.i] = r; busy.delete(job.f); running--; pump(); });
      }
    };
    pump();
  });
}

// Commits that arrived on epoch-sync main (git log --format=%H%x01%an%x01%s%x02 --name-only) -> reason string if any of them
//   is not a reconciliation-bot state commit, null if all are. State commit = author github-actions[bot] + subject "state:..."
//   + only root-level *.json touched (validate.js, test/, .github never count).
function esForeignSince(log) {
  const commits = [];
  for (const line of String(log || '').split(/\r?\n/)) {
    if (line.includes('\x01')) { const [sha, an, s] = line.replace('\x02', '').split('\x01'); commits.push({ sha, an, s, files: [] }); }
    else if (line.trim() && commits.length) commits[commits.length - 1].files.push(line.trim());
  }
  for (const c of commits) {
    const s8 = String(c.sha).slice(0, 8);
    if (c.an !== 'github-actions[bot]') return s8 + ' author ' + c.an;
    if (!/^state:/.test(c.s || '')) return s8 + ' subject "' + c.s + '"';
    const odd = c.files.filter((f) => !/^[^/]+\.json$/.test(f));
    if (odd.length) return s8 + ' touched ' + odd.slice(0, 3).join(', ');
  }
  return null;
}

// Series commits (git log --format=%H%x01%an%x01%B%x02) -> problems the public repo rejects: AI author / AI attribution in
//   the message / Han characters in the message (same two rules as the private hook)
function esMessageProblems(log) {
  const out = [];
  for (const rec of String(log || '').split('\x02')) {
    const [sha, author, body] = rec.replace(/^\s+/, '').split('\x01');
    if (!sha) continue;
    const s = sha.slice(0, 8);
    if (/claude|anthropic/i.test(author || '')) out.push(s + ' author is ' + author);
    if (/co-authored-by|anthropic|claude/i.test(body || '')) out.push(s + ' message has AI attribution');
    if (/\p{Script=Han}/u.test(body || '')) out.push(s + ' message has Han characters');
  }
  return out;
}

// Drop the two AI trailer lines cloud patches carry (Co-Authored-By: Claude ... / Claude-Session: ...); the rest is untouched
//   (user decision 10-12, O424 11.9-1). Anything else attributing AI or written in Han still fails esMessageProblems. Pure; { msg, n }
function esStripTrailers(msg) {
  let n = 0;
  const lines = String(msg || '').replace(/\r\n/g, '\n').split('\n').filter((l) => {
    const t = l.trim();
    if ((/^co-authored-by:/i.test(t) && /claude|anthropic/i.test(t)) || /^claude-session:/i.test(t)) { n++; return false; }
    return true;
  });
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return { msg: lines.join('\n') + '\n', n };
}
// git rebase --exec runs this once per series commit (cwd = the epoch-sync clone): author = the identity configured in that clone,
//   AI trailers dropped (count printed on stdout for the caller to sum)
function amendStripHead() {
  const run = (args) => { const r = cp.spawnSync('git', args, { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error('git ' + args[0] + ' failed: ' + String(r.stderr || '').trim().slice(0, 300)); return String(r.stdout || ''); };
  const { msg, n } = esStripTrailers(run(['log', '-1', '--format=%B']));
  const f = path.join(os.tmpdir(), 'gmt-landmsg-' + process.pid + '.txt');
  fs.writeFileSync(f, msg);
  try { run(['commit', '--amend', '--reset-author', '--quiet', '--cleanup=verbatim', '-F', f]); } finally { fs.rmSync(f, { force: true }); }
  if (n) console.log('[es] stripped ' + n + ' AI trailer line(s)');
}

// ---------------------------------------------------------------- series: surfaces touched, size, fingerprint
// Touching these always goes back to the maintainer (policy / live state): workflows, key-table mirrors, root-level *.json
//   (state files and config tables the reconciliation bot writes every 5 minutes)
const ES_LOCAL_PATHS = [
  { re: /^\.github\//, why: 'epoch-sync workflows (.github)' },
  { re: /^(attest|persist)-keys(\.json)?$/, why: 'key-table mirror' },
  { re: /^[^/]+\.json$/, why: 'root-level json (state file / config table)' },
];
const ES_MAX_LINES = 6000;   // changed (+/-) lines across the series; above this a human reads it (the verifier reviewer reads every line;
                             //   rehearsal 10-13: one landed batch was 4106 lines, which a reviewer still reads in one pass)
function patchPaths(text) {
  const out = new Set();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m;
  while ((m = re.exec(String(text || '')))) { out.add(m[1]); out.add(m[2]); }
  return [...out];
}
function patchChangedLines(text) {
  let n = 0;
  for (const l of String(text || '').split('\n')) if ((l[0] === '+' && !l.startsWith('+++')) || (l[0] === '-' && !l.startsWith('---'))) n++;
  return n;
}
// texts = full text of each series file -> reasons the verifier must not take it (empty = within scope)
function esScopeProblems(texts, maxLines) {
  const out = [];
  const lim = maxLines || ES_MAX_LINES;
  let lines = 0;
  for (const t of texts || []) {
    lines += patchChangedLines(t);
    for (const p of patchPaths(t)) for (const r of ES_LOCAL_PATHS) if (r.re.test(p)) out.push(r.why + ': ' + p);
  }
  if (lines > lim) out.push('series changes ' + lines + ' lines, above the verifier limit of ' + lim);
  return [...new Set(out)];
}
// Series fingerprint = sha256 over, in order, each file's (path + sha256(content)); content = raw bytes of `git show <head>:<path>`.
//   fetch / test / push jobs and the merge gate all use this one.
function seriesHash(entries) {
  const h = crypto.createHash('sha256');
  for (const e of entries || []) h.update(String(e.path) + '\0' + crypto.createHash('sha256').update(e.content).digest('hex') + '\n');
  return h.digest('hex');
}

// ---------------------------------------------------------------- public-data checks (private pre-push hook rules; word list passed in)
// files = [{ path, text }] = every tracked file of the patched clone; wordRe = identifier regex (case-insensitive)
//   hook rules: Han characters in any tracked file -> block; identifier / SteamID (76561 + 12 digits) on a line of a file whose
//   path does not contain "test/" -> block (the hook drops matches with grep -viE "^[^:]*test/": substring, any position)
function publicDataProblems(files, wordRe) {
  const out = [];
  const steam = /76561\d{12}/;
  for (const f of files || []) {
    const text = String(f.text || '');
    if (/\p{Script=Han}/u.test(text)) out.push(f.path + ': han');
    if (/test\//i.test(f.path)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (wordRe && wordRe.test(lines[i])) { out.push(f.path + ':' + (i + 1) + ': identifier'); break; }
      if (steam.test(lines[i])) { out.push(f.path + ':' + (i + 1) + ': steamid'); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- signed "epoch-sync landed" mark (push job signs, merge gate verifies)
// Signs { batch, tested head, series fingerprint, epoch-sync commit after push }; public keys live in the main repo's gate file
//   infra/workbench/land-keys.json (key rotation = maintainer edits that file)
function markPayload(m) {
  return 'gmt-es-landed v1 batch=' + m.batch + ' head=' + m.head + ' series=' + m.series + ' es=' + m.es;
}
function signMark(m, privatePem) {
  return crypto.sign(null, Buffer.from(markPayload(m)), crypto.createPrivateKey(privatePem)).toString('base64');
}
function verifyMark(m, sig, publicPems) {
  if (!m || !/^B\d+$/.test(m.batch || '') || !/^[0-9a-f]{40}$/.test(m.head || '') || !/^[0-9a-f]{64}$/.test(m.series || '') || !/^[0-9a-f]{40}$/.test(m.es || '')) return false;
  let raw;
  try { raw = Buffer.from(String(sig || ''), 'base64'); } catch (e) { return false; }
  for (const pem of publicPems || []) {
    try { if (crypto.verify(null, Buffer.from(markPayload(m)), crypto.createPublicKey(pem), raw)) return true; } catch (e) { /* skip a bad key */ }
  }
  return false;
}
const MARK_RE = /<!--\s*gmt-es-landed batch=(B\d+) head=([0-9a-f]{40}) series=([0-9a-f]{64}) es=([0-9a-f]{40}) sig=([A-Za-z0-9+/=]+)\s*-->/;
function markComment(m, sig) {
  return '<!-- gmt-es-landed batch=' + m.batch + ' head=' + m.head + ' series=' + m.series + ' es=' + m.es + ' sig=' + sig + ' -->';
}
function parseMarkComment(body) {
  const x = MARK_RE.exec(String(body || ''));
  return x ? { batch: x[1], head: x[2], series: x[3], es: x[4], sig: x[5] } : null;
}

if (require.main === module) {
  if (process.argv.includes('--amend-strip')) {
    try { amendStripHead(); process.exit(0); } catch (e) { console.error('[es] ' + e.message); process.exit(1); }
  }
  console.error('usage: node es-common.js --amend-strip   (for git rebase --exec)');
  process.exit(2);
}

module.exports = {
  CLOCKS, esPasses, runEsTests, runEsTestsPar, esForeignSince, esMessageProblems, esStripTrailers, amendStripHead,
  ES_LOCAL_PATHS, ES_MAX_LINES, patchPaths, patchChangedLines, esScopeProblems, seriesHash,
  publicDataProblems, markPayload, signMark, verifyMark, markComment, parseMarkComment,
};
