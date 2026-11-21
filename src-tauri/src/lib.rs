pub mod assets;
pub mod docs;
pub mod i18n;
pub mod settings;

use docs::{DocError, TextFormat};
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use serde::Serialize;
use settings::{Geometry, Settings};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_opener::OpenerExt;

type Watcher = Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>;

/// What one window is showing.
#[derive(Default)]
struct WinDoc {
    path: Option<PathBuf>,
    format: TextFormat,
    /// Hash of the text last read or written, so our own saves do not echo back as "changed on disk".
    last_hash: u64,
    dirty: bool,
    has_doc: bool,
    close_ok: bool,
    asking_close: bool,
    pending_open: Option<PathBuf>,
    watcher: Option<Watcher>,
}

struct AppState {
    docs: Mutex<HashMap<String, WinDoc>>,
    settings: Mutex<Settings>,
    counter: AtomicUsize,
}

impl AppState {
    fn lang(&self) -> &'static str {
        i18n::effective(&self.settings.lock().unwrap().language)
    }
    fn with_settings<T>(&self, f: impl FnOnce(&mut Settings) -> T) -> T {
        let mut s = self.settings.lock().unwrap();
        let out = f(&mut s);
        s.save();
        out
    }
}

fn hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

// ------------------------------------------------------------------ payloads

#[derive(Serialize, Clone)]
struct FileEntry {
    path: String,
    name: String,
}

#[derive(Serialize, Clone)]
struct DocPayload {
    path: String,
    dir: String,
    name: String,
    content: String,
    encoding: String,
    files: Vec<FileEntry>,
    recent: Vec<String>,
}

#[derive(Serialize)]
struct Boot {
    doc: Option<DocPayload>,
    error: Option<String>,
    recent: Vec<String>,
    language: String,
    system_language: String,
    images_anywhere: bool,
    remote_images: bool,
    version: String,
}

#[derive(Serialize)]
struct Saved {
    path: String,
    dir: String,
    name: String,
    notice: Option<String>,
    files: Vec<FileEntry>,
}

#[derive(Serialize, Clone)]
struct Changed {
    path: String,
    content: String,
}

fn doc_error(lang: &str, path: &Path, e: DocError) -> String {
    let p = path.display();
    match e {
        DocError::NotADocument => format!("{}{p}", i18n::t(lang, "err.not_doc")),
        DocError::TooLarge(_) => format!("{}{p}", i18n::t(lang, "err.too_large")),
        DocError::NotFound => format!("{}{p}", i18n::t(lang, "err.not_found")),
        DocError::IsDirectory => format!("{}{p}", i18n::t(lang, "err.is_dir")),
        DocError::Io(err) => format!("{}{err}", i18n::t(lang, "err.read")),
    }
}

