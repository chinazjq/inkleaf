// Bundles the reader/editor page into web/dist for Tauri.
import * as esbuild from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(webRoot);
const dist = join(webRoot, 'dist');
const nm = join(repoRoot, 'node_modules');
const watch = process.argv.includes('--watch');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'fonts'), { recursive: true });

for (const file of ['index.html', 'boot.js', 'sample.md']) {
  copyFileSync(join(webRoot, 'src', file), join(dist, file));
}

const fontFiles = [
  ['@fontsource-variable/geist/files/geist-latin-wght-normal.woff2', 'geist-latin-wght-normal.woff2'],
  ['@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2', 'geist-latin-ext-wght-normal.woff2'],
  ['@fontsource-variable/geist/files/geist-latin-wght-italic.woff2', 'geist-latin-wght-italic.woff2'],
  ['@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2', 'geist-mono-latin-wght-normal.woff2'],
  ['@fontsource-variable/geist-mono/files/geist-mono-latin-ext-wght-normal.woff2', 'geist-mono-latin-ext-wght-normal.woff2'],
  ['@fontsource-variable/geist-mono/files/geist-mono-latin-wght-italic.woff2', 'geist-mono-latin-wght-italic.woff2'],
];
for (const [srcRel, destName] of fontFiles) {
  copyFileSync(join(nm, srcRel), join(dist, 'fonts', destName));
}

copyFileSync(join(nm, 'mermaid/dist/mermaid.min.js'), join(dist, 'mermaid.min.js'));
// KaTeX stylesheet and its fonts, kept at their relative path so url(fonts/...) resolves.
cpSync(join(nm, 'katex/dist/fonts'), join(dist, 'katex/fonts'), {
  recursive: true,
  filter: (src) => !/\.(ttf|woff)$/.test(src),
});
copyFileSync(join(nm, 'katex/dist/katex.min.css'), join(dist, 'katex/katex.min.css'));

const options = {
  entryPoints: {
    app: join(webRoot, 'src', 'app.js'),
    style: join(webRoot, 'src', 'style.css'),
  },
  bundle: true,
  minify: !watch,
  format: 'iife',
  target: 'chrome114',
  outdir: dist,
  loader: { '.woff2': 'file' },
  external: ['fonts/*'],
  legalComments: 'linked',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
