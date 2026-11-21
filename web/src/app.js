import DOMPurify from 'dompurify';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  DOC_EXT_RE,
  assetUrl,
  fileDirName,
  isExternalUrl,
  isFileUrl,
  isRemoteMediaUrl,
  resolveMediaPath,
  resolvePath,
  safeDecodeURIComponent,
  splitFilePath,
  splitHash,
} from './paths.js';
import { DOC_ID_PREFIX, createMarkdownRenderer } from './markdown.js';
import { createSanitizer, sanitizeMermaidSource } from './sanitizer.js';
import { applyStaticI18n, resolveLang, t } from './i18n.js';
import { computePreviewScrollTop, createEditor } from './editor.js';

/* ------------------------------------------------------------------ bridge & cached shell refs */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const call = (cmd, args = {}) => (isTauri ? invoke(cmd, args) : Promise.resolve(null));

const byId = (id) => document.getElementById(id);

// Cache every shell DOM reference at startup before any document HTML is inserted,
// so untrusted document ids/names can never clobber application controls.
const ui = Object.freeze({
  root: document.documentElement,
  sidebar: byId('sidebar'),
  brandHome: byId('brand-home'),
  sidebarDirtyDot: byId('sidebar-dirty-dot'),
  tabBtns: Array.from(document.querySelectorAll('.tabs [role="tab"]')),
  outline: byId('outline'),
  files: byId('files'),
  recentPanel: byId('recent-panel'),
  editUtilBtn: byId('edit-util-btn'),
  editUtilLabel: byId('edit-util-label'),
  settingsBtn: byId('settings-btn'),
  mainCol: byId('main-col'),
  extBanner: byId('ext-banner'),
  remoteBanner: byId('remote-banner'),
  remoteBannerText: byId('remote-banner-text'),
  editorBar: byId('editor-bar'),
  editorTitle: byId('editor-title'),
  dirtyDot: byId('dirty-dot'),
  workspace: byId('workspace'),
  editorPane: byId('editor-pane'),
  scroller: byId('scroller'),
  sidebarToggle: byId('sidebar-toggle'),
  meta: byId('meta'),
  crumb: byId('meta-crumb'),
  stats: byId('meta-stats'),
  doc: byId('doc'),
  welcome: byId('welcome'),
  recentWelcome: byId('recent'),
  findbar: byId('findbar'),
  findInput: byId('find-input'),
  findCount: byId('find-count'),
  settings: byId('settings'),
  fontSize: byId('font-size'),
  aboutModal: byId('about-modal'),
  aboutVersion: byId('about-version'),
  aboutLicenses: byId('about-licenses'),
  lightbox: byId('lightbox'),
  lightboxImg: byId('lightbox').querySelector('img'),
  toast: byId('toast'),
  dropzone: byId('dropzone'),
  segs: Array.from(document.querySelectorAll('.seg')),
});

const SHELL_CONTAINERS = [
  ui.sidebar,
  ui.extBanner,
  ui.remoteBanner,
  ui.editorBar,
  ui.sidebarToggle,
  ui.meta,
  ui.welcome,
  ui.findbar,
  ui.settings,
  ui.aboutModal,
];

const state = {
  hasDoc: false,
  isSample: false,
  path: null,
  dir: null,
  name: null,
  content: '',
  savedContent: '',
  dirty: false,
  files: [],
  recent: [],
  language: 'auto',
  systemLanguage: 'zh-CN',
  imagesAnywhere: false,
  remoteImages: false,
  allowRemoteForDoc: false,
  version: '0.1.0',
  mode: 'read',
  extChangedPending: null,
};

const mdRenderer = createMarkdownRenderer();
const sanitizer = createSanitizer(DOMPurify);
let editorInstance = null;
let previewTimer = null;
let scrollSyncRaf = null;

function effectiveLang() {
  return resolveLang(state.language, state.systemLanguage);
}

/* ------------------------------------------------------------------ preferences */

function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeParse(s) {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

const prefs = Object.assign(
  { theme: 'auto', fontSize: 17, width: 'standard', sidebar: true, tab: 'outline', editLayout: 'split' },
  safeParse(safeGet('inkleaf.prefs')),
);
function savePrefs() {
  try {
    localStorage.setItem('inkleaf.prefs', JSON.stringify(prefs));
  } catch {}
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const narrow = window.matchMedia('(max-width: 760px)');
let drawerOpen = false;
narrow.addEventListener('change', () => {
  drawerOpen = false;
  applyPrefs();
});

function applyPrefs() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && darkQuery.matches);
  const changed = ui.root.dataset.theme !== (dark ? 'dark' : 'light');
  ui.root.dataset.theme = dark ? 'dark' : 'light';
  ui.root.style.setProperty('--doc-size', prefs.fontSize + 'px');
  ui.root.dataset.width = prefs.width;
  ui.root.dataset.sidebar = (narrow.matches ? drawerOpen : prefs.sidebar) ? 'on' : 'off';
  ui.root.dataset.mode = state.mode;
  ui.root.dataset.editLayout = prefs.editLayout === 'editor' ? 'editor' : 'split';
  ui.fontSize.textContent = prefs.fontSize;

  for (const seg of ui.segs) {
    const buttons = seg.querySelectorAll('button');
    if (seg.dataset.pref) {
      const val = String(prefs[seg.dataset.pref]);
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.v === val));
    } else if (seg.dataset.setting) {
      const val = String(state[seg.dataset.setting]);
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.v === val));
    }
  }

  if (editorInstance) editorInstance.setFontSize(prefs.fontSize);
  call('set_theme', { dark });
  if (changed) rerenderDiagrams();
}

darkQuery.addEventListener('change', () => {
  if (prefs.theme === 'auto') applyPrefs();
});

function setPref(k, v) {
  prefs[k] = v;
  savePrefs();
  applyPrefs();
  if (k === 'editLayout' && findState.open) {
    runFind(false);
  }
}

/* ------------------------------------------------------------------ i18n */

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

function formatMacShortcutText(s) {
  return String(s || '')
    .replace(/\bCtrl\+\s*/g, '⌘')
    .replace(/\bCtrl\s+/g, '⌘')
    .replace(/\bShift\+\s*/g, '⇧')
    .replace(/\bShift\s+/g, '⇧');
}

