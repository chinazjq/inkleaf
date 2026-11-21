//! 应用配置与运行环境路径解析：优先使用程序同目录下的 `settings.json` 与 `data/`，仅在不可写或 Cargo 构建目录下回退到系统用户目录。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const MAX_RECENT: usize = 15;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub recent: Vec<String>,
    pub window: Option<Geometry>,
    pub dark: bool,
    /// "auto", "zh-CN" or "en".
    pub language: String,
    /// Show local pictures from anywhere on this computer, not only near the document.
    pub images_anywhere: bool,
    /// Always load remote http/https images without asking per document.
    pub remote_images: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            recent: Vec::new(),
            window: None,
            dark: false,
            language: "auto".into(),
            images_anywhere: false,
            remote_images: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoragePaths {
    portable: bool,
    settings_file: PathBuf,
    data_dir: PathBuf,
}

static STORAGE_PATHS: OnceLock<StoragePaths> = OnceLock::new();

fn fallback_config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Inkleaf")
}

fn fallback_data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Inkleaf")
}

/// 判断目录是否为 Cargo 编译构建产物目录，避免开发运行或单元测试污染构建缓存。
fn is_cargo_target_dir(dir: &Path) -> bool {
    if dir.join(".cargo-lock").exists() || dir.join(".cargo-build-lock").exists() {
        return true;
    }
    let name_is_cargo_sub = dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| matches!(n, "deps" | "examples"))
        .unwrap_or(false);
    if name_is_cargo_sub {
        return true;
    }
    let has_target_tag = |p: &Path| p.join("CACHEDIR.TAG").exists();
    dir.parent().map(has_target_tag).unwrap_or(false)
        || dir.parent().and_then(|p| p.parent()).map(has_target_tag).unwrap_or(false)
        || dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).map(has_target_tag).unwrap_or(false)
}

/// 探测程序所在目录是否可写入配置文件与创建 `data` 运行环境子目录。
fn can_write_in_dir(dir: &Path) -> bool {
    let probe = dir.join(format!(".inkleaf-write-probe-{}", std::process::id()));
    let file_ok = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .is_ok();
    if !file_ok {
        return false;
    }
    let _ = std::fs::remove_file(&probe);
    std::fs::create_dir_all(dir.join("data")).is_ok()
}

fn resolve_storage_for_exe_dir(exe_dir: Option<&Path>) -> StoragePaths {
    if let Some(dir) = exe_dir {
        if !is_cargo_target_dir(dir) && can_write_in_dir(dir) {
            return StoragePaths {
                portable: true,
                settings_file: dir.join("settings.json"),
                data_dir: dir.join("data"),
            };
        }
    }
    StoragePaths {
        portable: false,
        settings_file: fallback_config_dir().join("settings.json"),
        data_dir: fallback_data_dir(),
    }
}

fn storage_paths() -> &'static StoragePaths {
    STORAGE_PATHS.get_or_init(|| {
        let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
        resolve_storage_for_exe_dir(exe_dir.as_deref())
    })
}

pub fn is_portable_mode() -> bool {
    storage_paths().portable
}

pub fn settings_file() -> PathBuf {
    storage_paths().settings_file.clone()
}

pub fn config_dir() -> PathBuf {
    storage_paths().settings_file.parent().map(Path::to_path_buf).unwrap_or_else(fallback_config_dir)
}

pub fn data_dir() -> PathBuf {
    storage_paths().data_dir.clone()
}

