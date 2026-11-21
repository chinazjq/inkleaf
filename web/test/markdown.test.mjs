import test from 'node:test';
import assert from 'node:assert/strict';
import { DOC_ID_PREFIX, createMarkdownRenderer, slugify, splitFrontMatter } from '../src/markdown.js';

test('splitFrontMatter requires line-1 opening, clean close, and valid YAML lines', () => {
  const valid = '\uFEFF---\ntitle: "Hello World"\ntags:\n  - rust\n  - tauri\ndescription: |\n  line one\n  line two\n---\n\n# Body\n';
  const res = splitFrontMatter(valid);
  assert.deepEqual(res.meta, [
    ['title', 'Hello World'],
    ['tags', 'rust, tauri'],
    ['description', 'line one\nline two'],
  ]);
  assert.equal(res.body.trim(), '# Body');

  // Horizontal rule on line 1 followed later by prose and another rule must NOT be swallowed.
  const prose = '---\n\nSome paragraph text here.\n\n---\n\nMore prose.';
  assert.equal(splitFrontMatter(prose).meta, null);
  assert.equal(splitFrontMatter(prose).body, prose);

  // Unclosed front matter is ignored.
  const unclosed = '---\ntitle: Unclosed\n\n# Heading';
  assert.equal(splitFrontMatter(unclosed).meta, null);
});

test('slugify keeps CJK, deduplicates, and adds doc- prefix', () => {
  const slugs = new Map();
  assert.equal(slugify('中文 Heading!', slugs), `${DOC_ID_PREFIX}中文-heading`);
  assert.equal(slugify('中文 Heading!', slugs), `${DOC_ID_PREFIX}中文-heading-1`);
  assert.equal(slugify('???', slugs), `${DOC_ID_PREFIX}section`);
});

test('renderer supports mark, sup, sub, del, h1-h6 ids, and isolates KaTeX slots', () => {
  const { renderDoc } = createMarkdownRenderer();
  const md = [
    '# H1',
    '## H2',
    '### H3',
    '#### H4',
    '##### H5',
    '###### H6',
    '',
    '==mark==, H~2~O, x^2^, ~~del~~, and a === b.',
    '',
    'Inline $E=mc^2$ and block:',
    '',
    '$$\\sqrt{\\pi}$$',
    '',
    '```rust',
    'fn main() {}',
    '```',
  ].join('\n');

  const { html, katexSlots } = renderDoc(md);
  assert.match(html, /<h1 id="doc-h1">H1<\/h1>/);
  assert.match(html, /<h5 id="doc-h5">H5<\/h5>/);
  assert.match(html, /<h6 id="doc-h6">H6<\/h6>/);
  assert.match(html, /<mark>mark<\/mark>/);
  assert.match(html, /H<sub>2<\/sub>O/);
  assert.match(html, /x<sup>2<\/sup>/);
  assert.match(html, /<s>del<\/s>/);
  assert.doesNotMatch(html, /data-lang=/);
  assert.match(html, /<code class="hljs language-rust">/);
  assert.equal(katexSlots.size, 2);
});