fn list_markdown(dir: &Path) -> Vec<FileEntry> {
    let mut out: Vec<FileEntry> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let is_file = e.file_type().map(|t| t.is_file()).unwrap_or(false);
            (is_file && docs::is_doc(&p)).then(|| FileEntry {
                name: p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect();
    out.sort_by_key(|f| f.name.to_lowercase());
    out.truncate(1000);
    out
}

fn absolute(path: &Path) -> PathBuf {
    let p = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    dunce::canonicalize(&p).unwrap_or(p)
}

// ------------------------------------------------------------------ opening documents

fn load_into_window(app: &AppHandle, label: &str, path: &Path) -> Result<DocPayload, String> {
    let state = app.state::<AppState>();
    let lang = state.lang();
    let path = absolute(path);
    let (content, format) = match docs::read_doc(&path) {
        Ok(v) => v,
        Err(e) => {
            if matches!(e, DocError::NotFound) {
                state.with_settings(|s| s.remove_recent(&path.to_string_lossy()));
            }
            return Err(doc_error(lang, &path, e));
        }
    };
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let path_str = path.to_string_lossy().into_owned();
    let recent = state.with_settings(|s| {
        s.touch_recent(&path_str);
        s.recent.clone()
    });
    let watcher = watch(app, label, &path);
    {
        let mut docs = state.docs.lock().unwrap();
        let d = docs.entry(label.to_string()).or_default();
        d.path = Some(path.clone());
        d.format = format;
        d.last_hash = hash(&content);
        d.dirty = false;
        d.has_doc = true;
        d.watcher = watcher;
    }
    update_window_title(app, label);
    Ok(DocPayload {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
        path: path_str,
        content,
        encoding: format.encoding.name().to_string(),
        files: list_markdown(&dir),
        recent,
    })
}

/// Watches the document's folder: the document itself (live reload) and the list of Markdown files.
fn watch(app: &AppHandle, label: &str, path: &Path) -> Option<Watcher> {
    let dir = path.parent()?.to_path_buf();
    let target = path.to_path_buf();
    let app2 = app.clone();
    let label2 = label.to_string();
    let mut debouncer = new_debouncer(Duration::from_millis(180), move |res: DebounceEventResult| {
        let events = match res {
            Ok(notify_debouncer_mini::DebouncedEventBatch::Events(ev)) => ev,
            // Missed events: treat everything as changed.
            Ok(_) => vec![notify_debouncer_mini::DebouncedEvent::new(target.clone(), notify_debouncer_mini::DebouncedEventKind::Any)],
            Err(_) => return,
        };
        let mut doc_changed = false;
        let mut list_changed = false;
        for ev in &events {
            if ev.path.as_path() == target.as_path() || ev.path.eq_ignore_case(&target) {
                doc_changed = true;
            } else if docs::is_doc(&ev.path) {
                list_changed = true;
            }
        }
        let state = app2.state::<AppState>();
        if list_changed {
            let _ = app2.emit_to(&label2, "files-changed", list_markdown(&dir));
        }
        if !doc_changed {
            return;
        }
        // The editor that saved may still hold the file; retry a few times, then give up.
        for attempt in 0..5 {
            match docs::read_doc(&target) {
                Ok((content, format)) => {
                    let h = hash(&content);
                    let mut docs = state.docs.lock().unwrap();
                    let Some(d) = docs.get_mut(&label2) else { return };
                    if d.path.as_deref() != Some(target.as_path()) || d.last_hash == h {
                        return;
                    }
                    d.last_hash = h;
                    if !d.dirty {
                        d.format = format;
                    }
                    drop(docs);
                    let _ = app2.emit_to(&label2, "doc-changed", Changed { path: target.to_string_lossy().into_owned(), content });
                    return;
                }
                Err(DocError::NotFound) => {
                    let _ = app2.emit_to(&label2, "files-changed", list_markdown(&dir));
                    return;
                }
                Err(_) if attempt < 4 => std::thread::sleep(Duration::from_millis(150 * (attempt + 1) as u64)),
                Err(_) => return,
            }
        }
    })
    .ok()?;
    debouncer.watcher().watch(path.parent()?, RecursiveMode::NonRecursive).ok()?;
    Some(debouncer)
}

trait EqIgnoreCase {
    fn eq_ignore_case(&self, other: &Path) -> bool;
}
impl EqIgnoreCase for PathBuf {
    fn eq_ignore_case(&self, other: &Path) -> bool {
        self.to_string_lossy().to_lowercase() == other.to_string_lossy().to_lowercase()
    }
}

// ------------------------------------------------------------------ windows

fn window_for_path(app: &AppHandle, path: &Path) -> Option<String> {
    let state = app.state::<AppState>();
    let docs = state.docs.lock().unwrap();
    docs.iter()
        .find(|(_, d)| d.path.as_ref().map(|p| p.eq_ignore_case(path)).unwrap_or(false))
        .map(|(l, _)| l.clone())
}

fn focus(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Opens a file the way a double-click does: focus the window that already shows it, or open a new window.
fn open_from_shell(app: &AppHandle, path: Option<PathBuf>) {
    if let Some(p) = &path {
        let p = absolute(p);
        if let Some(label) = window_for_path(app, &p) {
            focus(app, &label);
            return;
        }
        let _ = create_window(app, Some(p));
        return;
    }
    let _ = create_window(app, None);
}

fn is_allowed_navigation(url: &Url) -> bool {
    let is_app = url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    is_app && matches!(url.path(), "/" | "/index.html")
}

fn update_window_title(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    let lang = state.lang();
    let title = {
        let docs = state.docs.lock().unwrap();
        match docs.get(label) {
            Some(d) if d.has_doc => {
                let name = d
                    .path
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| i18n::t(lang, "untitled").to_string());
                if d.dirty {
                    format!("● {name} — Inkleaf")
                } else {
                    format!("{name} — Inkleaf")
                }
            }
            _ => "Inkleaf".to_string(),
        }
    };
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_title(&title);
    }
}

/// 校验恢复的窗口逻辑坐标是否至少有可操作的区域落在当前连接的任一显示器范围内。
fn geometry_on_screen(app: &AppHandle, x: f64, y: f64, width: f64, height: f64) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }
    let win_right = x + width;
    let win_bottom = y + height;
    monitors.iter().any(|m| {
        let scale = m.scale_factor().max(0.1);
        let mx = m.position().x as f64 / scale;
        let my = m.position().y as f64 / scale;
        let mw = m.size().width as f64 / scale;
        let mh = m.size().height as f64 / scale;
        let overlap_w = win_right.min(mx + mw) - x.max(mx);
        let overlap_h = win_bottom.min(my + mh) - y.max(my);
        overlap_w >= 120.0 && overlap_h >= 80.0
    })
}