function applyPlatformHints(lang) {
  if (!isMac) return;
  ui.crumb.title = t(lang, 'meta.reveal.mac');
  for (const el of document.querySelectorAll('kbd')) {
    el.textContent = formatMacShortcutText(el.textContent);
  }
  for (const el of document.querySelectorAll('[title*="Ctrl"]')) {
    el.title = formatMacShortcutText(el.title);
  }
  for (const el of document.querySelectorAll('[aria-label*="Ctrl"]')) {
    el.setAttribute('aria-label', formatMacShortcutText(el.getAttribute('aria-label')));
  }
  const lede = ui.welcome.querySelector('.lede');
  if (lede) lede.textContent = formatMacShortcutText(lede.textContent);
}

function applyLanguage() {
  const lang = effectiveLang();
  applyStaticI18n(document, lang);
  ui.editUtilLabel.textContent = t(lang, state.mode === 'edit' ? 'util.read' : 'util.edit');
  if (state.hasDoc) {
    updateStats();
    updateEditorHeader();
    buildOutline();
  } else {
    ui.outline.innerHTML = `<p class="empty">${escapeHtml(t(lang, 'outline.welcomeEmpty'))}</p>`;
  }
  renderFiles();
  renderRecentPanel();
  if (!state.hasDoc) renderWelcomeRecent();
  if (findState.open) updateFindCount();
  if (!ui.remoteBanner.hidden) {
    const count = ui.doc.querySelectorAll('.remote-img-placeholder').length;
    if (count > 0) {
      ui.remoteBannerText.textContent = t(lang, 'banner.remoteBlocked', { count });
    }
  }
  for (const seg of ui.segs) {
    if (seg.dataset.setting === 'language') {
      for (const b of seg.querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b.dataset.v === state.language));
      }
    }
  }
  applyPlatformHints(lang);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ render & enhance */

function render(content, { keepScroll = false, isTypingPreview = false } = {}) {
  const lang = effectiveLang();
  const top = ui.scroller.scrollTop;
  const allowRemote = state.remoteImages || state.allowRemoteForDoc;
  const { html, katexSlots } = mdRenderer.renderDoc(content);
  const { fragment, blockedRemoteCount, remoteItems } = sanitizer.sanitizeDocument(html, {
    allowRemoteImages: allowRemote,
    katexSlots,
  });

  if (blockedRemoteCount > 0) {
    for (const item of remoteItems) {
      const holder = createRemotePlaceholder(item.url, lang);
      item.el.replaceWith(holder);
    }
    ui.remoteBannerText.textContent = t(lang, 'banner.remoteBlocked', { count: blockedRemoteCount });
    ui.remoteBanner.hidden = false;
  } else {
    ui.remoteBanner.hidden = true;
  }

  ui.doc.replaceChildren(fragment);
  enhance(lang);
  buildOutline(lang);
  updateStats(lang);

  ui.welcome.hidden = true;
  ui.meta.hidden = false;
  ui.doc.hidden = false;
  ui.scroller.scrollTop = keepScroll ? top : 0;

  if (!keepScroll && !isTypingPreview) {
    ui.doc.classList.remove('enter');
    void ui.doc.offsetWidth;
    ui.doc.classList.add('enter');
    activeIdx = -1;
    window.requestAnimationFrame(trackActive);
  }
  if (findState.open) runFind(false);
}

function createRemotePlaceholder(url, lang) {
  const wrap = document.createElement('span');
  wrap.className = 'remote-img-placeholder';
  const label = document.createElement('span');
  label.className = 'remote-img-text';
  label.textContent = t(lang, 'remote.placeholder', { url });
  label.title = url;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'remote-img-btn';
  btn.textContent = t(lang, 'remote.loadOne');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.allowRemoteForDoc = true;
    render(state.content, { keepScroll: true });
  });
  wrap.append(label, btn);
  return wrap;
}

function enhance(lang) {
  // Local images: resolve relative/absolute paths to the controlled inkleaf-asset scheme.
  for (const img of ui.doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (src && !isRemoteMediaUrl(src) && !/^(data|blob):/i.test(src)) {
      const abs = resolveMediaPath(src, state.dir);
      if (abs) {
        img.src = assetUrl(abs);
      } else {
        img.removeAttribute('src');
        img.classList.add('broken');
      }
    }
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  }

  for (const media of ui.doc.querySelectorAll('video[src], audio[src], source[src], video[poster]')) {
    for (const attr of ['src', 'poster']) {
      const val = media.getAttribute(attr);
      if (!val || isRemoteMediaUrl(val) || /^(data|blob):/i.test(val)) continue;
      const abs = resolveMediaPath(val, state.dir);
      if (abs) media.setAttribute(attr, assetUrl(abs));
      else media.removeAttribute(attr);
    }
  }

  // Code blocks: read language from the code element's class (no data-* attributes).
  for (const pre of ui.doc.querySelectorAll('pre.code')) {
    const codeEl = pre.querySelector('code');
    const langMatch = codeEl ? /\blanguage-([a-z0-9_+-]+)/i.exec(codeEl.className) : null;
    const codeLang = langMatch ? langMatch[1] : '';

    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.replaceWith(wrap);
    wrap.append(pre);

    const bar = document.createElement('div');
    bar.className = 'code-bar';
    if (codeLang) {
      const l = document.createElement('span');
      l.className = 'code-lang';
      l.textContent = codeLang;
      bar.append(l);
    }
    const b = document.createElement('button');
    b.className = 'copy';
    b.type = 'button';
    b.textContent = t(lang, 'copy');
    b.addEventListener('click', async () => {
      await copyText((pre.textContent || '').replace(/\n$/, ''));
      b.textContent = t(effectiveLang(), 'copied');
      b.classList.add('done');
      window.setTimeout(() => {
        b.textContent = t(effectiveLang(), 'copy');
        b.classList.remove('done');
      }, 1400);
    });
    bar.append(b);
    wrap.append(bar);
  }

  // GitHub-style callouts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
  for (const bq of ui.doc.querySelectorAll('blockquote')) {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') continue;
    const m = /^\s*\[!(note|tip|important|warning|caution)\]\s*/i.exec(p.textContent || '');
    if (!m) continue;
    const kind = m[1].toLowerCase();
    const first = p.firstChild;
    if (first && first.nodeType === 3) {
      first.data = first.data.replace(/^\s*\[![a-z]+\]\s*/i, '');
    }
    if (p.firstChild && p.firstChild.nodeName === 'BR') p.firstChild.remove();
    bq.classList.add('callout', `callout-${kind}`);
    const title = document.createElement('p');
    title.className = 'callout-title';
    title.textContent = t(lang, `callout.${kind}`);
    bq.prepend(title);
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
  }

  for (const table of ui.doc.querySelectorAll('table')) {
    const w = document.createElement('div');
    w.className = 'table-wrap';
    table.replaceWith(w);
    w.append(table);
  }

  // Show destination hints on external and local links.
  for (const a of ui.doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) continue;
    if (isExternalUrl(href)) {
      a.title = a.title || href;
    } else {
      const [file] = splitHash(href);
      const abs = resolvePath(file, state.dir);
      if (abs) a.title = a.title || abs;
    }
  }

  renderDiagrams();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/* ------------------------------------------------------------------ mermaid */

