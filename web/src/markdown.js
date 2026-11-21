// Markdown parser, front-matter splitter, heading slugger and KaTeX slot isolator.
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';

export const DOC_ID_PREFIX = 'doc-';
const MATH_LANGS = new Set(['math', 'latex', 'tex', 'katex']);

export function slugify(text, slugsMap = new Map()) {
  const base =
    String(text || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}\-_]/gu, '') || 'section';
  const n = slugsMap.get(base) || 0;
  slugsMap.set(base, n + 1);
  const slug = n ? `${base}-${n}` : base;
  return slug.startsWith(DOC_ID_PREFIX) ? slug : `${DOC_ID_PREFIX}${slug}`;
}

/**
 * Extracts YAML front matter only when '---' starts on line 1, closes cleanly,
 * and contains valid YAML key/value lines rather than regular prose between thematic breaks.
 */
export function splitFrontMatter(src) {
  const text = String(src || '');
  const open = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
  if (!open) return { meta: null, body: text };

  const rest = text.slice(open[0].length);
  const close = /(?:^|\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!close) return { meta: null, body: text };

  const block = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  const lines = block.split(/\r?\n/);

  const topKeyRe = /^([A-Za-z0-9_\-\u4e00-\u9fa5]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;
  let sawKey = false;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (topKeyRe.test(line)) {
      sawKey = true;
      continue;
    }
    if (!sawKey) {
      // First non-empty line is not a YAML key, so line 1 '---' was a horizontal rule.
      return { meta: null, body: text };
    }
    if (!/^[ \t]+/.test(line) && !/^[ \t]*-\s+/.test(line)) {
      return { meta: null, body: text };
    }
  }
  if (!sawKey) return { meta: null, body: text };

  const rawEntries = [];
  let current = null;
  for (const line of lines) {
    if (!line.trim()) {
      if (current && current.multilineMode) current.parts.push('');
      continue;
    }
    if (/^\s*#/.test(line) && (!current || !current.multilineMode)) continue;

    const kv = topKeyRe.exec(line);
    if (kv) {
      if (current) rawEntries.push(current);
      const val = (kv[2] ?? '').trim();
      const multilineMode = val === '|' || val === '>' || val === '|-' || val === '>-';
      current = {
        key: kv[1],
        inline: multilineMode ? '' : val,
        multilineMode,
        listItems: [],
        parts: [],
      };
      continue;
    }
    if (current) {
      const listMatch = /^[ \t]*-\s+(.*)$/.exec(line);
      if (listMatch && !current.multilineMode && !current.inline) {
        current.listItems.push(unquote(listMatch[1].trim()));
      } else {
        current.parts.push(line.replace(/^[ \t]{1,4}/, ''));
      }
    }
  }
  if (current) rawEntries.push(current);

  const meta = rawEntries.map((entry) => {
    if (entry.listItems.length) {
      return [entry.key, entry.listItems.join(', ')];
    }
    if (entry.parts.length) {
      const joined = entry.parts.join('\n').trim();
      const combined = entry.inline ? `${unquote(entry.inline)}\n${joined}` : joined;
      return [entry.key, combined];
    }
    return [entry.key, unquote(entry.inline)];
  });

  return { meta, body };
}

function unquote(val) {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.length >= 2 ? val.slice(1, -1) : val;
  }
  return val;
}

function addInlineWrapperRule(md, name, tag, markerCharCode, { allowDouble = false } = {}) {
  md.inline.ruler.before('emphasis', name, (state, silent) => {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== markerCharCode) return false;
    if (allowDouble) {
      if (src.charCodeAt(start + 1) !== markerCharCode) return false;
      if (src.charCodeAt(start + 2) === markerCharCode) return false;
      const close = src.indexOf(String.fromCharCode(markerCharCode, markerCharCode), start + 2);
      if (close < 0 || close === start + 2) return false;
      const inner = src.slice(start + 2, close);
      if (inner.includes('\n')) return false;
      if (!silent) {
        state.push(`${name}_open`, tag, 1);
        const t = state.push('text', '', 0);
        t.content = inner;
        state.push(`${name}_close`, tag, -1);
      }
      state.pos = close + 2;
      return true;
    }

    // Single-character delimiter (^sup^ or ~sub~): do not interfere with ~~strikethrough~~.
    if (src.charCodeAt(start + 1) === markerCharCode) return false;
    if (start > 0 && src.charCodeAt(start - 1) === markerCharCode) return false;

    const ch = String.fromCharCode(markerCharCode);
    let pos = start + 1;
    const max = state.posMax;
    while (pos < max) {
      if (src.charCodeAt(pos) === 0x0a) return false;
      if (src.charCodeAt(pos) === 0x5c && pos + 1 < max) {
        pos += 2;
        continue;
      }
      if (src.charCodeAt(pos) === markerCharCode) {
        if (src.charCodeAt(pos + 1) === markerCharCode) return false;
        const inner = src.slice(start + 1, pos);
        if (!inner || /^\s|\s$/.test(inner) || /\s/.test(inner)) return false;
        if (!silent) {
          state.push(`${name}_open`, tag, 1);
          const t = state.push('text', '', 0);
          t.content = inner.replace(new RegExp(`\\\\${ch === '^' ? '\\^' : ch}`, 'g'), ch);
          state.push(`${name}_close`, tag, -1);
        }
        state.pos = pos + 1;
        return true;
      }
      pos++;
    }
    return false;
  });
}

