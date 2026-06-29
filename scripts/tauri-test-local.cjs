#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_SERVER_INFO_PATH = path.join(ROOT, '.tmp', 'platform-dev', 'server.json');
const LOCAL_UI_DEV_SERVER_INFO_PATH = path.join(ROOT, '.tmp', 'platform-ui-dev', 'server.json');
const TEST_CONFIG_PATH = 'src-tauri/tauri.test.conf.json';
const PLATFORM_PACKAGE_TEST_INDEX_URL =
  'https://raw.githubusercontent.com/jlcodes99/cockpit-tools/platform-test/platform-packages/index.test.json';
const CODEX_API_SERVICE_PORT = process.env.COCKPIT_CODEX_API_SERVICE_PORT || '12345';

function fail(message) {
  console.error(`[tauri-test-local] ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  npm run tauri:test:local -- [options]

Options:
  --no-build         Launch the existing local Test build.
  --index-url <url>  Override local platform package index URL.
  --ui-dev           Load installed platform remote UI from the local platform:ui:dev server.
  --ui-dev-url <url> Override local platform UI dev base URL.

Before launching, run:
  npm run platform:dev:serve -- --platform <platformId>
  npm run tauri:test:ui
`);
}

function parseArgs(argv) {
  const args = {
    build: true,
    uiDev: false,
    extraLaunchArgs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--no-build') {
      args.build = false;
      continue;
    }
    if (arg === '--ui-dev') {
      args.uiDev = true;
      continue;
    }
    if (arg === '--index-url') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) fail('Missing value for --index-url');
      args.indexUrl = next;
      index += 1;
      continue;
    }
    if (arg === '--ui-dev-url') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) fail('Missing value for --ui-dev-url');
      args.uiDev = true;
      args.uiDevUrl = next;
      index += 1;
      continue;
    }
    args.extraLaunchArgs.push(arg);
  }
  return args;
}

function readLocalServerIndexUrl() {
  if (!fs.existsSync(LOCAL_SERVER_INFO_PATH)) {
    return null;
  }
  try {
    const info = JSON.parse(fs.readFileSync(LOCAL_SERVER_INFO_PATH, 'utf8'));
    return typeof info.indexUrl === 'string' && info.indexUrl ? info.indexUrl : null;
  } catch {
    return null;
  }
}

function readLocalUiDevBaseUrl() {
  if (!fs.existsSync(LOCAL_UI_DEV_SERVER_INFO_PATH)) {
    return null;
  }
  try {
    const info = JSON.parse(fs.readFileSync(LOCAL_UI_DEV_SERVER_INFO_PATH, 'utf8'));
    return typeof info.baseUrl === 'string' && info.baseUrl ? info.baseUrl : null;
  } catch {
    return null;
  }
}

function run(command, commandArgs, env) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid) {
  return spawnSync('kill', ['-0', String(pid)], { stdio: 'ignore' }).status === 0;
}

