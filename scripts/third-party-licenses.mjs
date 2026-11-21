// Generates THIRD_PARTY_LICENSES.md from the actual npm and Cargo dependencies.
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nm = join(root, 'node_modules');

function buildEnvWithCargo() {
  const env = { ...process.env };
  const cargoBin = join(homedir(), '.cargo', 'bin');
  const currentPath = env.PATH || env.Path || '';
  if (existsSync(cargoBin) && !currentPath.toLowerCase().includes(cargoBin.toLowerCase())) {
    const nextPath = currentPath ? `${cargoBin}${delimiter}${currentPath}` : cargoBin;
    env.PATH = nextPath;
    if ('Path' in env) env.Path = nextPath;
  }
  return env;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function findLicenseFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice|ofl)(\.|$)/i.test(f) && !/\.json$/i.test(f))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }));
}

function pkgNameFromInputPath(inputPath) {
  const rel = relative(nm, join(root, inputPath));
  if (rel.startsWith('..')) return null;
  const parts = rel.split(sep);
  if (parts[0]?.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] || null;
}

async function collectBundledNpmPackages() {
  const pkgs = new Set();
  const entry = join(root, 'web', 'src', 'app.js');
  if (existsSync(entry)) {
    const res = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      target: 'chrome114',
      external: ['fonts/*'],
      logLevel: 'silent',
    });
    for (const input of Object.keys(res.metafile.inputs)) {
      const name = pkgNameFromInputPath(input);
      if (name) pkgs.add(name);
    }
  }
  // Static assets copied into web/dist directly by web/build.mjs.
  for (const staticPkg of [
    'mermaid',
    'katex',
    '@fontsource-variable/geist',
    '@fontsource-variable/geist-mono',
  ]) {
    pkgs.add(staticPkg);
  }
  return [...pkgs].sort();
}

function detectMermaidBundledDeps() {
  const mermaidBundle = join(nm, 'mermaid', 'dist', 'mermaid.min.js');
  const mermaidPkg = readJson(join(nm, 'mermaid', 'package.json'));
  const hasElk = existsSync(mermaidBundle) && readFileSync(mermaidBundle, 'utf8').includes('org.eclipse.elk');
  const deps = Object.keys(mermaidPkg.dependencies || {}).sort();
  return { hasElk, deps };
}

