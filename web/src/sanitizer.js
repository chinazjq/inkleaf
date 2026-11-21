// DOMPurify hardening for untrusted Markdown HTML, KaTeX slots and Mermaid SVGs.
import { isExternalUrl, isRemoteMediaUrl } from './paths.js';

export const DOC_ID_PREFIX = 'doc-';
export const MAX_MERMAID_TEXT = 50000;

// Classes produced by the Markdown renderer itself (markdown-it, footnotes, task lists, highlight.js, KaTeX slots).
const DOC_CLASS_RE = /^(?:mermaid-src|math-block|code|front-matter|inkleaf-katex-slot|hljs(?:-[\w-]+)?|[a-z]+_|language-[\w+#.-]+|footnotes?(?:-[\w-]+)?|footnote-[\w-]+|task-list-item(?:-[\w-]+)?|contains-task-list)$/;
const SAFE_ALIGN_RE =/^\s*text-align\s*:\s*(left|right|center|justify)\s*;?\s*$/i;
const SAFE_KATEX_STYLE_BAD_RE = /url\s*\(|@import|expression\s*\(|behavior\s*:|-moz-binding|position\s*:\s*fixed|z-index\s*:/i;

const hookedPurify = new WeakSet();
const activeHooks = new WeakMap();

function prefixDocId(val) {
  const s = String(val || '');
  if (!s) return s;
  return s.startsWith(DOC_ID_PREFIX) ? s : `${DOC_ID_PREFIX}${s}`;
}

function isSafeLinkHref(href) {
  const t = String(href || '').trim();
  if (!t) return false;
  if (t.startsWith('#')) return true;
  if (/^(javascript|vbscript|file|data):/i.test(t)) return false;
  return true;
}

function isSafeMediaSrc(src) {
  const t = String(src || '').trim();
  if (!t) return false;
  if (/^(javascript|vbscript|file):/i.test(t)) return false;
  return true;
}

function ensureHooks(purify) {
  if (hookedPurify.has(purify)) return;
  hookedPurify.add(purify);

  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const ctx = activeHooks.get(purify);
    if (!ctx) return;

    const attr = data.attrName.toLowerCase();
    const tag = node.tagName ? node.tagName.toLowerCase() : '';

    if (ctx.mode === 'katex') {
      if (attr === 'style') {
        if (SAFE_KATEX_STYLE_BAD_RE.test(data.attrValue)) {
          data.keepAttr = false;
        }
      } else if (attr === 'id' || attr === 'name') {
        data.attrValue = prefixDocId(data.attrValue);
      }
      return;
    }

    if (ctx.mode === 'mermaid') {
      if (attr === 'href' || attr === 'xlink:href' || attr === 'src') {
        data.keepAttr = false;
      } else if (attr === 'style' && SAFE_KATEX_STYLE_BAD_RE.test(data.attrValue)) {
        data.keepAttr = false;
      }
      return;
    }

    // Document HTML mode.
    if (attr === 'class') {
      // Only the renderer's own classes survive, so a document cannot borrow app classes
      // (lightbox, findbar, toast…) to draw fixed layers over the window.
      const kept = String(data.attrValue || '')
        .split(/\s+/)
        .filter((c) => DOC_CLASS_RE.test(c));
      if (kept.length) data.attrValue = kept.join(' ');
      else data.keepAttr = false;
      return;
    }

    if (attr === 'id' || attr === 'name' || attr === 'for') {
      data.attrValue = prefixDocId(data.attrValue);
      return;
    }

    if (attr === 'style') {
      if ((tag === 'td' || tag === 'th') && SAFE_ALIGN_RE.test(data.attrValue)) {
        return;
      }
      data.keepAttr = false;
      return;
    }

    if (tag === 'a' && attr === 'href') {
      const val = String(data.attrValue || '').trim();
      if (!isSafeLinkHref(val)) {
        data.keepAttr = false;
        return;
      }
      if (val.startsWith('#') && val.length > 1) {
        data.attrValue = '#' + prefixDocId(val.slice(1));
      }
      return;
    }

    if ((tag === 'img' || tag === 'video' || tag === 'audio' || tag === 'source') && (attr === 'src' || attr === 'poster')) {
      const val = String(data.attrValue || '').trim();
      if (!isSafeMediaSrc(val)) {
        data.keepAttr = false;
        return;
      }
      if (isRemoteMediaUrl(val) && !ctx.allowRemoteImages) {
        if (attr === 'src') {
          ctx.blockedRemote.set(node, { url: val, tag, alt: node.getAttribute('alt') || '' });
        }
        data.keepAttr = false;
      }
    }
  });
}

function cleanMermaidCss(cssText, diagramId) {
  const safeId = String(diagramId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const stripped = String(cssText || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]*;/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '');

  const safeBlocks = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(stripped)) !== null) {
    const rawSel = m[1].trim();
    const decls = m[2]
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d && !SAFE_KATEX_STYLE_BAD_RE.test(d));
    if (!decls.length) continue;

    // Keep selectors scoped to the diagram root id so Mermaid CSS can never affect app chrome.
    const scopedSel = rawSel
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (safeId && !s.startsWith(`#${safeId}`) ? `#${safeId} ${s}` : s))
      .join(', ');
    if (scopedSel) {
      safeBlocks.push(`${scopedSel} { ${decls.join('; ')} }`);
    }
  }
  return safeBlocks.join('\n');
}

