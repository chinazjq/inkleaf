# Security Policy

## Threat Model

Inkleaf opens local Markdown files that may originate from untrusted sources (repositories, downloads, email attachments). Our security boundary assumes **document content is untrusted**:

1. **No arbitrary local file access**: `inkleaf-asset://` only serves allow-listed media extensions inside the active document's directory tree (up to 2 parent folders by default, unless the user explicitly enables *Local images: Anywhere*).
2. **No execution of local links**: non-document local links prompt a native OS confirmation dialog displaying the full path and only reveal the item in File Explorer. External links are restricted to `http:`, `https:`, and `mailto:`.
3. **HTML/SVG/CSS containment**: user HTML is sanitized with DOMPurify (`ALLOW_DATA_ATTR: false`, `<style>` and raw `<svg>` forbidden, `doc-` id/name prefixing), KaTeX output is slot-isolated, Mermaid runs in `strict` mode with limits and secondary SVG sanitization, and strict CSP disables inline scripts.
4. **Remote media privacy**: remote `http`/`https` images are blocked by default until allowed per document or globally in Preferences.

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, report them privately via GitHub Security Advisories (**Security -> Advisories -> Report a vulnerability**) on the repository, including:
- Affected version and OS build
- Minimal `.md` reproduction input or steps
- Expected vs. actual security impact

We will acknowledge reports within 72 hours and coordinate a fix before public disclosure.
