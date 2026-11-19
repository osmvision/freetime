import { build } from 'esbuild';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await build({
  entryPoints: ['auth.js'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/auth.js',
  target: ['es2022'],
});
const ui = '../desktop/ui';
const assets = ['/', '/offline.html', '/styles.css', '/web-auth.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/img/ideas/credits.json', '/support.json'];
for (const directory of ['js', 'fonts']) {
  for (const name of await readdir(`${ui}/${directory}`)) {
    if (name.endsWith('.js') || name.endsWith('.woff2')) assets.push(`/${directory}/${name}`);
  }
}
const hash = createHash('sha256');
for (const asset of assets) {
  let path = `${ui}${asset === '/' ? '/index.html' : asset}`;
  if (asset === '/web-auth.js') path = 'dist/auth.js';
  if (['/offline.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'].includes(asset)) path = `public${asset}`;
  hash.update(await readFile(path));
}
const version = hash.digest('hex').slice(0, 16);
await writeFile('dist/precache.json', JSON.stringify(assets));
await writeFile('dist/sw.js', (await readFile('public/sw.js', 'utf8')).replace('__VERSION__', version));