fn create_window(app: &AppHandle, path: Option<PathBuf>) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    let n = state.counter.fetch_add(1, Ordering::SeqCst);
    let label = format!("w{n}");
    let open_windows = state.docs.lock().unwrap().len();
    state
        .docs
        .lock()
        .unwrap()
        .insert(label.clone(), WinDoc { pending_open: path, ..Default::default() });

    let (geom, dark) = {
        let s = state.settings.lock().unwrap();
        (s.window.clone(), s.dark)
    };
    let bg = if dark { tauri::window::Color(0x16, 0x16, 0x16, 0xff) } else { tauri::window::Color(0xff, 0xff, 0xff, 0xff) };
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Inkleaf")
        .min_inner_size(480.0, 360.0)
        .data_directory(settings::data_dir().join("WebView2"))
        .background_color(bg)
        .theme(Some(if dark { Theme::Dark } else { Theme::Light }))
        .zoom_hotkeys_enabled(false)
        // The window only ever shows the app's own page; links are handled by the page and the host.
        .on_navigation(is_allowed_navigation)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    match geom {
        Some(g) if g.width >= 480.0 && g.height >= 360.0 => {
            let offset = (open_windows as f64) * 28.0;
            let tx = g.x + offset;
            let ty = g.y + offset;
            b = b.inner_size(g.width, g.height);
            if geometry_on_screen(app, tx, ty, g.width, g.height) {
                b = b.position(tx, ty);
            } else {
                b = b.center();
            }
            if g.maximized && open_windows == 0 {
                b = b.maximized(true);
            }
        }
        _ => {
            b = b.inner_size(1200.0, 820.0).center();
        }
    }
    let win = b.build()?;
    let app2 = app.clone();
    let label2 = label.clone();
    win.on_window_event(move |ev| on_window_event(&app2, &label2, ev));
    Ok(win)
}

fn remember_geometry(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let maximized = w.is_maximized().unwrap_or(false);
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else { return };
    let state = app.state::<AppState>();
    state.with_settings(|s| {
        let prev = s.window.clone();
        s.window = Some(if maximized {
            Geometry { maximized: true, ..prev.unwrap_or(Geometry { x: 100.0, y: 80.0, width: 1200.0, height: 820.0, maximized: true }) }
        } else {
            Geometry {
                x: pos.x as f64 / scale,
                y: pos.y as f64 / scale,
                width: size.width as f64 / scale,
                height: size.height as f64 / scale,
                maximized: false,
            }
        });
    });
}

