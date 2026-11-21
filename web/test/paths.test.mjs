import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOC_EXT_RE,
  assetUrl,
  isExternalUrl,
  isFileUrl,
  resolveMediaPath,
  resolvePath,
  safeDecodeURIComponent,
  splitHash,
} from '../src/paths.js';

test('resolvePath handles drive-relative, absolute, traversal, and special characters', () => {
  assert.equal(resolvePath('notes/intro.md', 'C:\\docs\\guide'), 'C:\\docs\\guide\\notes\\intro.md');
  assert.equal(resolvePath('../img/a%20%231%25.png', 'C:\\docs\\guide'), 'C:\\docs\\img\\a #1%.png');
  assert.equal(resolvePath('100%.png', 'C:\\docs'), 'C:\\docs\\100%.png');
  assert.equal(resolvePath('..\\..\\..\\..\\secret.md', 'C:\\docs\\sub'), 'C:\\secret.md');
  assert.equal(resolvePath('/root-rel.md', 'D:\\workspace\\sub'), 'D:\\root-rel.md');
  assert.equal(resolvePath('D:/a/b/../c.md', 'C:\\docs'), 'D:\\a\\c.md');
});

test('resolvePath handles UNC paths and prevents escaping share root', () => {
  assert.equal(resolvePath('fig/diagram.png', '\\\\server\\share\\notes'), '\\\\server\\share\\notes\\fig\\diagram.png');
  assert.equal(resolvePath('../../../../secret.png', '\\\\server\\share\\notes'), '\\\\server\\share\\secret.png');
  assert.equal(resolvePath('\\\\nas\\team\\a\\..\\b.md', 'C:\\docs'), '\\\\nas\\team\\b.md');
});

test('resolvePath rejects file:, external, and script URLs', () => {
  assert.equal(resolvePath('file:///C:/Windows/System32/calc.exe', 'C:\\docs'), null);
  assert.equal(resolvePath('javascript:alert(1)', 'C:\\docs'), null);
  assert.equal(resolvePath('https://example.com/a.md', 'C:\\docs'), null);
  assert.equal(isFileUrl('FILE:///C:/a.exe'), true);
  assert.equal(isExternalUrl('https://example.com'), true);
  assert.equal(isExternalUrl('mailto:user@example.com'), true);
  assert.equal(isExternalUrl('file:///C:/a.exe'), false);
});

test('resolveMediaPath strips ?query and #hash suffixes', () => {
  assert.equal(resolveMediaPath('logo.png#gh-dark-mode-only', 'C:\\repo'), 'C:\\repo\\logo.png');
  assert.equal(resolveMediaPath('pic.png?raw=true#top', 'C:\\repo'), 'C:\\repo\\pic.png');
  assert.equal(resolveMediaPath('图%20%231%25%3F.png#frag', 'C:\\repo'), 'C:\\repo\\图 #1%?.png');
});

test('safeDecodeURIComponent never throws on bare percent signs', () => {
  assert.equal(safeDecodeURIComponent('#100%'), '#100%');
  assert.equal(safeDecodeURIComponent('#%ZZ'), '#%ZZ');
  assert.equal(safeDecodeURIComponent('a%20100%'), 'a 100%');
  assert.equal(safeDecodeURIComponent('%E4%B8%AD%E6%96%87'), '中文');
  assert.deepEqual(splitHash('notes.md#heading'), ['notes.md', 'heading']);
});

test('assetUrl encodes Windows and UNC paths for inkleaf-asset scheme', () => {
  assert.equal(
    assetUrl('C:\\docs\\图 #1%?.png'),
    'http://inkleaf-asset.localhost/C%3A%5Cdocs%5C%E5%9B%BE%20%231%25%3F.png',
  );
  assert.equal(
    assetUrl('\\\\server\\share\\a.png'),
    'http://inkleaf-asset.localhost/%5C%5Cserver%5Cshare%5Ca.png',
  );
});

test('DOC_EXT_RE includes mdx and rejects executables', () => {
  for (const ok of ['a.md', 'b.markdown', 'c.mdown', 'd.mkd', 'e.mkdn', 'f.mdx', 'g.txt', 'H.MDX']) {
    assert.equal(DOC_EXT_RE.test(ok), true, ok);
  }
  for (const bad of ['a.bat', 'b.exe', 'c.ps1', 'd.png', 'e.html']) {
    assert.equal(DOC_EXT_RE.test(bad), false, bad);
  }
});