export function createMarkdownRenderer() {
  let currentSlugs = new Map();
  let currentStash = null;

  const katexEngine = {
    renderToString(tex, opts) {
      const rendered = katex.renderToString(tex, { ...opts, trust: false });
      return currentStash ? currentStash(rendered, !!opts?.displayMode) : rendered;
    },
  };

  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
    highlight(code, lang) {
      const cleanLang = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      if (cleanLang === 'mermaid') {
        return `<pre class="mermaid-src">${md.utils.escapeHtml(code)}</pre>`;
      }
      if (MATH_LANGS.has(cleanLang)) {
        try {
          const rendered = katex.renderToString(code, { displayMode: true, throwOnError: false, trust: false });
          const inner = currentStash ? currentStash(rendered, true) : rendered;
          return `<div class="math-block">${inner}</div>`;
        } catch {}
      }
      let body = md.utils.escapeHtml(code);
      if (cleanLang && hljs.getLanguage(cleanLang)) {
        try {
          body = hljs.highlight(code, { language: cleanLang, ignoreIllegals: true }).value;
        } catch {}
      }
      const langClass = cleanLang ? ` language-${md.utils.escapeHtml(cleanLang)}` : '';
      return `<pre class="code"><code class="hljs${langClass}">${body}</code></pre>`;
    },
  })
    .use(footnote)
    .use(taskLists, { enabled: false, label: true })
    .use(texmath, { engine: katexEngine, delimiters: ['dollars', 'beg_end'], katexOptions: { throwOnError: false, trust: false } })
    .enable(['table', 'strikethrough']);

  addInlineWrapperRule(md, 'mark', 'mark', 0x3d /* = */, { allowDouble: true });
  addInlineWrapperRule(md, 'sup', 'sup', 0x5e /* ^ */);
  addInlineWrapperRule(md, 'sub', 'sub', 0x7e /* ~ */);

  md.core.ruler.push('heading_ids', (s) => {
    s.tokens.forEach((tok, i) => {
      if (tok.type !== 'heading_open') return;
      const inline = s.tokens[i + 1];
      const text = inline?.children
        ? inline.children.filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('')
        : inline?.content || '';
      tok.attrSet('id', slugify(text, currentSlugs));
    });
  });

  function renderDoc(content) {
    currentSlugs = new Map();
    const katexSlots = new Map();
    const nonce = Math.random().toString(36).slice(2, 10);
    let seq = 0;

    currentStash = (katexHtml, isDisplay) => {
      const id = `${DOC_ID_PREFIX}ks-${nonce}-${seq++}`;
      katexSlots.set(id, { html: katexHtml, display: isDisplay });
      const tag = isDisplay ? 'div' : 'span';
      return `<${tag} class="inkleaf-katex-slot" id="${id}"></${tag}>`;
    };

    try {
      const { meta, body } = splitFrontMatter(content);
      let html = md.render(body);
      if (meta && meta.length) {
        const rows = meta
          .map(([k, v]) => `<div><dt>${md.utils.escapeHtml(k)}</dt><dd>${md.utils.escapeHtml(v)}</dd></div>`)
          .join('');
        html = `<dl class="front-matter">${rows}</dl>` + html;
      }
      return { html, meta, katexSlots };
    } finally {
      currentStash = null;
    }
  }

  return { md, renderDoc };
}