function listTestAppPids() {
  if (process.platform !== 'darwin') return [];
  const result = spawnSync('pgrep', ['-f', 'Cockpit Tools Test.app/Contents/MacOS'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function terminateTestAppProcesses(reason) {
  const pids = listTestAppPids();
  if (pids.length === 0) return;
  console.log(`[tauri-test-local] cleanup ${pids.length} stale test app process(es): ${reason}`);
  spawnSync('kill', ['-TERM', ...pids.map(String)], { stdio: 'ignore' });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return;
    sleepMs(100);
  }
  const alive = pids.filter(isProcessAlive);
  if (alive.length > 0) {
    spawnSync('kill', ['-KILL', ...alive.map(String)], { stdio: 'ignore' });
  }
}

function rustTargetForCurrentMac() {
  if (process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.arch === 'x64') return 'x86_64-apple-darwin';
  return null;
}

function macAppCandidates() {
  const candidates = [
    path.join(ROOT, 'target', 'release', 'bundle', 'macos', 'Cockpit Tools Test.app'),
  ];
  const rustTarget = rustTargetForCurrentMac();
  if (rustTarget) {
    candidates.push(path.join(ROOT, 'target', rustTarget, 'release', 'bundle', 'macos', 'Cockpit Tools Test.app'));
  }
  return candidates;
}

function findMacExecutable(appBundlePath) {
  const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  const macosDir = path.join(appBundlePath, 'Contents', 'MacOS');
  if (fs.existsSync(infoPlistPath)) {
    const result = spawnSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleExecutable', infoPlistPath],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const executableName = result.stdout?.trim();
    if (result.status === 0 && executableName) {
      const candidate = path.join(macosDir, executableName);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  const entries = fs.existsSync(macosDir) ? fs.readdirSync(macosDir) : [];
  for (const entry of entries) {
    const candidate = path.join(macosDir, entry);
    if (fs.statSync(candidate).isFile() && !entry.includes('cliproxy')) return candidate;
  }
  return null;
}

function resolveLaunchTarget() {
  if (process.platform === 'darwin') {
    for (const appBundle of macAppCandidates()) {
      if (!fs.existsSync(appBundle)) continue;
      const executable = findMacExecutable(appBundle);
      if (executable) return executable;
    }
    fail('missing local Test app bundle; run without --no-build first');
  }
  const executableName = process.platform === 'win32' ? 'cockpit-tools.exe' : 'cockpit-tools';
  const executable = path.join(ROOT, 'target', 'release', executableName);
  if (!fs.existsSync(executable)) {
    fail('missing local Test release executable; run without --no-build first');
  }
  return executable;
}

function buildTestApp(env) {
  const buildArgs = [
    'scripts/tauri.cjs',
    'build',
    '--config',
    TEST_CONFIG_PATH,
  ];
  if (process.platform === 'darwin') {
    buildArgs.push('--bundles', 'app', '--no-sign');
  } else {
    buildArgs.push('--no-bundle');
  }
  run(process.execPath, buildArgs, env);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const indexUrl =
    args.indexUrl
    || process.env.COCKPIT_PLATFORM_PACKAGE_INDEX_URL
    || readLocalServerIndexUrl()
    || PLATFORM_PACKAGE_TEST_INDEX_URL;

  const uiDevBaseUrl = args.uiDev
    ? (args.uiDevUrl || process.env.COCKPIT_PLATFORM_UI_DEV_BASE_URL || readLocalUiDevBaseUrl())
    : null;
  if (args.uiDev && !uiDevBaseUrl) {
    fail('missing local platform UI dev URL; run `npm run tauri:test:ui` or `npm run platform:ui:dev -- --platform <platformId>` first');
  }

  const env = {
    ...process.env,
    COCKPIT_TOOLS_PROFILE: 'test',
    COCKPIT_CODEX_API_SERVICE_PORT: CODEX_API_SERVICE_PORT,
    COCKPIT_TOOLS_API_PORT: CODEX_API_SERVICE_PORT,
    VITE_COCKPIT_TOOLS_PROFILE: 'test',
    COCKPIT_PLATFORM_PACKAGE_INDEX_URL: indexUrl,
    COCKPIT_PLATFORM_PACKAGE_PREFER_LOCAL_SOURCE: '0',
    COCKPIT_PLATFORM_PACKAGE_STRICT_LOCAL_SOURCE: '0',
    COCKPIT_PLATFORM_PACKAGE_BOOTSTRAP: '0',
    COCKPIT_PLATFORM_PACKAGE_WORKSPACE_INDEX: '0',
    ...(uiDevBaseUrl ? { COCKPIT_PLATFORM_UI_DEV_BASE_URL: uiDevBaseUrl } : {}),
  };

  console.log(`[tauri-test-local] platform package index: ${indexUrl}`);
  if (uiDevBaseUrl) {
    console.log(`[tauri-test-local] platform UI dev base: ${uiDevBaseUrl}`);
  }
  terminateTestAppProcesses('before local test launch');
  if (args.build) {
    buildTestApp(env);
  }

  const executablePath = resolveLaunchTarget();
  console.log(`[tauri-test-local] launching ${executablePath}`);
  const child = spawn(executablePath, args.extraLaunchArgs, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });

  function forwardSignal(signal, exitCode) {
    if (child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
    setTimeout(() => {
      terminateTestAppProcesses(`after ${signal}`);
      process.exit(exitCode);
    }, 3000).unref();
  }

  process.on('SIGINT', () => forwardSignal('SIGINT', 130));
  process.on('SIGTERM', () => forwardSignal('SIGTERM', 143));

  child.on('error', (error) => {
    console.error(`[tauri-test-local] failed to launch app: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal === 'SIGINT') process.exit(130);
    if (signal === 'SIGTERM') process.exit(143);
    process.exit(code ?? 0);
  });
}

main();
