import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
const v = Date.now().toString(36);
mkdirSync('public', { recursive: true });
await build({ entryPoints: ['src/fb.js'], bundle: true, minify: true, format: 'esm', target: 'es2020', outfile: 'public/fb.js' });
copyFileSync('src/app.js', 'public/app.js');
const css = readFileSync('src/shell.css', 'utf8');
const html = readFileSync('src/index.html', 'utf8')
  .replace('</style>', css + '\n</style>')
  .replace('<!--SHELL-->', `<script>window.TCD_BUILD='${v}'</script>\n<script type="module" src="/fb.js?v=${v}"></script>`);
writeFileSync('public/index.html', html);
console.log('built', v);