function collectRustCrates() {
  const stdout = execFileSync(
    'cargo',
    ['metadata', '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'), '--filter-platform', 'x86_64-pc-windows-msvc', '--format-version', '1'],
    { cwd: root, env: buildEnvWithCargo(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const meta = JSON.parse(stdout);
  const ws = new Set(meta.workspace_members || []);
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const active = new Set();
  for (const node of meta.resolve?.nodes || []) {
    if (!ws.has(node.id)) active.add(node.id);
  }
  const crates = [];
  for (const id of active) {
    const p = byId.get(id);
    if (!p || ws.has(p.id)) continue;
    crates.push(p);
  }
  crates.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return crates;
}

function formatNpmLicense(name) {
  const dir = join(nm, name);
  if (!existsSync(dir)) return null;
  const pkg = readJson(join(dir, 'package.json'));
  let license = pkg.license || '';
  if (!license && name === 'khroma') license = 'MIT (from khroma/license)';
  if (name === 'dompurify') license = 'Apache-2.0 (chosen from "MPL-2.0 OR Apache-2.0")';
  if (name === 'elkjs') license = 'EPL-2.0 (chosen from "EPL-2.0 OR GPL-3.0-or-later")';

  let files = findLicenseFiles(dir);
  if (name === 'dompurify') {
    // Ship under Apache-2.0 only; omit LICENSE-MPL so there is no ambiguity.
    files = files.filter((f) => !/mpl/i.test(f.name));
  }
  return {
    name,
    version: pkg.version,
    license: license || 'See license text',
    repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || pkg.homepage || '',
    files,
  };
}

function dedupeTexts(items) {
  const groups = new Map();
  for (const item of items) {
    for (const f of item.files) {
      const digest = createHash('sha256').update(f.text).digest('hex');
      if (!groups.has(digest)) {
        groups.set(digest, { holders: [], file: f.name, text: f.text });
      }
      groups.get(digest).holders.push(`${item.name} ${item.version}`);
    }
  }
  return [...groups.values()];
}

const appPkg = readJson(join(root, 'package.json'));
const bundledNames = await collectBundledNpmPackages();
const mermaidInfo = detectMermaidBundledDeps();
if (mermaidInfo.hasElk && !bundledNames.includes('elkjs')) {
  bundledNames.push('elkjs');
}
for (const dep of mermaidInfo.deps) {
  if (!bundledNames.includes(dep) && existsSync(join(nm, dep))) {
    bundledNames.push(dep);
  }
}
bundledNames.sort();

const npmEntries = bundledNames.map(formatNpmLicense).filter(Boolean);
const rustCrates = collectRustCrates();

const lines = [];
lines.push('# Third-Party Licenses');
lines.push('');
lines.push(`This file lists the third-party software components and fonts distributed with **Inkleaf** v${appPkg.version} (MIT License).`);
lines.push('');
lines.push('Key licensing notes:');
lines.push('- **DOMPurify** is dual-licensed (`MPL-2.0 OR Apache-2.0`); Inkleaf distributes it under **Apache-2.0**.');
lines.push('- **KaTeX** (including its bundled fonts) is distributed under the **MIT License**.');
lines.push('- **Geist** & **Geist Mono** (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`) are distributed under **SIL Open Font License 1.1**.');
lines.push('- **highlight.js** is distributed under **BSD-3-Clause**.');
lines.push('- **CodeMirror 6** (`codemirror`, `@codemirror/*`, `@lezer/*`) is distributed under **MIT**.');
lines.push(
  mermaidInfo.hasElk
    ? '- **Mermaid** (`mermaid.min.js`) bundles **elkjs** (`org.eclipse.elk` present in `mermaid.min.js`, dual-licensed `EPL-2.0 OR GPL-3.0-or-later`); Inkleaf distributes it under **EPL-2.0**. Unmodified elkjs source code is available at https://github.com/kieler/elkjs and https://github.com/eclipse-elk/elk.'
    : '- **Mermaid** is distributed under **MIT**.',
);
lines.push('- **Microsoft Edge WebView2**: the Windows desktop shell uses the `webview2-com` / `webview2-com-sys` bindings; the Evergreen WebView2 Runtime is provided by Microsoft under Microsoft Software License Terms (installed by Windows 11 or via Microsoft\'s WebView2 bootstrapper).');
lines.push('');

lines.push('## 1. Web & Frontend Dependencies');
lines.push('');
lines.push('| Package | Version | License | Source / Repository |');
lines.push('| --- | --- | --- | --- |');
for (const entry of npmEntries) {
  const repo = entry.repository.replace(/^git\+/, '').replace(/\.git$/, '');
  lines.push(`| ${entry.name} | ${entry.version} | ${entry.license} | ${repo || 'npm'} |`);
}
lines.push('');

lines.push('### Web Dependency License Texts');
lines.push('');
for (const entry of npmEntries) {
  lines.push(`#### ${entry.name} (${entry.version}) — ${entry.license}`);
  lines.push('');
  if (entry.name === 'elkjs') {
    lines.push('Source code availability (EPL-2.0 Section 3.1): https://github.com/kieler/elkjs (upstream Eclipse ELK: https://github.com/eclipse-elk/elk)');
    lines.push('');
  }
  if (!entry.files.length) {
    lines.push(`Licensed under ${entry.license}.`);
    lines.push('');
    continue;
  }
  for (const f of entry.files) {
    lines.push('```text');
    lines.push(f.text);
    lines.push('```');
    lines.push('');
  }
}

lines.push('## 2. Rust / Cargo Dependencies (`x86_64-pc-windows-msvc`)');
lines.push('');
lines.push(`Total resolved crates: ${rustCrates.length}`);
lines.push('');
lines.push('| Crate | Version | License | Repository |');
lines.push('| --- | --- | --- | --- |');
const rustItemsWithFiles = [];
for (const c of rustCrates) {
  const repo = c.repository || c.homepage || '';
  lines.push(`| ${c.name} | ${c.version} | ${c.license || 'See notice'} | ${repo} |`);
  const crateDir = dirname(c.manifest_path);
  const files = findLicenseFiles(crateDir);
  if (files.length) {
    rustItemsWithFiles.push({ name: c.name, version: c.version, files });
  }
}
lines.push('');
lines.push('### Rust Dependency License & Notice Texts (Deduplicated)');
lines.push('');
const dedupedRust = dedupeTexts(rustItemsWithFiles);
for (const grp of dedupedRust) {
  lines.push(`#### ${grp.holders.join(', ')} (${grp.file})`);
  lines.push('');
  lines.push('```text');
  lines.push(grp.text);
  lines.push('```');
  lines.push('');
}

const outPath = join(root, 'THIRD_PARTY_LICENSES.md');
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(`Generated ${outPath}: ${npmEntries.length} npm packages, ${rustCrates.length} Rust crates, ${dedupedRust.length} deduplicated Rust license notices.`);
