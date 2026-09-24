import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
for (const file of [manifest.background.service_worker, manifest.options_page, ...manifest.content_scripts.flatMap(s => s.js)]) {
  if (!existsSync(`extension/${file}`)) throw new Error(`Missing ${file}`);
}
for (const file of readdirSync('extension').filter(f => /\.(m?js)$/.test(f))) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(`extension/${file}`, 'utf8'), encoding: 'utf8' });
  if (result.status) throw new Error(`${file}: ${result.stderr}`);
}
console.log('Manifest / JavaScript syntax OK');