let mermaidReady = null;
let diagramSeq = 0;
let diagramGen = 0;
const mermaidSources = new WeakMap();

function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'mermaid.min.js';
      s.onload = () => resolve(window.mermaid);
      s.onerror = reject;
      document.head.append(s);
    });
  }
  return mermaidReady;
}

function mermaidConfig(dark) {
  const font = getComputedStyle(document.body).fontFamily;
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    maxTextSize: 50000,
    maxEdges: 500,
    // Labels as SVG <text>: HTML labels live in <foreignObject>, which the SVG sanitizer removes.
    // Mermaid 11+ reads the top-level key; the flowchart one is kept for older diagrams.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'themeCSS', 'flowchart', 'htmlLabels'],
    theme: 'base',
    fontFamily: font,
    themeVariables: dark
      ? {
          background: '#151515',
          primaryColor: '#1f1f1f',
          primaryTextColor: '#e4e4e2',
          primaryBorderColor: '#5a5a5a',
          lineColor: '#8a8a8a',
          secondaryColor: '#262626',
          tertiaryColor: '#1a1a1a',
          fontSize: '15px',
          noteBkgColor: '#262626',
          noteTextColor: '#e4e4e2',
        }
      : {
          background: '#ffffff',
          primaryColor: '#f2f1ef',
          primaryTextColor: '#1a1a1a',
          primaryBorderColor: '#8a8a8a',
          lineColor: '#6b6b6b',
          secondaryColor: '#e8e7e4',
          tertiaryColor: '#faf9f7',
          fontSize: '15px',
          noteBkgColor: '#f2f1ef',
          noteTextColor: '#1a1a1a',
        },
  };
}

async function renderDiagrams({ forceLight = false } = {}) {
  const blocks = Array.from(ui.doc.querySelectorAll('pre.mermaid-src'));
  if (!blocks.length) return;
  const gen = ++diagramGen;
  const mermaid = await loadMermaid().catch(() => null);
  if (!mermaid || gen !== diagramGen) return;

  const dark = forceLight ? false : ui.root.dataset.theme === 'dark';
  mermaid.initialize(mermaidConfig(dark));

  for (const pre of blocks) {
    if (gen !== diagramGen || !pre.isConnected) return;
    const src = pre.textContent || '';
    const fig = document.createElement('figure');
    fig.className = 'diagram';
    mermaidSources.set(fig, src);
    pre.replaceWith(fig);
    await drawDiagram(mermaid, fig, src, gen);
  }
}

async function drawDiagram(mermaid, fig, src, gen) {
  const id = `doc-mmd-${++diagramSeq}`;
  try {
    const safeSrc = sanitizeMermaidSource(src);
    const { svg } = await mermaid.render(id, safeSrc);
    if (gen !== diagramGen || !fig.isConnected) return;
    const svgFrag = sanitizer.sanitizeMermaidSvg(svg, id);
    fig.replaceChildren(svgFrag);
  } catch (err) {
    if (gen !== diagramGen || !fig.isConnected) return;
    const p = document.createElement('pre');
    p.className = 'diagram-error';
    p.textContent = t(effectiveLang(), 'diagram.error') + (err && err.message ? err.message : err) + '\n\n' + src;
    fig.replaceChildren(p);
  }
}

async function rerenderDiagrams({ forceLight = false } = {}) {
  const figs = Array.from(ui.doc.querySelectorAll('figure.diagram'));
  if (!figs.length) return;
  for (const fig of figs) {
    const src = mermaidSources.get(fig);
    if (src === undefined) continue;
    const pre = document.createElement('pre');
    pre.className = 'mermaid-src';
    pre.textContent = src;
    fig.replaceWith(pre);
  }
  await renderDiagrams({ forceLight });
}

let printingPrepared = false;

async function triggerPrint() {
  const hasDiagrams = ui.doc.querySelector('figure.diagram, pre.mermaid-src') !== null;
  if (ui.root.dataset.theme === 'dark' && hasDiagrams) {
    printingPrepared = true;
    await rerenderDiagrams({ forceLight: true });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
  try {
    window.print();
  } finally {
    if (printingPrepared) {
      printingPrepared = false;
      if (ui.root.dataset.theme === 'dark') {
        rerenderDiagrams({ forceLight: false });
      }
    }
  }
}

window.addEventListener('beforeprint', () => {
  if (!printingPrepared && ui.root.dataset.theme === 'dark') {
    rerenderDiagrams({ forceLight: true });
  }
});
window.addEventListener('afterprint', () => {
  if (printingPrepared) {
    printingPrepared = false;
  }
  if (ui.root.dataset.theme === 'dark') {
    rerenderDiagrams({ forceLight: false });
  }
});

/* ------------------------------------------------------------------ outline */

let headings = [];
let activeIdx = -1;

function buildOutline(lang = effectiveLang()) {
  headings = Array.from(ui.doc.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  ui.outline.innerHTML = '';
  if (!headings.length) {
    ui.outline.innerHTML = `<p class="empty">${escapeHtml(t(lang, 'outline.empty'))}</p>`;
    return;
  }
  const minLevel = Math.min(...headings.map((h) => +h.tagName[1]));
  const frag = document.createDocumentFragment();
  headings.forEach((h) => {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent;
    a.className = 'toc-item';
    a.style.setProperty('--depth', Math.min(4, +h.tagName[1] - minLevel));
    a.addEventListener('click', (e) => {
      e.preventDefault();
      scrollToHeading(h);
    });
    frag.append(a);
  });
  ui.outline.append(frag);
}

function scrollToHeading(h) {
  const top = h.getBoundingClientRect().top - ui.scroller.getBoundingClientRect().top + ui.scroller.scrollTop - 24;
  ui.scroller.scrollTo({
    top,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

function trackActive() {
  if (!headings.length) return;
  const limit = ui.scroller.getBoundingClientRect().top + 96;
  let idx = 0;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].getBoundingClientRect().top <= limit) idx = i;
    else break;
  }
  if (ui.scroller.scrollTop + ui.scroller.clientHeight >= ui.scroller.scrollHeight - 4) idx = headings.length - 1;
  if (idx === activeIdx) return;
  activeIdx = idx;
  const items = ui.outline.querySelectorAll('.toc-item');
  items.forEach((a, i) => {
    const isCur = i === idx;
    a.classList.toggle('active', isCur);
    if (isCur) a.setAttribute('aria-current', 'location');
    else a.removeAttribute('aria-current');
  });
  const cur = items[idx];
  if (cur && !ui.outline.hidden) cur.scrollIntoView({ block: 'nearest' });
}

let ticking = false;
ui.scroller.addEventListener(
  'scroll',
  () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      ticking = false;
      trackActive();
    });
  },
  { passive: true },
);