fn on_window_event(app: &AppHandle, label: &str, ev: &WindowEvent) {
    let state = app.state::<AppState>();
    match ev {
        WindowEvent::CloseRequested { api, .. } => {
            let (dirty, ok, asking) = {
                let docs = state.docs.lock().unwrap();
                docs.get(label).map(|d| (d.dirty, d.close_ok, d.asking_close)).unwrap_or((false, true, false))
            };
            if dirty && !ok {
                api.prevent_close();
                if asking {
                    return;
                }
                if let Some(d) = state.docs.lock().unwrap().get_mut(label) {
                    d.asking_close = true;
                }
                let app2 = app.clone();
                let label2 = label.to_string();
                std::thread::spawn(move || {
                    let choice = ask_unsaved_blocking(&app2, &label2);
                    match choice {
                        "save" => {
                            if let Some(d) = app2.state::<AppState>().docs.lock().unwrap().get_mut(&label2) {
                                d.asking_close = false;
                            }
                            let _ = app2.emit_to(&label2, "save-and-close", ());
                        }
                        "discard" => {
                            if let Some(d) = app2.state::<AppState>().docs.lock().unwrap().get_mut(&label2) {
                                d.asking_close = false;
                                d.close_ok = true;
                            }
                            if let Some(w) = app2.get_webview_window(&label2) {
                                let _ = w.close();
                            }
                        }
                        _ => {
                            if let Some(d) = app2.state::<AppState>().docs.lock().unwrap().get_mut(&label2) {
                                d.asking_close = false;
                            }
                        }
                    }
                });
                return;
            }
            remember_geometry(app, label);
        }
        WindowEvent::Destroyed => {
            // Dropping the entry stops its file watcher.
            state.docs.lock().unwrap().remove(label);
        }
        _ => {}
    }
}

