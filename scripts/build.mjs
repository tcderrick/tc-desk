import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
const v = Date.now().toString(36);
mkdirSync('public', { recursive: true });
await build({ entryPoints: ['src/fb.js'], bundle: true, minify: true, format: 'esm', target: 'es2020', outfile: 'public/fb.js' });
copyFileSync('src/app.js', 'public/app.js');
for (const f of readdirSync('src/static')) copyFileSync('src/static/' + f, 'public/' + f);
const css = readFileSync('src/shell.css', 'utf8');
const html = readFileSync('src/index.html', 'utf8')
  .replace('</style>', css + '\n</style>')
  .replace(/<link rel="icon"[^>]*>/, '<link rel="icon" type="image/svg+xml" href="/favicon.svg">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n<link rel="manifest" href="/manifest.webmanifest">\n<meta name="theme-color" content="#101828">')
  .replace('<!--SHELL-->', `<script>window.TCD_BUILD='${v}'</script>\n<script type="module" src="/fb.js?v=${v}"></script>`);
writeFileSync('public/index.html', html);
console.log('built', v);
