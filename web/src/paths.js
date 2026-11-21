// Path, URL and URI-scheme helpers shared by the reader and unit tests.

export const DOC_EXT_RE = /\.(md|markdown|mdown|mkd|mkdn|mdx|txt)$/i;

export const isWinDriveAbs = (p) => /^[a-zA-Z]:[\\/]/.test(String(p || ''));

export const isUncPath = (p) => /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(String(p || ''));

export const isWinAbs = (p) => isWinDriveAbs(p) || isUncPath(p);

export const isPosixAbs = (p) => /^\/(?!\/)/.test(String(p || ''));

export const isExternalUrl = (u) => /^(https?:|mailto:)/i.test(String(u || '').trim());

export const isRemoteMediaUrl = (u) => /^https?:/i.test(String(u || '').trim());

export const isFileUrl = (u) => /^file:/i.test(String(u || '').trim());

/**
 * Decodes valid UTF-8 percent-encoded runs without throwing on bare '%' (e.g. "100%.png" or "#100%").
 */
export function safeDecodeURIComponent(str) {
  return String(str || '').replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
}

export function splitHash(href) {
  const s = String(href || '');
  const i = s.indexOf('#');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/**
 * Strips literal ?query and #hash suffixes from media references (e.g. "logo.png#gh-dark-mode-only").
 */
export function stripQueryAndHash(src) {
  const s = String(src || '').trim();
  const q = s.indexOf('?');
  const h = s.indexOf('#');
  const cut = q >= 0 && h >= 0 ? Math.min(q, h) : Math.max(q, h);
  return cut >= 0 ? s.slice(0, cut) : s;
}

function normalizeWinPath(raw) {
  const backslash = raw.replace(/\//g, '\\');
  if (backslash.startsWith('\\\\')) {
    const segs = backslash.slice(2).split('\\').filter((s) => s !== '' && s !== '.');
    if (segs.length < 2) return null;
    const server = segs[0];
    const share = segs[1];
    const rest = [];
    for (const seg of segs.slice(2)) {
      if (seg === '..') {
        if (rest.length > 0) rest.pop();
      } else {
        rest.push(seg);
      }
    }
    return `\\\\${server}\\${share}` + (rest.length ? `\\${rest.join('\\')}` : '');
  }

  const parts = [];
  for (const seg of backslash.split('\\')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  if (!parts.length) return null;
  if (parts.length === 1 && /^[a-zA-Z]:$/.test(parts[0])) return parts[0] + '\\';
  return parts.join('\\');
}

function normalizePosixPath(raw) {
  const slash = String(raw || '').replace(/\\/g, '/');
  const parts = [];
  for (const seg of slash.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return '/' + parts.join('/');
}

/**
 * Resolves a document-relative, POSIX-absolute or Windows-absolute path against baseDir.
 * Rejects file:, http:, https:, mailto:, javascript:, vbscript:, data: and blob: URLs.
 */
export function resolvePath(rel, baseDir) {
  if (!rel) return null;
  const trimmed = String(rel).trim();
  if (!trimmed || isFileUrl(trimmed) || isExternalUrl(trimmed) || /^(javascript|vbscript|data|blob|tel):/i.test(trimmed)) {
    return null;
  }

  const rawDecoded = safeDecodeURIComponent(trimmed);
  if (baseDir && isPosixAbs(baseDir)) {
    if (isWinAbs(rawDecoded)) {
      return normalizeWinPath(rawDecoded.replace(/\//g, '\\'));
    }
    const slashDecoded = rawDecoded.replace(/\\/g, '/');
    if (slashDecoded.startsWith('/')) {
      return normalizePosixPath(slashDecoded);
    }
    const base = String(baseDir).replace(/\/+$/, '');
    return normalizePosixPath(`${base}/${slashDecoded}`);
  }

  const decoded = rawDecoded.replace(/\//g, '\\');
  if (isWinAbs(decoded)) {
    return normalizeWinPath(decoded);
  }
  if (!baseDir) {
    return isPosixAbs(rawDecoded) ? normalizePosixPath(rawDecoded) : null;
  }

  const base = String(baseDir).replace(/\//g, '\\').replace(/\\+$/, '');
  let combined;
  if (decoded.startsWith('\\')) {
    if (base.startsWith('\\\\')) {
      const segs = base.slice(2).split('\\').filter(Boolean);
      if (segs.length < 2) return null;
      combined = `\\\\${segs[0]}\\${segs[1]}${decoded}`;
    } else if (/^[a-zA-Z]:/.test(base)) {
      combined = base.slice(0, 2) + decoded;
    } else {
      return null;
    }
  } else {
    combined = `${base}\\${decoded}`;
  }
  return normalizeWinPath(combined);
}

export function resolveMediaPath(src, baseDir) {
  const clean = stripQueryAndHash(src);
  if (!clean) return null;
  return resolvePath(clean, baseDir);
}

export function assetUrl(absPath) {
  if (typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__?.convertFileSrc === 'function') {
    return window.__TAURI_INTERNALS__.convertFileSrc(absPath, 'inkleaf-asset');
  }
  const prefix = isPosixAbs(absPath) ? 'inkleaf-asset://localhost/' : 'http://inkleaf-asset.localhost/';
  return prefix + encodeURIComponent(absPath);
}

export function fileDirName(dir) {
  if (!dir) return '';
  const clean = String(dir).replace(/[\\/]+$/, '');
  if (isUncPath(clean) && clean.slice(2).split(/[\\/]/).length === 2) return clean;
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean;
}

export function splitFilePath(p) {
  const s = String(p || '');
  const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (idx < 0) return { name: s, dir: '' };
  return { name: s.slice(idx + 1), dir: s.slice(0, idx) };
}
