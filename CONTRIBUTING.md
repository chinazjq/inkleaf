# Contributing to Inkleaf

Thank you for contributing to **Inkleaf (墨页)**!

## Development Setup

- Windows 10 / 11 with Microsoft Edge WebView2 Runtime
- Node.js `>= 22.12.0`
- Rust `>= 1.80` (MSVC toolchain)

```powershell
npm ci
npm run dev
```

## Checks Before Opening a Pull Request

Please make sure all build steps and tests pass locally:

```powershell
npm run licenses
npm run build:web
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## Guidelines

- Keep the UI calm and achromatic (only `#1d5fbf` / `--link` carries color for interactive links).
- Any change to Markdown rendering, URL resolution, DOM sanitization, or custom URI handling **must** include regression tests in `web/test/` or `src-tauri/src/`.
- Never enable `ALLOW_DATA_ATTR`, inline `<script>`, `<style>` tags in user documents, or arbitrary file execution from document links.
- Keep both `zh-CN` and `en` entries updated in `web/src/i18n.js` and `src-tauri/src/i18n.rs` for any UI text changes.
- Follow `.editorconfig` (LF line endings for source files).