fn eq_path_ignore_case(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

impl Settings {
    pub fn load() -> Settings {
        let path = settings_file();
        if !path.exists() {
            let defaults = Settings::default();
            // 同目录部署模式下首次启动自动生成可读默认配置，方便用户按需调整同目录环境。
            if is_portable_mode() {
                defaults.save();
            }
            return defaults;
        }
        Self::load_from(&path)
    }

    pub fn load_from(path: &std::path::Path) -> Settings {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let path = settings_file();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        self.save_to(&path);
    }

    pub fn save_to(&self, path: &std::path::Path) {
        if let Ok(json) = serde_json::to_vec_pretty(self) {
            let _ = crate::docs::write_atomic(path, &json);
        }
    }

    /// Moves a path to the front of the recent list (case-insensitive on Windows).
    pub fn touch_recent(&mut self, path: &str) {
        self.recent.retain(|p| !eq_path_ignore_case(p, path));
        self.recent.insert(0, path.to_string());
        self.recent.truncate(MAX_RECENT);
    }

    pub fn remove_recent(&mut self, path: &str) {
        self.recent.retain(|p| !eq_path_ignore_case(p, path));
    }

    /// Merges entries from another recent list, keeping existing order first and deduplicating case-insensitively.
    pub fn merge_recent(&mut self, other: &[String]) {
        for item in other {
            if self.recent.len() >= MAX_RECENT {
                break;
            }
            if !self.recent.iter().any(|p| eq_path_ignore_case(p, item)) {
                self.recent.push(item.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_list_is_ordered_unique_and_capped() {
        let mut s = Settings::default();
        for i in 0..20 {
            s.touch_recent(&format!(r"C:\n\{i}.md"));
        }
        assert_eq!(s.recent.len(), MAX_RECENT);
        assert_eq!(s.recent[0], r"C:\n\19.md");
        s.touch_recent(r"c:\N\10.MD");
        assert_eq!(s.recent[0], r"c:\N\10.MD");
        assert_eq!(s.recent.iter().filter(|p| p.eq_ignore_ascii_case(r"C:\n\10.md")).count(), 1);
        s.remove_recent(r"C:\N\10.md");
        assert!(!s.recent.iter().any(|p| p.eq_ignore_ascii_case(r"C:\n\10.md")));
    }

    #[test]
    fn round_trip_and_bad_file() {
        let dir = std::env::temp_dir().join(format!("inkleaf-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("settings.json");
        let mut s = Settings::default();
        s.dark = true;
        s.language = "en".into();
        s.touch_recent(r"D:\a.md");
        s.save_to(&p);
        assert_eq!(Settings::load_from(&p), s);
        std::fs::write(&p, "{ not json").unwrap();
        assert_eq!(Settings::load_from(&p), Settings::default());
        // Unknown and missing fields are tolerated.
        std::fs::write(&p, r#"{"dark":true,"future":1}"#).unwrap();
        let s2 = Settings::load_from(&p);
        assert!(s2.dark);
        assert_eq!(s2.language, "auto");
        assert!(!s2.remote_images);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_recent_preserves_order_and_dedups() {
        let mut s = Settings::default();
        s.touch_recent(r"C:\docs\a.md");
        s.touch_recent(r"C:\docs\b.md");
        s.merge_recent(&[r"c:\DOCS\A.md".into(), r"D:\notes\c.md".into(), r"D:\notes\d.md".into()]);
        assert_eq!(s.recent, vec![r"C:\docs\b.md", r"C:\docs\a.md", r"D:\notes\c.md", r"D:\notes\d.md"]);

        for i in 0..MAX_RECENT {
            s.touch_recent(&format!(r"C:\full\{i}.md"));
        }
        let before = s.recent.clone();
        s.merge_recent(&[r"D:\extra.md".into()]);
        assert_eq!(s.recent, before);
        assert_eq!(s.recent.len(), MAX_RECENT);
    }

    #[test]
    fn resolves_colocated_storage_for_writable_install_dir() {
        let dir = std::env::temp_dir().join(format!("inkleaf-portable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let paths = resolve_storage_for_exe_dir(Some(&dir));
        assert!(paths.portable);
        assert_eq!(paths.settings_file, dir.join("settings.json"));
        assert_eq!(paths.data_dir, dir.join("data"));
        assert!(dir.join("data").is_dir());

        let mut s = Settings::default();
        s.dark = true;
        s.language = "zh-CN".into();
        s.save_to(&paths.settings_file);
        assert_eq!(Settings::load_from(&paths.settings_file), s);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_colocated_storage_for_cargo_target_dirs() {
        let dir = std::env::temp_dir().join(format!("inkleaf-cargo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let release_dir = dir.join("release");
        std::fs::create_dir_all(&release_dir).unwrap();
        std::fs::write(dir.join("CACHEDIR.TAG"), b"Signature: 8a477f597d28d172789f06886806bc55\n").unwrap();

        assert!(is_cargo_target_dir(&release_dir));
        let paths = resolve_storage_for_exe_dir(Some(&release_dir));
        assert!(!paths.portable);
        assert_ne!(paths.settings_file, release_dir.join("settings.json"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
