import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { createMarkdownRenderer } from '../src/markdown.js';
import { createSanitizer, sanitizeMermaidSource } from '../src/sanitizer.js';

const { window } = new JSDOM('');
const purify = createDOMPurify(window);
const sanitizer = createSanitizer(purify);
const renderer = createMarkdownRenderer();

function mount(frag) {
  const div = window.document.createElement('div');
  div.append(frag);
  return { root: div, html: div.innerHTML };
}

test('sanitizer neutralises all high-risk HTML, DOM clobbering, data-act, style, svg and dangerous URLs', () => {
  const payload = [
    '<div data-act="register">hijack</div>',
    '<style>body{display:none !important}</style>',
    '<div id="settings" name="find-input">fake</div>',
    '<a href="javascript:alert(1)">js</a>',
    '<a href="vbscript:msgbox(1)">vb</a>',
    '<a href="file:///C:/Windows/System32/calc.exe">calc</a>',
    '<svg onload="alert(1)"><circle r="5"/></svg>',
    '<div style="position:fixed;inset:0;z-index:9999">phish</div>',
  ].join('\n');

  const { fragment } = sanitizer.sanitizeDocument(payload);
  const { root, html: out } = mount(fragment);

  assert.equal(root.querySelector('[data-act]'), null);
  assert.equal(root.querySelector('style'), null);
  assert.equal(root.querySelector('#settings'), null);
  assert.notEqual(root.querySelector('#doc-settings'), null);
  assert.equal(root.querySelector('#doc-settings').getAttribute('name'), 'doc-find-input');
  assert.equal(root.querySelector('svg'), null);

  for (const a of root.querySelectorAll('a')) {
    assert.equal(a.hasAttribute('href'), false, `unexpected href on ${a.textContent}`);
  }
  assert.doesNotMatch(out, /position\s*:\s*fixed/i);
  assert.doesNotMatch(out, /javascript:/i);
  assert.doesNotMatch(out, /vbscript:/i);
  assert.doesNotMatch(out, /file:\/\/\//i);
});

test('sanitizer preserves prefixed anchor links, table alignment, and KaTeX math while blocking raw svg', () => {
  const src = [
    '# Title',
    '',
    'See [Title](#title) and footnote[^1].',
    '',
    '| A | B |',
    '| :--- | ---: |',
    '| 1 | 2 |',
    '',
    'Math: $\\sqrt{\\pi}$',
    '',
    '<svg onload="alert(2)"><rect width="10" height="10"/></svg>',
    '',
    '[^1]: Footnote body.',
  ].join('\n');

  const { html, katexSlots } = renderer.renderDoc(src);
  const { fragment } = sanitizer.sanitizeDocument(html, { katexSlots });
  const { root } = mount(fragment);

  assert.notEqual(root.querySelector('#doc-title'), null);
  const titleLink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent === 'Title');
  assert.equal(titleLink.getAttribute('href'), '#doc-title');

  const fnLink = root.querySelector('.footnote-ref a');
  assert.match(fnLink.getAttribute('href'), /^#doc-fn/);
  const fnTargetId = fnLink.getAttribute('href').slice(1);
  assert.notEqual(root.querySelector(`[id="${fnTargetId}"]`), null);

  const alignStyles = Array.from(root.querySelectorAll('td[style], th[style]')).map((el) => el.getAttribute('style'));
  assert.equal(alignStyles.some((s) => /text-align:\s*right/i.test(s)), true);

  assert.notEqual(root.querySelector('.katex-mathml math'), null);
  assert.equal(root.querySelector('[onload]'), null);
  // Only KaTeX's own SVG inside .katex-html may exist; raw user <svg> is gone.
  for (const svg of root.querySelectorAll('svg')) {
    assert.notEqual(svg.closest('.katex'), null);
  }
});

test('sanitizer blocks remote images by default and allows when opted in', () => {
  const html = '<p><img src="https://tracker.example/pixel.png" alt="track"><img src="local.png" alt="ok"></p>';
  const blocked = sanitizer.sanitizeDocument(html, { allowRemoteImages: false });
  assert.equal(blocked.blockedRemoteCount, 1);
  assert.equal(blocked.remoteItems[0].url, 'https://tracker.example/pixel.png');
  const imgsBlocked = blocked.fragment.querySelectorAll('img');
  assert.equal(imgsBlocked[0].hasAttribute('src'), false);
  assert.equal(imgsBlocked[1].getAttribute('src'), 'local.png');

  const allowed = sanitizer.sanitizeDocument(html, { allowRemoteImages: true });
  assert.equal(allowed.blockedRemoteCount, 0);
  assert.equal(allowed.fragment.querySelectorAll('img')[0].getAttribute('src'), 'https://tracker.example/pixel.png');
});

test('mermaid guards reject unsafe init directives, oversized diagrams, and sanitize svg output', () => {
  assert.throws(() => sanitizeMermaidSource('%%{init: {"themeCSS": "* { display: none }"}}%%\nflowchart LR\nA-->B'));
  assert.throws(() => sanitizeMermaidSource('A'.repeat(60000)));
  assert.doesNotThrow(() => sanitizeMermaidSource('flowchart LR\nA-->B'));

  const dirtySvg = '<svg id="doc-mmd-1" onload="alert(1)"><style>@import "https://evil.test/x.css"; .node { fill: #fff; background: url(https://evil.test/p); }</style><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><g><rect width="10" height="10"/></g></svg>';
  const frag = sanitizer.sanitizeMermaidSvg(dirtySvg, 'doc-mmd-1');
  const { html: out } = mount(frag);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /onload=/i);
  assert.doesNotMatch(out, /foreignObject/i);
  assert.doesNotMatch(out, /@import/i);
  assert.doesNotMatch(out, /url\(/i);
  assert.match(out, /#doc-mmd-1 \.node/);
});

test('documents cannot borrow app classes, while renderer classes survive', () => {
  const payload = [
    '<div id="a" class="lightbox open">fake overlay</div>',
    '<div id="b" class="toast show findbar popover">fake toast</div>',
    '<span id="c" class="hljs-keyword function_ evil">kw</span>',
    '<ul class="contains-task-list"><li id="d" class="task-list-item">t</li></ul>',
  ].join('\n');
  const { fragment } = sanitizer.sanitizeDocument(payload);
  const { root } = mount(fragment);
  assert.equal(root.querySelector('#doc-a').hasAttribute('class'), false);
  assert.equal(root.querySelector('#doc-b').hasAttribute('class'), false);
  assert.equal(root.querySelector('#doc-c').className, 'hljs-keyword function_');
  assert.equal(root.querySelector('#doc-d').className, 'task-list-item');
  assert.notEqual(root.querySelector('.contains-task-list'), null);
});

test('rendered Markdown keeps the classes its own styles need', () => {
  const md = '- [x] done\n\nText[^1]\n\n```js\nconst a = 1;\n```\n\n[^1]: note\n';
  const { html } = renderer.renderDoc ? renderer.renderDoc(md) : { html: renderer.render(md) };
  const { fragment } = sanitizer.sanitizeDocument(html);
  const { root } = mount(fragment);
  assert.notEqual(root.querySelector('.task-list-item'), null);
  assert.notEqual(root.querySelector('.footnotes, .footnote-ref'), null);
  assert.notEqual(root.querySelector('pre.code code.hljs'), null);
  assert.notEqual(root.querySelector('.hljs-keyword'), null);
});