/* ------------------------------------------------------------------ files, recent, meta, welcome */

function renderFiles(lang = effectiveLang()) {
  ui.files.innerHTML = '';
  if (state.dir) {
    const head = document.createElement('div');
    head.className = 'folder';
    head.textContent = fileDirName(state.dir);
    head.title = state.dir;
    ui.files.append(head);
  }
  if (!state.files.length) {
    ui.files.insertAdjacentHTML('beforeend', `<p class="empty">${escapeHtml(t(lang, 'files.empty'))}</p>`);
    return;
  }
  for (const f of state.files) {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'file-item' + (f.path === state.path ? ' active' : '');
    a.title = f.path;
    a.innerHTML = '<svg class="ic"><use href="#i-doc"/></svg><span></span>';
    a.querySelector('span').textContent = f.name;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (f.path !== state.path) openDocByPath(f.path);
    });
    ui.files.append(a);
  }
}

function renderRecentPanel(lang = effectiveLang()) {
  ui.recentPanel.innerHTML = '';
  if (!state.recent.length) {
    ui.recentPanel.innerHTML = `<p class="empty">${escapeHtml(t(lang, 'recent.empty'))}</p>`;
    return;
  }
  for (const p of state.recent) {
    const row = document.createElement('div');
    row.className = 'recent-panel-item';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'recent-panel-open';
    openBtn.title = p;
    const { name, dir } = splitFilePath(p);
    openBtn.innerHTML = '<span class="r-name"></span><span class="r-path"></span>';
    openBtn.querySelector('.r-name').textContent = name;
    openBtn.querySelector('.r-path').textContent = dir;
    openBtn.addEventListener('click', () => openDocByPath(p));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'recent-panel-del';
    delBtn.title = t(lang, 'recent.remove');
    delBtn.setAttribute('aria-label', t(lang, 'recent.remove'));
    delBtn.innerHTML = '<svg class="ic"><use href="#i-close"/></svg>';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const updated = await call('remove_recent', { path: p });
      state.recent = updated || state.recent.filter((x) => x !== p);
      renderRecentPanel();
      if (!state.hasDoc) renderWelcomeRecent();
    });

    row.append(openBtn, delBtn);
    ui.recentPanel.append(row);
  }
}

function renderWelcomeRecent(lang = effectiveLang()) {
  ui.recentWelcome.innerHTML = '';
  if (!state.recent.length) {
    ui.recentWelcome.innerHTML = `<li class="empty">${escapeHtml(t(lang, 'recent.empty'))}</li>`;
    return;
  }
  for (const p of state.recent.slice(0, 8)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const { name, dir } = splitFilePath(p);
    b.innerHTML = '<span class="r-name"></span><span class="r-path"></span>';
    b.querySelector('.r-name').textContent = name;
    b.querySelector('.r-path').textContent = dir;
    b.title = p;
    b.addEventListener('click', () => openDocByPath(p));
    li.append(b);
    ui.recentWelcome.append(li);
  }
}

