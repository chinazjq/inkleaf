#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

VERSION="$(node -p "require('./package.json').version")"
APP_PATH="${1:-${ROOT_DIR}/src-tauri/target/universal-apple-darwin/release/bundle/macos/Inkleaf.app}"
OUT_DMG="${2:-${ROOT_DIR}/release-assets/Inkleaf_${VERSION}_macos_universal.dmg}"

if [ ! -d "${APP_PATH}" ]; then
  echo "Error: Inkleaf.app not found at ${APP_PATH}" >&2
  exit 1
fi

mkdir -p "$(dirname "${OUT_DMG}")"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/inkleaf-dmg.XXXXXX")"
trap 'rm -rf "${STAGE_DIR}"' EXIT

echo "==> Ad-hoc signing Inkleaf.app"
codesign --force --deep --sign - "${APP_PATH}"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

echo "==> Staging DMG contents"
ditto "${APP_PATH}" "${STAGE_DIR}/Inkleaf.app"
ln -s /Applications "${STAGE_DIR}/Applications"
cp "${ROOT_DIR}/THIRD_PARTY_LICENSES.md" "${STAGE_DIR}/THIRD_PARTY_LICENSES.md"

INSTALL_SCRIPT="${STAGE_DIR}/一键安装 Inkleaf (Install).command"
cat << 'EOF' > "${INSTALL_SCRIPT}"
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_APP="${SCRIPT_DIR}/Inkleaf.app"

if [ ! -d "${SRC_APP}" ]; then
  echo "未找到 Inkleaf.app / Inkleaf.app not found next to this script."
  exit 1
fi

echo "正在安装 Inkleaf (墨页)..."
echo "Installing Inkleaf..."

DEST_DIR="/Applications"
DEST_APP="${DEST_DIR}/Inkleaf.app"

install_to_dir() {
  local target_dir="$1"
  local target_app="${target_dir}/Inkleaf.app"
  mkdir -p "${target_dir}"
  rm -rf "${target_app}"
  ditto "${SRC_APP}" "${target_app}"
  xattr -cr "${target_app}" 2>/dev/null || true
  codesign --force --deep --sign - "${target_app}" 2>/dev/null || true
}

if [ -w "${DEST_DIR}" ] && [ ! -e "${DEST_APP}" -o -w "${DEST_APP}" ]; then
  install_to_dir "${DEST_DIR}"
else
  echo "需要管理员权限写入 /Applications，正在请求授权（取消则自动安装至 ~/Applications）..."
  if osascript -e "do shell script \"rm -rf '/Applications/Inkleaf.app' && ditto '${SRC_APP}' '/Applications/Inkleaf.app' && xattr -cr '/Applications/Inkleaf.app' && codesign --force --deep --sign - '/Applications/Inkleaf.app'\" with administrator privileges" 2>/dev/null; then
    DEST_APP="/Applications/Inkleaf.app"
  else
    DEST_DIR="${HOME}/Applications"
    DEST_APP="${DEST_DIR}/Inkleaf.app"
    install_to_dir "${DEST_DIR}"
  fi
fi

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "${LSREGISTER}" ]; then
  "${LSREGISTER}" -f "${DEST_APP}" >/dev/null 2>&1 || true
fi

echo ""
echo "安装完成：${DEST_APP}"
echo "Installed to: ${DEST_APP}"
echo "正在启动 Inkleaf..."
open "${DEST_APP}"
EOF

chmod +x "${INSTALL_SCRIPT}"

echo "==> Creating DMG image at ${OUT_DMG}"
rm -f "${OUT_DMG}"
hdiutil create \
  -volname "Inkleaf" \
  -srcfolder "${STAGE_DIR}" \
  -ov \
  -format UDZO \
  "${OUT_DMG}"

echo "==> macOS DMG ready: ${OUT_DMG}"
