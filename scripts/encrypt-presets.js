#!/usr/bin/env node
// Encrypts a JSON array of strings (from stdin) with AES-256-GCM using
// CHALLENGE_PRESET_KEY env var. Prints base64 blob to stdout — paste the
// result into server.js as SNL_PRESETS_CIPHER. The plaintext never touches
// disk, so this script stays safe to commit.
//
// Usage:
//   CHALLENGE_PRESET_KEY=... node scripts/encrypt-presets.js < presets.json
//   echo '["item 1","item 2"]' | CHALLENGE_PRESET_KEY=... node scripts/encrypt-presets.js
const crypto = require('crypto');

const pass = process.env.CHALLENGE_PRESET_KEY;
if (!pass) {
  console.error('Set CHALLENGE_PRESET_KEY env var first.');
  process.exit(1);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let arr;
  try {
    arr = JSON.parse(input);
    if (!Array.isArray(arr) || !arr.every((v) => typeof v === 'string')) {
      throw new Error('Input must be a JSON array of strings');
    }
  } catch (err) {
    console.error('Invalid input:', err.message);
    process.exit(1);
  }
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pass, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(arr), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([salt, iv, tag, ct]).toString('base64');
  process.stdout.write(blob + '\n');
});