function updateStats(lang = effectiveLang()) {
  const text = ui.doc.textContent || '';
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const words = (
    text
      .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
      .match(/[A-Za-z0-9\u00C0-\u024F]+(?:['’-][A-Za-z0-9]+)*/g) || []
  ).length;
  const total = cjk + words;
  const minutes = Math.max(1, Math.round(cjk / 400 + words / 230));
  const locale = lang === 'en' ? 'en-US' : 'zh-CN';
  ui.stats.textContent = t(lang, 'stats.format', {
    total: total.toLocaleString(locale),
    minutes,
  });
  ui.crumb.textContent = state.path || state.name || t(lang, 'meta.untitled');
  ui.crumb.disabled = !state.path;
}

function showWelcome() {
  const lang = effectiveLang();
  state.hasDoc = false;
  state.isSample = false;
  state.path = null;
  state.dir = null;
  state.name = null;
  state.content = '';
  state.savedContent = '';
  state.allowRemoteForDoc = false;
  state.extChangedPending = null;
  setDirty(false);
  setMode('read');

  ui.extBanner.hidden = true;
  ui.remoteBanner.hidden = true;
  ui.doc.innerHTML = '';
  ui.doc.hidden = true;
  ui.meta.hidden = true;
  ui.welcome.hidden = false;
  ui.outline.innerHTML = `<p class="empty">${escapeHtml(t(lang, 'outline.welcomeEmpty'))}</p>`;
  document.title = 'Inkleaf';
  renderFiles(lang);
  renderRecentPanel(lang);
  renderWelcomeRecent(lang);
}

/* ------------------------------------------------------------------ editing & document lifecycle */

function updateEditorHeader() {
  const lang = effectiveLang();
  const displayName = state.name || t(lang, 'meta.untitled');
  ui.editorTitle.textContent = state.path || displayName;
  ui.dirtyDot.hidden = !state.dirty;
  ui.sidebarDirtyDot.hidden = !state.dirty;
  document.title = state.hasDoc
    ? `${state.dirty ? '● ' : ''}${displayName} — Inkleaf`
    : 'Inkleaf';
}

function setDirty(flag) {
  const next = Boolean(flag);
  const changed = state.dirty !== next;
  state.dirty = next;
  updateEditorHeader();
  if (changed) {
    call('set_dirty', { dirty: next });
  }
}

function onEditorChange(nextText) {
  state.content = nextText;
  setDirty(nextText !== state.savedContent);
  if (findState.open && isEditorOnly()) {
    runFind(false);
  }
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    if (state.hasDoc && state.mode === 'edit') {
      render(state.content, { keepScroll: true, isTypingPreview: true });
    }
  }, 150);
}

function onEditorScroll(scrollInfo) {
  if (state.mode !== 'edit' || prefs.editLayout !== 'split') return;
  if (scrollSyncRaf) return;
  scrollSyncRaf = window.requestAnimationFrame(() => {
    scrollSyncRaf = null;
    ui.scroller.scrollTop = computePreviewScrollTop(scrollInfo, state.content, ui.doc, ui.scroller);
  });
}

function setMode(nextMode) {
  if (nextMode === 'edit' && !state.hasDoc) {
    newUntitledDoc();
    return;
  }
  state.mode = nextMode === 'edit' ? 'edit' : 'read';
  ui.root.dataset.mode = state.mode;
  ui.editorBar.hidden = state.mode !== 'edit';
  ui.editorPane.hidden = state.mode !== 'edit';
  ui.editUtilBtn.classList.toggle('active', state.mode === 'edit');
  ui.editUtilLabel.textContent = t(effectiveLang(), state.mode === 'edit' ? 'util.read' : 'util.edit');

  if (state.mode === 'edit') {
    if (!editorInstance) {
      editorInstance = createEditor(ui.editorPane, {
        initialContent: state.content,
        onChange: onEditorChange,
        onScroll: onEditorScroll,
      });
      editorInstance.setFontSize(prefs.fontSize);
    } else {
      editorInstance.setValueSilent(state.content);
    }
    updateEditorHeader();
    editorInstance.focus();
    if (findState.open) runFind(false);
  } else {
    clearTimeout(previewTimer);
    editorInstance?.clearSearch();
    if (state.hasDoc) render(state.content, { keepScroll: true });
    else if (findState.open) runFind(false);
  }
}

async function confirmUnsaved() {
  if (!state.dirty) return true;
  if (!isTauri) return true;
  const choice = await call('ask_unsaved');
  if (choice === 'save') {
    return await saveDocument(false);
  }
  return choice === 'discard';
}

function applyLoadedDoc(doc, { hash = '', preserveMode = false } = {}) {
  state.hasDoc = true;
  state.isSample = false;
  state.path = doc.path || null;
  state.dir = doc.dir || null;
  state.name = doc.name || '';
  state.content = doc.content || '';
  state.savedContent = state.content;
  state.files = doc.files || [];
  if (doc.recent) state.recent = doc.recent;
  state.allowRemoteForDoc = false;
  state.extChangedPending = null;
  ui.extBanner.hidden = true;
  setDirty(false);

  if (!preserveMode && state.mode === 'edit') {
    setMode('read');
  } else if (editorInstance) {
    editorInstance.setValueSilent(state.content);
  }

  render(state.content);
  renderFiles();
  renderRecentPanel();
  updateEditorHeader();

  if (hash) {
    const decoded = safeDecodeURIComponent(hash);
    const prefixed = decoded.startsWith(DOC_ID_PREFIX) ? decoded : DOC_ID_PREFIX + decoded;
    const target = findDocElementByIdOrName(prefixed) || findDocElementByIdOrName(decoded);
    if (target) window.requestAnimationFrame(() => scrollToHeading(target));
  }
}

async function openDocByPath(path, hash = '') {
  if (!(await confirmUnsaved())) return false;
  try {
    const doc = await call('open_doc', { path });
    if (doc) applyLoadedDoc(doc, { hash });
    return true;
  } catch (err) {
    toast(String(err), true);
    return false;
  }
}

async function pickAndOpenDoc() {
  if (!(await confirmUnsaved())) return;
  try {
    const doc = await call('pick_doc');
    if (doc) applyLoadedDoc(doc);
  } catch (err) {
    toast(String(err), true);
  }
}

async function newUntitledDoc() {
  if (!(await confirmUnsaved())) return;
  await call('new_doc');
  const lang = effectiveLang();
  state.hasDoc = true;
  state.isSample = false;
  state.path = null;
  state.dir = null;
  state.name = t(lang, 'meta.untitled');
  state.content = '';
  state.savedContent = '';
  state.files = [];
  state.allowRemoteForDoc = false;
  state.extChangedPending = null;
  ui.extBanner.hidden = true;
  setDirty(false);
  render('');
  renderFiles();
  setMode('edit');
}

async function saveDocument(saveAs = false) {
  if (!state.hasDoc) return true;
  const content = editorInstance && state.mode === 'edit' ? editorInstance.getValue() : state.content;
  state.content = content;
  try {
    const cmd = saveAs || !state.path ? 'save_doc_as' : 'save_doc';
    const saved = await call(cmd, { content });
    if (!saved) return false;
    state.path = saved.path;
    state.dir = saved.dir;
    state.name = saved.name;
    state.savedContent = content;
    state.isSample = false;
    state.files = saved.files || state.files;
    state.extChangedPending = null;
    ui.extBanner.hidden = true;
    setDirty(false);
    renderFiles();
    updateStats();
    const recentList = await call('recent');
    if (Array.isArray(recentList)) {
      state.recent = recentList;
      renderRecentPanel();
    }
    toast(saved.notice || t(effectiveLang(), 'toast.saved'));
    return true;
  } catch (err) {
    toast(String(err), true);
    return false;
  }
}

async function reloadFromDisk() {
  try {
    const doc = await call('reload_doc');
    if (doc) {
      const keepEdit = state.mode === 'edit';
      applyLoadedDoc(doc, { preserveMode: keepEdit });
      if (keepEdit && editorInstance) editorInstance.setValueSilent(doc.content);
    }
  } catch (err) {
    toast(String(err), true);
  }
}

async function goHome() {
  if (!(await confirmUnsaved())) return;
  await call('close_doc');
  const recentList = await call('recent');
  if (Array.isArray(recentList)) state.recent = recentList;
  showWelcome();
}

async function loadSample() {
  if (!(await confirmUnsaved())) return;
  await call('new_doc');
  const text = await fetch('sample.md').then((r) => r.text());
  state.hasDoc = true;
  state.isSample = true;
  state.path = null;
  state.dir = null;
  state.name = t(effectiveLang(), 'meta.sample');
  state.content = text;
  state.savedContent = text;
  state.allowRemoteForDoc = false;
  state.extChangedPending = null;
  ui.extBanner.hidden = true;
  setDirty(false);
  setMode('read');
  render(text);
  renderFiles();
  updateEditorHeader();
}

/* ------------------------------------------------------------------ links inside #doc */

function findDocElementByIdOrName(id) {
  if (!id) return null;
  const byEscapedId = ui.doc.querySelector(`[id="${CSS.escape(id)}"]`);
  if (byEscapedId) return byEscapedId;
  return ui.doc.querySelector(`[name="${CSS.escape(id)}"]`);
}

ui.doc.addEventListener('click', (e) => {
  const img = e.target.closest('img');
  if (img && !e.target.closest('a') && !img.classList.contains('broken')) {
    openLightbox(img);
    return;
  }
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  e.preventDefault();

  if (href.startsWith('#')) {
    const rawId = safeDecodeURIComponent(href.slice(1));
    const prefixed = rawId.startsWith(DOC_ID_PREFIX) ? rawId : DOC_ID_PREFIX + rawId;
    const target = findDocElementByIdOrName(prefixed) || findDocElementByIdOrName(rawId);
    if (target) scrollToHeading(target);
    return;
  }

  if (isFileUrl(href)) {
    toast(t(effectiveLang(), 'toast.fileBlocked'), true);
    return;
  }

  if (isExternalUrl(href)) {
    call('open_external', { url: href }).catch((err) => {
      toast(t(effectiveLang(), 'toast.openExternalFail') + String(err), true);
    });
    return;
  }

  const [file, hash] = splitHash(href);
  const abs = resolvePath(file, state.dir);
  if (!abs) return;
  if (DOC_EXT_RE.test(abs)) {
    openDocByPath(abs, hash);
  } else {
    call('open_local', { path: abs }).catch((err) => {
      if (err) toast(String(err), true);
    });
  }
});

/* ------------------------------------------------------------------ find */

const MAX_FIND_MATCHES = 1000;
const findState = { open: false, ranges: [], count: 0, index: -1, capped: false, target: 'dom' };
const supportsHighlight = typeof CSS !== 'undefined' && Boolean(CSS.highlights);
let findDebounce = null;
const isEditorOnly = () => state.mode === 'edit' && prefs.editLayout === 'editor';

function openFind() {
  ui.findbar.hidden = false;
  findState.open = true;
  const cmSel = editorInstance && state.mode === 'edit' ? editorInstance.getSelectionText().trim() : '';
  const sel = cmSel || String(window.getSelection()).trim();
  if (sel && sel.length < 80 && !sel.includes('\n')) ui.findInput.value = sel;
  ui.findInput.focus();
  ui.findInput.select();
  runFind(true);
}

function closeFind() {
  clearTimeout(findDebounce);
  ui.findbar.hidden = true;
  findState.open = false;
  findState.ranges = [];
  findState.count = 0;
  findState.index = -1;
  findState.capped = false;
  if (supportsHighlight) {
    CSS.highlights.delete('find');
    CSS.highlights.delete('find-current');
  }
  editorInstance?.clearSearch();
}

function runFind(jump) {
  const q = ui.findInput.value;
  findState.ranges = [];
  findState.count = 0;
  findState.index = -1;
  findState.capped = false;

  if (isEditorOnly() && editorInstance) {
    findState.target = 'editor';
    if (supportsHighlight) {
      CSS.highlights.delete('find');
      CSS.highlights.delete('find-current');
    }
    if (q) {
      const res = editorInstance.findMatches(q, { max: MAX_FIND_MATCHES });
      findState.count = res.count;
      findState.capped = res.capped;
      if (res.count > 0) {
        stepFind(0, res.firstIndex ?? 0, jump);
        return;
      }
    } else {
      editorInstance.clearSearch();
    }
    updateFindCount();
    return;
  }

  findState.target = 'dom';
  editorInstance?.clearSearch();
  if (q) {
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker(ui.doc, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement && n.parentElement.closest('.code-bar, .katex-mathml, style, .remote-img-placeholder')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    let n;
    outer: while ((n = walker.nextNode())) {
      const hay = n.data.toLowerCase();
      let i = hay.indexOf(needle);
      while (i >= 0) {
        const r = new Range();
        r.setStart(n, i);
        r.setEnd(n, i + q.length);
        findState.ranges.push(r);
        if (findState.ranges.length >= MAX_FIND_MATCHES) {
          findState.capped = true;
          break outer;
        }
        i = hay.indexOf(needle, i + needle.length);
      }
    }
  }

  findState.count = findState.ranges.length;
  if (supportsHighlight) CSS.highlights.set('find', new Highlight(...findState.ranges));
  if (findState.ranges.length) {
    const viewTop = ui.scroller.getBoundingClientRect().top;
    const first = findState.ranges.findIndex((r) => r.getBoundingClientRect().top >= viewTop);
    stepFind(0, first < 0 ? 0 : first, jump);
  } else {
    if (supportsHighlight) CSS.highlights.delete('find-current');
    updateFindCount();
  }
}

function stepFind(delta, absolute, jump = true) {
  const n = findState.target === 'editor' ? findState.count : findState.ranges.length;
  if (!n) return;
  findState.index = absolute !== undefined ? absolute : (findState.index + delta + n) % n;
  if (findState.target === 'editor') {
    editorInstance?.highlightMatch(findState.index, jump);
    updateFindCount();
    return;
  }
  const r = findState.ranges[findState.index];
  if (supportsHighlight) CSS.highlights.set('find-current', new Highlight(r));
  if (jump) {
    const rect = r.getBoundingClientRect();
    const box = ui.scroller.getBoundingClientRect();
    if (rect.top < box.top + 80 || rect.bottom > box.bottom - 80) {
      ui.scroller.scrollTop += rect.top - box.top - box.height / 3;
    }
  }
  updateFindCount();
}

function updateFindCount() {
  const q = ui.findInput.value;
  const n = findState.target === 'editor' ? findState.count : findState.ranges.length;
  const suffix = findState.capped ? '+' : '';
  ui.findCount.textContent = !q ? '' : n ? `${findState.index + 1} / ${n}${suffix}` : t(effectiveLang(), 'find.none');
  ui.findbar.classList.toggle('miss', Boolean(q) && !n);
}

ui.findInput.addEventListener('input', () => {
  clearTimeout(findDebounce);
  findDebounce = window.setTimeout(() => runFind(true), 120);
});
ui.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(findDebounce);
    const prevIdx = findState.index;
    runFind(false);
    const n = findState.target === 'editor' ? findState.count : findState.ranges.length;
    if (n) {
      if (prevIdx >= 0) findState.index = Math.min(prevIdx, n - 1);
      stepFind(e.shiftKey ? -1 : 1);
    }
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});

