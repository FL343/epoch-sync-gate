'use strict';
// seal.js - encrypt a directory for a public artifact (RSA-OAEP-256 wraps a fresh AES-256-GCM key).
// Public repo artifacts can be downloaded by anyone, so every log that may contain private text is sealed;
// only the holder of the private key (verifier box + maintainer machine) can open it.
//   node lib/seal.js seal <public.pem> <dir> <out.sealed>
//   node lib/seal.js open <private.pem> <in.sealed> <outDir>
// Format: "SEAL1\n" + base64(wrappedKey) + "\n" + base64(iv) + "\n" + base64(tag) + "\n" + ciphertext(tar.gz of dir)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

function tarDir(dir) {
  const r = cp.spawnSync('tar', ['-czf', '-', '-C', dir, '.'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('tar failed: ' + String(r.stderr || '').slice(0, 200));
  return r.stdout;
}
function sealBuffer(buf, publicPem) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  const wrapped = crypto.publicEncrypt({ key: publicPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  const head = 'SEAL1\n' + wrapped.toString('base64') + '\n' + iv.toString('base64') + '\n' + c.getAuthTag().toString('base64') + '\n';
  return Buffer.concat([Buffer.from(head), body]);
}
function openBuffer(sealed, privatePem) {
  let off = 0;
  const line = () => { const i = sealed.indexOf(10, off); const s = sealed.slice(off, i).toString(); off = i + 1; return s; };
  if (line() !== 'SEAL1') throw new Error('not a sealed file');
  const wrapped = Buffer.from(line(), 'base64'), iv = Buffer.from(line(), 'base64'), tag = Buffer.from(line(), 'base64');
  const key = crypto.privateDecrypt({ key: privatePem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(sealed.slice(off)), d.final()]);
}

if (require.main === module) {
  const [cmd, keyFile, a, b] = process.argv.slice(2);
  if (cmd === 'seal') {
    fs.writeFileSync(b, sealBuffer(tarDir(a), fs.readFileSync(keyFile, 'utf8')));
  } else if (cmd === 'open') {
    fs.mkdirSync(b, { recursive: true });
    const tgz = openBuffer(fs.readFileSync(a), fs.readFileSync(keyFile, 'utf8'));
    const r = cp.spawnSync('tar', ['-xzf', '-', '-C', b], { input: tgz });
    if (r.status !== 0) { console.error('untar failed'); process.exit(1); }
  } else { console.error('usage: seal.js seal <pub> <dir> <out> | open <priv> <in> <outDir>'); process.exit(2); }
}
module.exports = { sealBuffer, openBuffer, tarDir };
