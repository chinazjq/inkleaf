//! The `inkleaf-asset` scheme: lets a document show its own pictures and nothing else.
//!
//! A request is served only when the file has a media extension and, after resolving
//! `..`, symbolic links and junctions, lies inside one of the allowed roots (the
//! document's folder and up to two folders above it), unless the user turned on
//! "local images from anywhere", in which case any media file may be shown.

use percent_encoding::percent_decode_str;
use std::path::{Path, PathBuf};

pub const MEDIA_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "mp4", "webm", "mp3", "ogg", "wav", "m4a",
];

/// How many folders above the document's own folder pictures may come from (`../assets`).
pub const ANCESTOR_LEVELS: usize = 2;

#[derive(Debug, PartialEq, Eq)]
pub enum AssetError {
    BadRequest,
    NotMedia,
    NotFound,
    Outside,
}

fn ext_of(p: &Path) -> Option<String> {
    p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase())
}

pub fn is_media(p: &Path) -> bool {
    ext_of(p).map(|e| MEDIA_EXT.contains(&e.as_str())).unwrap_or(false)
}

pub fn mime_for(p: &Path) -> &'static str {
    match ext_of(p).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("m4a") => "audio/mp4",
        _ => "application/octet-stream",
    }
}

/// The URL path is the whole absolute file path, percent-encoded as one segment.
pub fn path_from_url_path(url_path: &str) -> Option<PathBuf> {
    let raw = url_path.strip_prefix('/').unwrap_or(url_path);
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    let p = PathBuf::from(decoded.as_ref());
    if p.is_absolute() { Some(p) } else { None }
}

/// The folders a document may take pictures from.
pub fn roots_for(doc: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut cur = doc.parent();
    for _ in 0..=ANCESTOR_LEVELS {
        match cur {
            Some(dir) if dir.parent().is_some() && !matches!(dir.to_str(), Some("/Users" | "/home")) => {
                roots.push(dir.to_path_buf());
                cur = dir.parent();
            }
            // Never widen to a drive root, a bare UNC share, or Unix /Users /home roots.
            _ => break,
        }
    }
    roots
}

pub fn resolve(requested: &Path, roots: &[PathBuf], anywhere: bool) -> Result<PathBuf, AssetError> {
    if !requested.is_absolute() {
        return Err(AssetError::BadRequest);
    }
    if !is_media(requested) {
        return Err(AssetError::NotMedia);
    }
    let real = dunce::canonicalize(requested).map_err(|_| AssetError::NotFound)?;
    // The link target must be media too: a picture-named link to a key file is refused.
    if !is_media(&real) || !real.is_file() {
        return Err(AssetError::NotMedia);
    }
    if anywhere {
        return Ok(real);
    }
    for root in roots {
        if let Ok(r) = dunce::canonicalize(root) {
            if real.starts_with(&r) {
                return Ok(real);
            }
        }
    }
    Err(AssetError::Outside)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sandbox(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("inkleaf-assets-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("notes/deep/doc")).unwrap();
        fs::create_dir_all(d.join("secret")).unwrap();
        d
    }

    #[cfg(windows)]
    #[test]
    fn url_paths_decode_special_characters() {
        let p = path_from_url_path("/C%3A%5Cdocs%5C%E5%9B%BE%20%231%25%3F.png").unwrap();
        assert_eq!(p, PathBuf::from(r"C:\docs\图 #1%?.png"));
        let unc = path_from_url_path("/%5C%5Cserver%5Cshare%5Ca.png").unwrap();
        assert_eq!(unc, PathBuf::from(r"\\server\share\a.png"));
        assert!(path_from_url_path("/relative.png").is_none());
        assert!(path_from_url_path("/%FF%FE").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn unix_url_paths_decode_special_characters() {
        let p = path_from_url_path("/%2FUsers%2Falice%2Fdocs%2F%E5%9B%BE%20%231%25%3F.png").unwrap();
        assert_eq!(p, PathBuf::from("/Users/alice/docs/图 #1%?.png"));
        assert!(path_from_url_path("/relative.png").is_none());
        assert!(path_from_url_path("/%FF%FE").is_none());
    }

    #[test]
    fn serves_media_inside_roots_only() {
        let d = sandbox("roots");
        let doc = d.join("notes/deep/doc/readme.md");
        fs::write(&doc, "# x").unwrap();
        let near = d.join("notes/deep/doc/a #1%.png");
        let up = d.join("notes/deep/up.png");
        let up2 = d.join("notes/up2.png");
        let outside = d.join("secret/photo.png");
        for f in [&near, &up, &up2, &outside] {
            fs::write(f, b"\x89PNG").unwrap();
        }
        fs::write(d.join("secret/id_rsa"), b"key").unwrap();
        fs::write(d.join("notes/deep/doc/notes.txt"), b"text").unwrap();

        let roots = roots_for(&doc);
        assert_eq!(roots.len(), 3);
        assert!(resolve(&near, &roots, false).is_ok());
        assert!(resolve(&up, &roots, false).is_ok());
        assert!(resolve(&up2, &roots, false).is_ok());
        assert_eq!(resolve(&outside, &roots, false), Err(AssetError::Outside));
        // Traversal written into the path is resolved before the check.
        let sneaky = d.join("notes/deep/doc/../../../secret/photo.png");
        assert_eq!(resolve(&sneaky, &roots, false), Err(AssetError::Outside));
        // Non-media files are refused wherever they are.
        assert_eq!(resolve(&d.join("secret/id_rsa"), &roots, true), Err(AssetError::NotMedia));
        assert_eq!(resolve(&d.join("notes/deep/doc/notes.txt"), &roots, false), Err(AssetError::NotMedia));
        assert_eq!(resolve(&d.join("notes/deep/doc/missing.png"), &roots, false), Err(AssetError::NotFound));
        assert_eq!(resolve(Path::new("relative.png"), &roots, false), Err(AssetError::BadRequest));
        // The "anywhere" setting allows outside media, still only media.
        assert!(resolve(&outside, &roots, true).is_ok());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(windows)]
    #[test]
    fn roots_stop_before_drive_root() {
        let roots = roots_for(Path::new(r"C:\a.md"));
        assert!(roots.is_empty());
        let roots = roots_for(Path::new(r"C:\x\a.md"));
        assert_eq!(roots, vec![PathBuf::from(r"C:\x")]);
    }

    #[cfg(windows)]
    #[test]
    fn unc_roots_stop_before_share() {
        let roots = roots_for(Path::new(r"\\server\share\a.md"));
        assert!(roots.is_empty());
        let roots = roots_for(Path::new(r"\\server\share\notes\a.md"));
        assert_eq!(roots, vec![PathBuf::from(r"\\server\share\notes")]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_roots_stop_before_users_home() {
        assert!(roots_for(Path::new("/a.md")).is_empty());
        assert!(roots_for(Path::new("/Users/a.md")).is_empty());
        assert!(roots_for(Path::new("/home/a.md")).is_empty());
        let roots = roots_for(Path::new("/Users/alice/a.md"));
        assert_eq!(roots, vec![PathBuf::from("/Users/alice")]);
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime_for(Path::new("a.SVG")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("a.jpeg")), "image/jpeg");
    }
}