/* ------------------------------------------------------------------ lightbox & about */

function openLightbox(img) {
  ui.lightboxImg.src = img.currentSrc || img.src;
  ui.lightboxImg.alt = img.alt || '';
  ui.lightbox.hidden = false;
  window.requestAnimationFrame(() => ui.lightbox.classList.add('open'));
}

function closeLightbox() {
  ui.lightbox.classList.remove('open');
  window.setTimeout(() => {
    ui.lightbox.hidden = true;
  }, 180);
}
ui.lightbox.addEventListener('click', closeLightbox);

async function openAbout() {
  toggleSettings(false);
  ui.aboutVersion.textContent = 'v' + state.version;
  ui.aboutLicenses.textContent = '...';
  ui.aboutModal.hidden = false;
  const text = await call('get_third_party_licenses');
  ui.aboutLicenses.textContent = text || 'MIT License — © 2026 Inkleaf contributors';
  ui.aboutModal.querySelector('[data-act="about-close"]')?.focus();
}

function closeAbout() {
  ui.aboutModal.hidden = true;
}

ui.aboutModal.addEventListener('click', (e) => {
  if (e.target === ui.aboutModal) closeAbout();
});

/* ------------------------------------------------------------------ settings popover */

function toggleSettings(force) {
  const open = force !== undefined ? force : ui.settings.hidden;
  const wasOpen = !ui.settings.hidden;
  ui.settings.hidden = !open;
  ui.settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    const r = ui.settingsBtn.getBoundingClientRect();
    const sidebarOff = ui.root.dataset.sidebar === 'off' || r.width === 0;
    ui.settings.style.left = sidebarOff ? '16px' : r.left + 'px';
    ui.settings.style.bottom = sidebarOff ? '16px' : window.innerHeight - r.top + 8 + 'px';
    ui.settings.querySelector('.seg button[aria-pressed="true"]')?.focus();
  } else if (wasOpen) {
    ui.settingsBtn.focus();
  }
}