export function sanitizeMermaidSource(src) {
  const text = String(src || '');
  if (text.length > MAX_MERMAID_TEXT) {
    throw new Error(`Mermaid source exceeds ${MAX_MERMAID_TEXT} characters`);
  }
  const initBlocks = text.match(/%%\{[\s\S]*?\}%%/g) || [];
  for (const block of initBlocks) {
    if (/themeCSS|securityLevel|["']?secure["']?\s*:|htmlLabels|maxTextSize|maxEdges|javascript:/i.test(block)) {
      throw new Error('Blocked unsafe Mermaid directive');
    }
  }
  return text;
}

export function createSanitizer(purify) {
  ensureHooks(purify);

  function sanitizeKatexFragment(katexHtml) {
    activeHooks.set(purify, { mode: 'katex' });
    try {
      return purify.sanitize(katexHtml, {
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: [
          'script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link',
          'a', 'img', 'video', 'audio', 'foreignObject', 'use', 'image', 'canvas', 'template',
        ],
        FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcdoc', 'formaction'],
        RETURN_DOM_FRAGMENT: true,
      });
    } finally {
      activeHooks.delete(purify);
    }
  }

  function sanitizeDocument(html, { allowRemoteImages = false, katexSlots = null } = {}) {
    const blockedRemote = new Map();
    activeHooks.set(purify, { mode: 'doc', allowRemoteImages, blockedRemote });
    let fragment;
    try {
      fragment = purify.sanitize(String(html || ''), {
        USE_PROFILES: { html: true, mathMl: true, svg: false },
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: [
          'script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link',
          'svg', 'canvas', 'template', 'noscript',
        ],
        FORBID_ATTR: ['srcdoc', 'formaction', 'xlink:href'],
        ADD_ATTR: ['target', 'checked', 'disabled'],
        RETURN_DOM_FRAGMENT: true,
      });
    } finally {
      activeHooks.delete(purify);
    }

    const remoteItems = [];
    for (const [el, info] of blockedRemote.entries()) {
      if (!el.isConnected && !fragment.contains(el)) continue;
      if (isExternalUrl(info.url)) {
        remoteItems.push({ el, ...info });
      }
    }

    if (katexSlots && katexSlots.size > 0) {
      const slots = fragment.querySelectorAll('.inkleaf-katex-slot[id]');
      for (const slot of slots) {
        const entry = katexSlots.get(slot.id);
        if (!entry) continue;
        const katexFrag = sanitizeKatexFragment(entry.html);
        slot.replaceWith(katexFrag);
      }
    }

    return {
      fragment,
      blockedRemoteCount: remoteItems.length,
      remoteItems,
    };
  }

  function sanitizeMermaidSvg(svgHtml, diagramId) {
    activeHooks.set(purify, { mode: 'mermaid' });
    let fragment;
    try {
      fragment = purify.sanitize(String(svgHtml || ''), {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ['style'],
        FORBID_TAGS: [
          'script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link',
          'foreignObject', 'animate', 'animateMotion', 'animateTransform', 'set', 'a', 'image', 'use',
        ],
        FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcdoc'],
        ALLOW_DATA_ATTR: false,
        RETURN_DOM_FRAGMENT: true,
      });
    } finally {
      activeHooks.delete(purify);
    }

    for (const styleEl of fragment.querySelectorAll('style')) {
      const cleaned = cleanMermaidCss(styleEl.textContent || '', diagramId);
      if (cleaned) {
        styleEl.textContent = cleaned;
      } else {
        styleEl.remove();
      }
    }
    return fragment;
  }

  return { sanitizeDocument, sanitizeMermaidSvg };
}
