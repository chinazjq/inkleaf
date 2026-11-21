//! Reading and writing Markdown files: encoding detection, line endings, size limits, atomic saves.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Largest document Inkleaf will open.
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Extensions opened inside the app. Everything else is never read as a document.
pub const DOC_EXT: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdx", "txt"];

pub fn is_doc(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| DOC_EXT.iter().any(|d| d.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eol {
    Lf,
    Crlf,
}

/// How a file was stored on disk, so a save writes it back the same way.
#[derive(Clone, Copy, Debug)]
pub struct TextFormat {
    pub encoding: &'static Encoding,
    pub bom: bool,
    pub eol: Eol,
}

impl Default for TextFormat {
    fn default() -> Self {
        TextFormat { encoding: UTF_8, bom: false, eol: Eol::Lf }
    }
}

#[derive(Debug)]
pub enum DocError {
    NotADocument,
    TooLarge(u64),
    NotFound,
    IsDirectory,
    Io(io::Error),
}

/// Decodes bytes: a BOM wins; otherwise valid UTF-8; otherwise a detected legacy encoding.
pub fn decode(bytes: &[u8]) -> (String, TextFormat) {
    let (encoding, bom, body) = if let Some((enc, len)) = Encoding::for_bom(bytes) {
        (enc, true, &bytes[len..])
    } else if std::str::from_utf8(bytes).is_ok() {
        (UTF_8, false, bytes)
    } else {
        let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
        det.feed(bytes, true);
        (det.guess(None, chardetng::Utf8Detection::Allow), false, bytes)
    };
    let (text, _) = encoding.decode_without_bom_handling(body);
    let text = text.into_owned();
    let eol = if text.contains("\r\n") { Eol::Crlf } else { Eol::Lf };
    (text, TextFormat { encoding, bom, eol })
}

/// Encodes text in the original format. Returns the bytes and the format actually used:
/// when a character cannot be represented in a legacy encoding, the file becomes UTF-8.
pub fn encode(text: &str, fmt: &TextFormat) -> (Vec<u8>, TextFormat) {
    let normalised = text.replace("\r\n", "\n");
    let body = match fmt.eol {
        Eol::Lf => normalised,
        Eol::Crlf => normalised.replace('\n', "\r\n"),
    };
    let enc = fmt.encoding;
    if enc == UTF_16LE || enc == UTF_16BE {
        let mut out = Vec::with_capacity(body.len() * 2 + 2);
        let le = enc == UTF_16LE;
        if fmt.bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for unit in body.encode_utf16() {
            out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        return (out, *fmt);
    }
    if enc == UTF_8 {
        let mut out = Vec::with_capacity(body.len() + 3);
        if fmt.bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        out.extend_from_slice(body.as_bytes());
        return (out, *fmt);
    }
    let (bytes, _, had_errors) = enc.encode(&body);
    if had_errors {
        let utf8 = TextFormat { encoding: UTF_8, bom: false, eol: fmt.eol };
        return (body.into_bytes(), utf8);
    }
    (bytes.into_owned(), *fmt)
}

pub fn read_doc(path: &Path) -> Result<(String, TextFormat), DocError> {
    if path.is_dir() {
        return Err(DocError::IsDirectory);
    }
    if !is_doc(path) {
        return Err(DocError::NotADocument);
    }
    let meta = fs::metadata(path).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound { DocError::NotFound } else { DocError::Io(e) }
    })?;
    if meta.is_dir() {
        return Err(DocError::IsDirectory);
    }
    if meta.len() > MAX_BYTES {
        return Err(DocError::TooLarge(meta.len()));
    }
    let bytes = fs::read(path).map_err(DocError::Io)?;
    Ok(decode(&bytes))
}

/// Writes through a temporary file in the same folder, then renames it over the target,
/// so a crash or a full disk never leaves a half-written document.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent folder"))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("document");
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp: PathBuf = dir.join(format!(".{name}.inkleaf-{}-{seq}.tmp", std::process::id()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::GBK;

    #[test]
    fn utf8_plain_and_bom() {
        let (t, f) = decode("# 标题\n".as_bytes());
        assert_eq!(t, "# 标题\n");
        assert_eq!(f.encoding, UTF_8);
        assert!(!f.bom);
        let (t, f) = decode(b"\xEF\xBB\xBF# a\r\n");
        assert_eq!(t, "# a\r\n");
        assert!(f.bom);
        assert_eq!(f.eol, Eol::Crlf);
    }

    #[test]
    fn utf16_round_trip() {
        let fmt = TextFormat { encoding: UTF_16LE, bom: true, eol: Eol::Crlf };
        let (bytes, used) = encode("第一行\n第二行\n", &fmt);
        assert_eq!(used.encoding, UTF_16LE);
        let (t, f) = decode(&bytes);
        assert_eq!(t, "第一行\r\n第二行\r\n");
        assert_eq!(f.encoding, UTF_16LE);
        assert_eq!(f.eol, Eol::Crlf);
    }

    #[test]
    fn detects_gbk() {
        let src = "# GBK 编码\n\n这是一份用 GBK 编码保存的中文文件，用来测试编码识别是否正确。\n";
        let (bytes, _, _) = GBK.encode(src);
        let (t, f) = decode(&bytes);
        assert_eq!(t, src);
        assert_ne!(f.encoding, UTF_8);
        let (again, used) = encode(&t, &f);
        assert_eq!(used.encoding, f.encoding);
        assert_eq!(again, bytes.into_owned());
    }

    #[test]
    fn unmappable_falls_back_to_utf8() {
        let (_, f) = decode(&GBK.encode("中文内容，足够长以便识别编码。中文内容，足够长以便识别编码。").0);
        let (bytes, used) = encode("emoji 😀 不在 GBK 里", &f);
        assert_eq!(used.encoding, UTF_8);
        assert_eq!(String::from_utf8(bytes).unwrap(), "emoji 😀 不在 GBK 里");
    }

    #[test]
    fn keeps_line_endings() {
        let fmt = TextFormat { encoding: UTF_8, bom: false, eol: Eol::Crlf };
        let (bytes, _) = encode("a\nb\r\nc", &fmt);
        assert_eq!(bytes, b"a\r\nb\r\nc");
    }

    #[test]
    fn only_documents_and_size_limit() {
        assert!(is_doc(Path::new("a.MD")));
        assert!(is_doc(Path::new("notes.mdx")));
        assert!(!is_doc(Path::new("evil.bat")));
        assert!(!is_doc(Path::new("id_rsa")));
        let dir = std::env::temp_dir().join(format!("inkleaf-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.md");
        let f = fs::File::create(&big).unwrap();
        f.set_len(MAX_BYTES + 1).unwrap();
        assert!(matches!(read_doc(&big), Err(DocError::TooLarge(_))));
        assert!(matches!(read_doc(&dir.join("missing.md")), Err(DocError::NotFound)));
        assert!(matches!(read_doc(&dir.join("x.exe")), Err(DocError::NotADocument)));
        let ok = dir.join("ok.md");
        write_atomic(&ok, b"# hi\n").unwrap();
        write_atomic(&ok, b"# hello\n").unwrap();
        assert_eq!(read_doc(&ok).unwrap().0, "# hello\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn directory_returns_is_dir() {
        let dir = std::env::temp_dir().join(format!("inkleaf-dir-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(matches!(read_doc(&dir), Err(DocError::IsDirectory)));
        let _ = fs::remove_dir_all(&dir);
    }
}