fn ask_unsaved_blocking(app: &AppHandle, label: &str) -> &'static str {
    let lang = app.state::<AppState>().lang();
    let save = i18n::t(lang, "unsaved.save").to_string();
    let discard = i18n::t(lang, "unsaved.discard").to_string();
    let mut dlg = app
        .dialog()
        .message(i18n::t(lang, "unsaved.body"))
        .title(i18n::t(lang, "unsaved.title"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(save.clone(), discard.clone(), i18n::t(lang, "cancel").into()));
    if let Some(w) = app.get_webview_window(label) {
        dlg = dlg.parent(&w);
    }
    match dlg.blocking_show_with_result() {
        MessageDialogResult::Yes => "save",
        MessageDialogResult::No => "discard",
        MessageDialogResult::Custom(s) if s == save => "save",
        MessageDialogResult::Custom(s) if s == discard => "discard",
        _ => "cancel",
    }
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn boot(window: WebviewWindow) -> Boot {
    let app = window.app_handle().clone();
    let state = app.state::<AppState>();
    let pending = state.docs.lock().unwrap().get_mut(window.label()).and_then(|d| d.pending_open.take());
    let (doc, error) = match pending {
        Some(p) => match load_into_window(&app, window.label(), &p) {
            Ok(d) => (Some(d), None),
            Err(e) => (None, Some(e)),
        },
        None => (None, None),
    };
    let s = state.settings.lock().unwrap().clone();
    Boot {
        doc,
        error,
        recent: s.recent.into_iter().filter(|p| Path::new(p).exists()).collect(),
        language: s.language,
        system_language: if i18n::system_is_chinese() { "zh-CN".into() } else { "en".into() },
        images_anywhere: s.images_anywhere,
        remote_images: s.remote_images,
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
fn open_doc(window: WebviewWindow, path: String) -> Result<Option<DocPayload>, String> {
    let app = window.app_handle();
    let abs = absolute(Path::new(&path));
    if let Some(existing) = window_for_path(app, &abs) {
        if existing != window.label() {
            focus(app, &existing);
            return Ok(None);
        }
    }
    load_into_window(app, window.label(), &abs).map(Some)
}

#[tauri::command]
fn reload_doc(window: WebviewWindow) -> Result<DocPayload, String> {
    let path = window.app_handle().state::<AppState>().docs.lock().unwrap().get(window.label()).and_then(|d| d.path.clone());
    match path {
        Some(p) => load_into_window(window.app_handle(), window.label(), &p),
        None => Err(String::new()),
    }
}

#[tauri::command]
async fn pick_doc(window: WebviewWindow) -> Result<Option<DocPayload>, String> {
    let app = window.app_handle();
    let lang = app.state::<AppState>().lang();
    let start = app.state::<AppState>().docs.lock().unwrap().get(window.label()).and_then(|d| d.path.as_ref()?.parent().map(Path::to_path_buf));
    let mut dlg = app
        .dialog()
        .file()
        .set_title(i18n::t(lang, "open.title"))
        .set_parent(&window)
        .add_filter(i18n::t(lang, "filter.markdown"), &["md", "markdown", "mdown", "mkd", "mkdn", "mdx"])
        .add_filter(i18n::t(lang, "filter.text"), &["txt"]);
    if let Some(dir) = start {
        dlg = dlg.set_directory(dir);
    }
    match dlg.blocking_pick_file().and_then(|f| f.into_path().ok()) {
        Some(p) => {
            let abs = absolute(&p);
            if let Some(existing) = window_for_path(app, &abs) {
                if existing != window.label() {
                    focus(app, &existing);
                    return Ok(None);
                }
            }
            load_into_window(app, window.label(), &abs).map(Some)
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn new_window(app: AppHandle, path: Option<String>) {
    open_from_shell(&app, path.map(PathBuf::from));
}

/// A new, unsaved document in this window.
#[tauri::command]
fn new_doc(window: WebviewWindow) {
    let app = window.app_handle();
    let state = app.state::<AppState>();
    if let Some(d) = state.docs.lock().unwrap().get_mut(window.label()) {
        d.path = None;
        d.format = TextFormat::default();
        d.watcher = None;
        d.dirty = false;
        d.has_doc = true;
        d.last_hash = 0;
    }
    update_window_title(app, window.label());
}

/// Closes the current document and returns the window to the welcome screen.
#[tauri::command]
fn close_doc(window: WebviewWindow) {
    let app = window.app_handle();
    let state = app.state::<AppState>();
    if let Some(d) = state.docs.lock().unwrap().get_mut(window.label()) {
        d.path = None;
        d.format = TextFormat::default();
        d.watcher = None;
        d.dirty = false;
        d.has_doc = false;
        d.last_hash = 0;
    }
    update_window_title(app, window.label());
}

fn write_doc(app: &AppHandle, label: &str, path: &Path, content: &str) -> Result<Saved, String> {
    let state = app.state::<AppState>();
    let lang = state.lang();
    let format = state.docs.lock().unwrap().get(label).map(|d| d.format).unwrap_or_default();
    let (bytes, used) = docs::encode(content, &format);
    docs::write_atomic(path, &bytes).map_err(|e| format!("{}{e}", i18n::t(lang, "err.save")))?;
    let canonical_buf = absolute(path);
    let path = canonical_buf.as_path();
    let notice = (used.encoding != format.encoding).then(|| i18n::t(lang, "notice.utf8").to_string());
    let path_str = path.to_string_lossy().into_owned();
    let same_path;
    {
        let mut docs = state.docs.lock().unwrap();
        let d = docs.entry(label.to_string()).or_default();
        same_path = d.path.as_ref().map(|p| p.eq_ignore_case(path)).unwrap_or(false);
        d.path = Some(path.to_path_buf());
        d.format = used;
        d.dirty = false;
        d.has_doc = true;
        let normalised = match used.eol {
            docs::Eol::Lf => content.replace("\r\n", "\n"),
            docs::Eol::Crlf => content.replace("\r\n", "\n").replace('\n', "\r\n"),
        };
        d.last_hash = hash(&normalised);
    }
    if !same_path {
        let w = watch(app, label, path);
        if let Some(d) = state.docs.lock().unwrap().get_mut(label) {
            d.watcher = w;
        }
    }
    state.with_settings(|s| s.touch_recent(&path_str));
    update_window_title(app, label);
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    Ok(Saved {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
        path: path_str,
        notice,
        files: list_markdown(&dir),
    })
}

fn pick_save_path(window: &WebviewWindow) -> Option<PathBuf> {
    let app = window.app_handle();
    let state = app.state::<AppState>();
    let lang = state.lang();
    let current = state.docs.lock().unwrap().get(window.label()).and_then(|d| d.path.clone());
    let mut dlg = app
        .dialog()
        .file()
        .set_title(i18n::t(lang, "save.title"))
        .set_parent(window)
        .add_filter(i18n::t(lang, "filter.markdown"), &["md", "markdown", "mdx"])
        .add_filter(i18n::t(lang, "filter.text"), &["txt"]);
    match &current {
        Some(p) => {
            if let Some(d) = p.parent() {
                dlg = dlg.set_directory(d);
            }
            dlg = dlg.set_file_name(p.file_name().unwrap_or_default().to_string_lossy());
        }
        None => dlg = dlg.set_file_name(format!("{}.md", i18n::t(lang, "untitled"))),
    }
    let mut p = dlg.blocking_save_file()?.into_path().ok()?;
    if !docs::is_doc(&p) {
        p.set_extension("md");
    }
    Some(p)
}

#[tauri::command]
async fn save_doc(window: WebviewWindow, content: String) -> Result<Option<Saved>, String> {
    let current = window.app_handle().state::<AppState>().docs.lock().unwrap().get(window.label()).and_then(|d| d.path.clone());
    let path = match current {
        Some(p) => p,
        None => match pick_save_path(&window) {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    write_doc(window.app_handle(), window.label(), &path, &content).map(Some)
}

#[tauri::command]
async fn save_doc_as(window: WebviewWindow, content: String) -> Result<Option<Saved>, String> {
    match pick_save_path(&window) {
        Some(p) => write_doc(window.app_handle(), window.label(), &p, &content).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn set_dirty(window: WebviewWindow, dirty: bool) {
    let app = window.app_handle();
    if let Some(d) = app.state::<AppState>().docs.lock().unwrap().get_mut(window.label()) {
        d.dirty = dirty;
    }
    update_window_title(app, window.label());
}

/// Asked by the page before replacing a document that has unsaved edits.
#[tauri::command]
async fn ask_unsaved(window: WebviewWindow) -> String {
    ask_unsaved_blocking(window.app_handle(), window.label()).to_string()
}

#[tauri::command]
fn close_window(window: WebviewWindow) {
    if let Some(d) = window.app_handle().state::<AppState>().docs.lock().unwrap().get_mut(window.label()) {
        d.close_ok = true;
    }
    let _ = window.close();
}

#[tauri::command]
fn list_files(window: WebviewWindow) -> Vec<FileEntry> {
    let dir = window.app_handle().state::<AppState>().docs.lock().unwrap().get(window.label()).and_then(|d| d.path.as_ref()?.parent().map(Path::to_path_buf));
    dir.map(|d| list_markdown(&d)).unwrap_or_default()
}

/// A link to a local file that is not a document: never executed, only shown in Explorer after the user agrees.
#[tauri::command]
async fn open_local(window: WebviewWindow, path: String) -> Result<(), String> {
    let app = window.app_handle();
    let lang = app.state::<AppState>().lang();
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(String::new());
    }
    if !p.exists() {
        return Err(format!("{}{}", i18n::t(lang, "err.not_found"), p.display()));
    }
    let show = i18n::t(lang, "local.show").to_string();
    let res = app
        .dialog()
        .message(format!("{}{}", i18n::t(lang, "local.body"), p.display()))
        .title(i18n::t(lang, "local.title"))
        .kind(MessageDialogKind::Warning)
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(show.clone(), i18n::t(lang, "cancel").into()))
        .blocking_show_with_result();
    let agreed = matches!(res, MessageDialogResult::Ok) || matches!(&res, MessageDialogResult::Custom(s) if *s == show);
    if agreed {
        app.opener().reveal_item_in_dir(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn reveal(window: WebviewWindow) -> Result<(), String> {
    let path = window.app_handle().state::<AppState>().docs.lock().unwrap().get(window.label()).and_then(|d| d.path.clone());
    if let Some(p) = path {
        window.app_handle().opener().reveal_item_in_dir(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn is_safe_external(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        && !url.chars().any(|c| c.is_control())
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !is_safe_external(&url) {
        return Err("blocked".into());
    }
    app.opener().open_url(url.trim(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_default_apps(app: AppHandle) -> Result<(), String> {
    app.opener().open_url("ms-settings:defaultapps", None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_theme(window: WebviewWindow, dark: bool) {
    let _ = window.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }));
    let bg = if dark { tauri::window::Color(0x16, 0x16, 0x16, 0xff) } else { tauri::window::Color(0xff, 0xff, 0xff, 0xff) };
    let _ = window.set_background_color(Some(bg));
    let state = window.app_handle().state::<AppState>();
    if state.settings.lock().unwrap().dark != dark {
        state.with_settings(|s| s.dark = dark);
    }
}

#[tauri::command]
fn set_language(app: AppHandle, language: String) {
    let language = match language.as_str() {
        "zh-CN" | "en" => language,
        _ => "auto".to_string(),
    };
    app.state::<AppState>().with_settings(|s| s.language = language);
    for label in app.webview_windows().keys() {
        update_window_title(&app, label);
    }
}

#[tauri::command]
fn set_images_anywhere(app: AppHandle, enabled: bool) {
    app.state::<AppState>().with_settings(|s| s.images_anywhere = enabled);
}

#[tauri::command]
fn set_remote_images(app: AppHandle, enabled: bool) {
    app.state::<AppState>().with_settings(|s| s.remote_images = enabled);
}

#[tauri::command]
fn get_third_party_licenses(app: AppHandle) -> String {
    if let Ok(path) = app.path().resolve("THIRD_PARTY_LICENSES.md", tauri::path::BaseDirectory::Resource) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            return text;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("THIRD_PARTY_LICENSES.md");
            if let Ok(text) = std::fs::read_to_string(&sibling) {
                return text;
            }
        }
    }
    include_str!("../../THIRD_PARTY_LICENSES.md").to_string()
}

#[tauri::command]
fn remove_recent(app: AppHandle, path: String) -> Vec<String> {
    app.state::<AppState>().with_settings(|s| {
        s.remove_recent(&path);
        s.recent.clone()
    })
}

#[tauri::command]
fn recent(app: AppHandle) -> Vec<String> {
    let s = app.state::<AppState>().settings.lock().unwrap().recent.clone();
    s.into_iter().filter(|p| Path::new(p).exists()).collect()
}

// ------------------------------------------------------------------ asset scheme

fn serve_asset(app: &AppHandle, label: &str, uri_path: &str) -> Response<Vec<u8>> {
    let deny = |code: StatusCode| Response::builder().status(code).body(Vec::new()).unwrap();
    let Some(requested) = assets::path_from_url_path(uri_path) else { return deny(StatusCode::BAD_REQUEST) };
    let state = app.state::<AppState>();
    let anywhere = state.settings.lock().unwrap().images_anywhere;
    let roots = state.docs.lock().unwrap().get(label).and_then(|d| d.path.as_deref().map(assets::roots_for)).unwrap_or_default();
    match assets::resolve(&requested, &roots, anywhere) {
        Ok(real) => match std::fs::read(&real) {
            Ok(bytes) => Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", assets::mime_for(&real))
                .header("Cache-Control", "no-cache")
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'")
                .body(bytes)
                .unwrap(),
            Err(_) => deny(StatusCode::NOT_FOUND),
        },
        Err(assets::AssetError::NotFound) => deny(StatusCode::NOT_FOUND),
        Err(_) => deny(StatusCode::FORBIDDEN),
    }
}

// ------------------------------------------------------------------ entry

fn file_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with("--") || Path::new(a).exists())
        .map(|a| {
            let p = PathBuf::from(a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = Settings::load();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = file_args(&argv, Path::new(&cwd));
            if files.is_empty() {
                // Launched again without a file: bring a window forward.
                let label = app.webview_windows().keys().next().cloned();
                match label {
                    Some(l) => focus(app, &l),
                    None => open_from_shell(app, None),
                }
            }
            for f in files {
                open_from_shell(app, Some(f));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { docs: Mutex::new(HashMap::new()), settings: Mutex::new(settings), counter: AtomicUsize::new(0) })
        .register_asynchronous_uri_scheme_protocol("inkleaf-asset", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let label = ctx.webview_label().to_string();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || responder.respond(serve_asset(&app, &label, &path)));
        })
        .invoke_handler(tauri::generate_handler![
            boot,
            open_doc,
            reload_doc,
            pick_doc,
            new_window,
            new_doc,
            close_doc,
            save_doc,
            save_doc_as,
            set_dirty,
            ask_unsaved,
            close_window,
            list_files,
            open_local,
            reveal,
            open_external,
            open_default_apps,
            set_theme,
            set_language,
            set_images_anywhere,
            set_remote_images,
            get_third_party_licenses,
            remove_recent,
            recent
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            let files = file_args(&args, &cwd);
            let handle = app.handle().clone();
            if files.is_empty() {
                create_window(&handle, None)?;
            }
            for f in files {
                open_from_shell(&handle, Some(f));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Inkleaf");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links_are_limited() {
        assert!(is_safe_external("https://example.com/a?b#c"));
        assert!(is_safe_external("mailto:a@b.c"));
        assert!(!is_safe_external("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_safe_external("javascript:alert(1)"));
        assert!(!is_safe_external("ms-settings:defaultapps"));
        assert!(!is_safe_external("C:\\evil.bat"));
        assert!(!is_safe_external("https://example.com/\nfoo"));
    }

    #[test]
    fn command_line_files() {
        let cwd = Path::new(r"C:\work");
        let args = vec!["inkleaf.exe".to_string(), "notes.md".into(), r"D:\a.md".into(), "--flag".into()];
        assert_eq!(file_args(&args, cwd), vec![PathBuf::from(r"C:\work\notes.md"), PathBuf::from(r"D:\a.md")]);
    }

    #[test]
    fn navigation_locked_to_index() {
        assert!(is_allowed_navigation(&Url::parse("tauri://localhost/index.html").unwrap()));
        assert!(is_allowed_navigation(&Url::parse("http://tauri.localhost/").unwrap()));
        assert!(is_allowed_navigation(&Url::parse("http://tauri.localhost/index.html").unwrap()));
        assert!(is_allowed_navigation(&Url::parse("https://tauri.localhost/index.html").unwrap()));
        assert!(!is_allowed_navigation(&Url::parse("http://tauri.localhost/mermaid.min.js").unwrap()));
        assert!(!is_allowed_navigation(&Url::parse("http://tauri.localhost/sample.md").unwrap()));
        assert!(!is_allowed_navigation(&Url::parse("https://example.com/").unwrap()));
        assert!(!is_allowed_navigation(&Url::parse("file:///C:/Windows/win.ini").unwrap()));
    }
}