for (const seg of ui.segs) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    if (seg.dataset.pref) {
      setPref(seg.dataset.pref, b.dataset.v);
      return;
    }
    const key = seg.dataset.setting;
    if (key === 'language') {
      state.language = b.dataset.v;
      call('set_language', { language: state.language });
      applyLanguage();
      applyPrefs();
    } else if (key === 'remoteImages') {
      state.remoteImages = b.dataset.v === 'true';
      call('set_remote_images', { enabled: state.remoteImages });
      applyPrefs();
      if (state.hasDoc) render(state.content, { keepScroll: true });
    } else if (key === 'imagesAnywhere') {
      state.imagesAnywhere = b.dataset.v === 'true';
      call('set_images_anywhere', { enabled: state.imagesAnywhere });
      applyPrefs();
      if (state.hasDoc) render(state.content, { keepScroll: true });
    }
  });
}

document.addEventListener('pointerdown', (e) => {
  if (narrow.matches && drawerOpen && !ui.sidebar.contains(e.target) && !ui.sidebarToggle.contains(e.target) && !ui.settings.contains(e.target)) {
    drawerOpen = false;
    applyPrefs();
  }
  if (!ui.settings.hidden && !ui.settings.contains(e.target) && !ui.settingsBtn.contains(e.target)) {
    toggleSettings(false);
  }
});

/* ------------------------------------------------------------------ tabs, shell actions & keys */

function setTab(tab) {
  const valid = tab === 'files' || tab === 'recent' ? tab : 'outline';
  prefs.tab = valid;
  savePrefs();
  for (const tBtn of ui.tabBtns) {
    tBtn.setAttribute('aria-selected', String(tBtn.dataset.tab === valid));
  }
  ui.outline.hidden = valid !== 'outline';
  ui.files.hidden = valid !== 'files';
  ui.recentPanel.hidden = valid !== 'recent';
  if (valid === 'outline') {
    activeIdx = -1;
    trackActive();
  }
}

for (let i = 0; i < ui.tabBtns.length; i++) {
  const btn = ui.tabBtns[i];
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const nextIdx = (i + (e.key === 'ArrowRight' ? 1 : -1) + ui.tabBtns.length) % ui.tabBtns.length;
    const nextBtn = ui.tabBtns[nextIdx];
    setTab(nextBtn.dataset.tab);
    nextBtn.focus();
  });
}

function fontStep(d) {
  setPref('fontSize', Math.min(24, Math.max(13, prefs.fontSize + d)));
}

const actions = {
  home: () => goHome(),
  new: () => newUntitledDoc(),
  open: () => pickAndOpenDoc(),
  'toggle-edit': () => setMode(state.mode === 'edit' ? 'read' : 'edit'),
  save: () => saveDocument(false),
  'save-as': () => saveDocument(true),
  find: () => openFind(),
  'find-next': () => stepFind(1),
  'find-prev': () => stepFind(-1),
  'find-close': () => closeFind(),
  settings: () => toggleSettings(),
  sidebar: () => {
    if (narrow.matches) {
      drawerOpen = !drawerOpen;
      applyPrefs();
    } else {
      setPref('sidebar', !prefs.sidebar);
    }
  },
  'font-up': () => fontStep(1),
  'font-down': () => fontStep(-1),
  register: () => {
    call('open_default_apps');
    toggleSettings(false);
  },
  about: () => openAbout(),
  'about-close': () => closeAbout(),
  reveal: () => {
    if (state.path) call('reveal');
  },
  sample: () => loadSample(),
  'ext-reload': () => reloadFromDisk(),
  'ext-keep': () => {
    state.extChangedPending = null;
    ui.extBanner.hidden = true;
  },
  'remote-allow-doc': () => {
    state.allowRemoteForDoc = true;
    render(state.content, { keepScroll: true });
  },
  'remote-allow-always': () => {
    state.remoteImages = true;
    call('set_remote_images', { enabled: true });
    applyPrefs();
    render(state.content, { keepScroll: true });
  },
};

