#!/usr/bin/env node
const fsp = require('fs/promises');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const rawArg = process.argv[2];

if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN.');
  console.error('  1. Create a bot with @BotFather on Telegram.');
  console.error('  2. Add TELEGRAM_BOT_TOKEN=<token> to .env');
  console.error('  3. Rerun with: npm run import-stickers -- <pack_short_name_or_url>');
  process.exit(1);
}

if (!rawArg) {
  console.error('Usage: npm run import-stickers -- <pack_short_name_or_url>');
  console.error('Example: npm run import-stickers -- AnimatedEmojies');
  console.error('Example: npm run import-stickers -- https://t.me/addstickers/AnimatedEmojies');
  process.exit(1);
}

const packName = (() => {
  const m = rawArg.match(/(?:t\.me\/addstickers\/)?([A-Za-z0-9_]+)$/);
  return m ? m[1] : rawArg;
})();

const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;
const STICKERS_DIR = path.join(__dirname, '..', 'public', 'stickers');
const MANIFEST_PATH = path.join(STICKERS_DIR, 'index.json');
const SUPPORTED_EXT = new Set(['.webp', '.png', '.webm']);
const DEFAULT_USERS = ['occupatus', 'ra', 'ocean'];

async function tgCall(method, params) {
  const url = `${API}/${method}?${new URLSearchParams(params).toString()}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || 'unknown error'}`);
  return data.result;
}

function formatManifest(manifest) {
  const lines = manifest.stickers.map((s) => '    ' + JSON.stringify(s));
  return `{\n  "stickers": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

async function main() {
  console.log(`Fetching pack "${packName}"...`);
  const pack = await tgCall('getStickerSet', { name: packName });
  console.log(`  title: ${pack.title}`);
  console.log(`  stickers: ${pack.stickers.length}`);
  console.log(`  animated: ${pack.is_animated}, video: ${pack.is_video}`);

  const packDir = path.join(STICKERS_DIR, pack.name);
  await fsp.mkdir(packDir, { recursive: true });

  const manifestRaw = await fsp.readFile(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const existingNames = new Set(manifest.stickers.map((s) => s.name));

  let imported = 0;
  let skippedFormat = 0;
  let alreadyExists = 0;
  const newEntries = [];

  for (let i = 0; i < pack.stickers.length; i++) {
    const s = pack.stickers[i];
    const idx = String(i + 1).padStart(3, '0');
    const stickerName = `${pack.name}_${idx}`;

    if (existingNames.has(stickerName)) {
      alreadyExists++;
      continue;
    }

    const fileInfo = await tgCall('getFile', { file_id: s.file_id });
    const remotePath = fileInfo.file_path;
    const ext = path.extname(remotePath).toLowerCase();

    if (!SUPPORTED_EXT.has(ext)) {
      console.warn(`  skip ${stickerName}: unsupported format ${ext}`);
      skippedFormat++;
      continue;
    }

    const dl = await fetch(`${FILE_API}/${remotePath}`);
    if (!dl.ok) {
      console.warn(`  skip ${stickerName}: download failed (${dl.status})`);
      skippedFormat++;
      continue;
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    const localFile = `${idx}${ext}`;
    await fsp.writeFile(path.join(packDir, localFile), buf);

    newEntries.push({
      name: stickerName,
      label: s.emoji || pack.title,
      file: `${pack.name}/${localFile}`,
      users: DEFAULT_USERS,
    });
    imported++;
    console.log(`  + ${stickerName} ${s.emoji || ''}`);
  }

  if (newEntries.length) {
    manifest.stickers.push(...newEntries);
    await fsp.writeFile(MANIFEST_PATH, formatManifest(manifest));
  }

  console.log('');
  console.log(`Done. imported=${imported} skipped=${skippedFormat} existing=${alreadyExists}`);
  if (imported > 0) console.log('Restart the server to pick up the new manifest.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
