// 一键校验构建产物、测试并生成根目录 release/ 安装包、便携包与校验文件。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version || '0.1.0';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const isWin = process.platform === 'win32';

function buildEnvWithCargo() {
  const env = { ...process.env };
  const cargoBin = join(homedir(), '.cargo', 'bin');
  const currentPath = env.PATH || env.Path || '';
  if (existsSync(cargoBin) && !currentPath.toLowerCase().includes(cargoBin.toLowerCase())) {
    const nextPath = currentPath ? `${cargoBin}${delimiter}${currentPath}` : cargoBin;
    env.PATH = nextPath;
    if ('Path' in env) env.Path = nextPath;
  }
  return env;
}

const env = buildEnvWithCargo();

function runStep(label, cmd, args, { shell = false } = {}) {
  console.log(`\n==> ${label}`);
  execFileSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell });
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex').toLowerCase();
}

function packZip(sourceParentDir, folderName, zipPath) {
  if (isWin) {
    try {
      execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', sourceParentDir, folderName], {
        cwd: root,
        env,
        stdio: 'inherit',
      });
      return;
    } catch {
      const srcGlob = join(sourceParentDir, folderName).replace(/'/g, "''");
      const dstZip = zipPath.replace(/'/g, "''");
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Compress-Archive -Path '${srcGlob}' -DestinationPath '${dstZip}' -Force`],
        { cwd: root, env, stdio: 'inherit' },
      );
      return;
    }
  }
  execFileSync('zip', ['-r', zipPath, folderName], { cwd: sourceParentDir, env, stdio: 'inherit' });
}

// 1. 生成许可证声明、打包前端并运行全量 JS + Rust 单测
runStep('生成第三方开源许可证清单', process.execPath, [join(root, 'scripts', 'third-party-licenses.mjs')]);
runStep('打包前端静态资源', process.execPath, [join(root, 'web', 'build.mjs')]);
runStep('运行前端单元测试', 'npm', ['test'], { shell: isWin });
runStep('运行 Rust 单元测试', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml']);
runStep('构建 Tauri 发布程序与 NSIS 一键安装器', 'npx', ['tauri', 'build'], { shell: isWin });

// 2. 整理 release/ 目录产物
const targetRelease = join(root, 'src-tauri', 'target', 'release');
const nsisDir = join(targetRelease, 'bundle', 'nsis');
const releaseDir = join(root, 'release');
const stageDir = join(releaseDir, '.portable-stage');
const portableRoot = join(stageDir, 'Inkleaf');

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(portableRoot, { recursive: true });

// 复制 NSIS 安装器
const setupFiles = existsSync(nsisDir)
  ? readdirSync(nsisDir).filter((f) => /-setup\.exe$/i.test(f))
  : [];
if (!setupFiles.length) {
  throw new Error(`未找到 NSIS 安装包，检查目录: ${nsisDir}`);
}
for (const f of setupFiles) {
  copyFileSync(join(nsisDir, f), join(releaseDir, f));
}

// 组装便携版压缩包（含主程序、默认同目录配置及许可文档）
const exeSrc = join(targetRelease, 'inkleaf.exe');
if (!existsSync(exeSrc)) {
  throw new Error(`未找到主程序二进制: ${exeSrc}`);
}
copyFileSync(exeSrc, join(portableRoot, 'inkleaf.exe'));
copyFileSync(join(root, 'THIRD_PARTY_LICENSES.md'), join(portableRoot, 'THIRD_PARTY_LICENSES.md'));

const defaultSettings = {
  recent: [],
  window: null,
  dark: false,
  language: 'auto',
  images_anywhere: false,
  remote_images: false,
};
writeFileSync(join(portableRoot, 'settings.json'), JSON.stringify(defaultSettings, null, 2) + '\n', 'utf8');

const portableZipName = `Inkleaf_${version}_${arch}-portable.zip`;
packZip(stageDir, 'Inkleaf', join(releaseDir, portableZipName));
rmSync(stageDir, { recursive: true, force: true });

// 生成 SHA256SUMS.txt
const artifacts = readdirSync(releaseDir)
  .filter((f) => f !== 'SHA256SUMS.txt')
  .sort();
const checksumLines = artifacts.map((f) => `${sha256File(join(releaseDir, f))}  ${f}`);
writeFileSync(join(releaseDir, 'SHA256SUMS.txt'), checksumLines.join('\n') + '\n', 'utf8');

console.log('\n==> Release 构建完成，产物位于 release/:');
for (const line of checksumLines) {
  console.log(`  ${line}`);
}