// Strictly restrict [data-act] delegation to cached app-chrome containers and ignore anything inside #doc.
document.addEventListener('click', (e) => {
  if (ui.doc.contains(e.target)) return;
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (!SHELL_CONTAINERS.some((container) => container.contains(el))) return;
  const fn = actions[el.dataset.act];
  if (fn) fn();
});

const isTyping = (e) => /input|textarea/i.test(e.target.tagName) || Boolean(e.target.closest('.cm-editor'));

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;

  // Disable browser accelerator keys that would reload or navigate away from the app page.
  if (
    e.key === 'F5' ||
    e.key === 'BrowserBack' ||
    e.key === 'BrowserForward' ||
    (mod && !e.altKey && k === 'r') ||
    (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
  ) {
    e.preventDefault();
    return;
  }

  if (mod && !e.altKey) {
    if (k === 'o') {
      e.preventDefault();
      actions.open();
    } else if (k === 'n') {
      e.preventDefault();
      actions.new();
    } else if (k === 'e') {
      e.preventDefault();
      actions['toggle-edit']();
    } else if (k === 's') {
      e.preventDefault();
      saveDocument(e.shiftKey);
    } else if (k === 'f') {
      e.preventDefault();
      openFind();
    } else if (k === '\\') {
      e.preventDefault();
      actions.sidebar();
    } else if (k === '=' || k === '+') {
      e.preventDefault();
      fontStep(1);
    } else if (k === '-') {
      e.preventDefault();
      fontStep(-1);
    } else if (k === '0') {
      e.preventDefault();
      setPref('fontSize', 17);
    } else if (k === 'l' && e.shiftKey) {
      e.preventDefault();
      setPref('theme', ui.root.dataset.theme === 'dark' ? 'light' : 'dark');
    } else if (k === 'p') {
      e.preventDefault();
      triggerPrint();
    } else if (k === 'g') {
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1);
    }
  } else if (e.key === 'Escape') {
    if (!ui.lightbox.hidden) closeLightbox();
    else if (!ui.aboutModal.hidden) closeAbout();
    else if (!ui.settings.hidden) toggleSettings(false);
    else if (findState.open) closeFind();
  } else if (e.key === 'F3') {
    e.preventDefault();
    findState.open ? stepFind(e.shiftKey ? -1 : 1) : openFind();
  } else if (e.key === 'Home' && !isTyping(e)) {
    ui.scroller.scrollTo({ top: 0 });
  } else if (e.key === 'End' && !isTyping(e)) {
    ui.scroller.scrollTo({ top: ui.scroller.scrollHeight });
  }
});

window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    fontStep(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);

/* ------------------------------------------------------------------ drag and drop */

if (isTauri) {
  getCurrentWebview().onDragDropEvent(async (event) => {
    const payload = event.payload;
    if (payload.type === 'enter' || payload.type === 'over') {
      ui.dropzone.hidden = false;
    } else if (payload.type === 'leave') {
      ui.dropzone.hidden = true;
    } else if (payload.type === 'drop') {
      ui.dropzone.hidden = true;
      const paths = payload.paths || [];
      if (!paths.length) return;
      await openDocByPath(paths[0]);
      for (const extra of paths.slice(1)) {
        call('new_window', { path: extra });
      }
    }
  });
} else {
  let dragDepth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    ui.dropzone.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      ui.dropzone.hidden = true;
    }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    ui.dropzone.hidden = true;
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    files[0].text().then((text) => {
      applyLoadedDoc({ path: null, dir: null, name: files[0].name, content: text, files: [] });
    });
  });
}

/* ------------------------------------------------------------------ toast */

let toastTimer;
function toast(text, isError = false) {
  ui.toast.textContent = text;
  ui.toast.classList.toggle('error', Boolean(isError));
  ui.toast.hidden = false;
  window.requestAnimationFrame(() => ui.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.classList.remove('show');
    window.setTimeout(() => {
      ui.toast.hidden = true;
    }, 200);
  }, isError ? 5000 : 2600);
}

/* ------------------------------------------------------------------ host events & boot */

async function init() {
  applyPrefs();
  setTab(prefs.tab);

  if (isTauri) {
    await listen('doc-opened', (ev) => {
      if (ev.payload) applyLoadedDoc(ev.payload);
    });

    await listen('doc-changed', (ev) => {
      const payload = ev.payload;
      if (!payload || payload.path !== state.path) return;
      if (state.dirty) {
        state.extChangedPending = payload.content;
        ui.extBanner.hidden = false;
        return;
      }
      state.content = payload.content;
      state.savedContent = payload.content;
      if (editorInstance) editorInstance.setValueSilent(payload.content);
      render(payload.content, { keepScroll: true });
    });

    await listen('files-changed', (ev) => {
      state.files = Array.isArray(ev.payload) ? ev.payload : [];
      renderFiles();
    });

    await listen('save-and-close', async () => {
      const ok = await saveDocument(false);
      if (ok) await call('close_window');
    });

    const data = await call('boot');
    if (data) {
      state.recent = data.recent || [];
      state.language = data.language || 'auto';
      state.systemLanguage = data.system_language || 'zh-CN';
      state.imagesAnywhere = Boolean(data.images_anywhere);
      state.remoteImages = Boolean(data.remote_images);
      state.version = data.version || '0.1.0';
      applyLanguage();
      applyPrefs();

      if (data.doc) {
        applyLoadedDoc(data.doc);
      } else {
        showWelcome();
      }
      if (data.error) {
        toast(data.error, true);
      }
      return;
    }
  }

  // Non-Tauri browser preview mode (development).
  state.systemLanguage = navigator.language || 'zh-CN';
  applyLanguage();
  if (window.location.search.includes('welcome')) {
    state.recent = [];
    showWelcome();
  } else {
    loadSample();
  }
}

init();
