#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PLATFORM_PACKAGE_TEST_INDEX_URL =
  'https://raw.githubusercontent.com/jlcodes99/cockpit-tools/platform-test/platform-packages/index.test.json';

const repoRoot = path.resolve(__dirname, '..');
const devConfigPath = path.join('src-tauri', 'tauri.dev.conf.json');
const codexApiServicePort = process.env.COCKPIT_CODEX_API_SERVICE_PORT || '12345';
const buildConfigOverride = JSON.stringify({
  build: {
    beforeBuildCommand: 'node scripts/prepare-tauri.cjs',
    frontendDist: '../dist',
  },
});

const env = {
  ...process.env,
  COCKPIT_TOOLS_PROFILE: process.env.COCKPIT_TOOLS_PROFILE || 'dev',
  COCKPIT_CODEX_API_SERVICE_PORT: codexApiServicePort,
  COCKPIT_TOOLS_API_PORT: codexApiServicePort,
  COCKPIT_PLATFORM_PACKAGE_INDEX_URL:
    process.env.COCKPIT_PLATFORM_PACKAGE_INDEX_URL || PLATFORM_PACKAGE_TEST_INDEX_URL,
  COCKPIT_PLATFORM_PACKAGE_STRICT_LOCAL_SOURCE:
    process.env.COCKPIT_PLATFORM_PACKAGE_STRICT_LOCAL_SOURCE || '1',
  COCKPIT_PLATFORM_PACKAGE_PREFER_LOCAL_SOURCE:
    process.env.COCKPIT_PLATFORM_PACKAGE_PREFER_LOCAL_SOURCE || '1',
  COCKPIT_PLATFORM_PERF_LOG:
    process.env.COCKPIT_PLATFORM_PERF_LOG || '1',
  COCKPIT_SKIP_PLATFORM_ADAPTER_STARTUP_RESTORE:
    process.env.COCKPIT_SKIP_PLATFORM_ADAPTER_STARTUP_RESTORE || '1',
  VITE_COCKPIT_TOOLS_PROFILE: process.env.VITE_COCKPIT_TOOLS_PROFILE || 'dev',
  VITE_COCKPIT_PLATFORM_PERF_LOG:
    process.env.VITE_COCKPIT_PLATFORM_PERF_LOG || '1',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    env,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listDevAppPids() {
  if (process.platform !== 'darwin') {
    return [];
  }
  const result = spawnSync('pgrep', ['-f', 'Cockpit Tools Dev.app/Contents/MacOS'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  return result.stdout
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function isProcessAlive(pid) {
  return spawnSync('kill', ['-0', String(pid)], { stdio: 'ignore' }).status === 0;
}

function terminateDevAppProcesses(reason) {
  const pids = listDevAppPids();
  if (pids.length === 0) {
    return;
  }
  console.log(`[tauri-dist-dev] cleanup ${pids.length} stale dev app process(es): ${reason}`);
  spawnSync('kill', ['-TERM', ...pids.map(String)], { stdio: 'ignore' });

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return;
    }
    sleepMs(100);
  }

  const alivePids = pids.filter(isProcessAlive);
  if (alivePids.length > 0) {
    spawnSync('kill', ['-KILL', ...alivePids.map(String)], { stdio: 'ignore' });
  }
}

function targetRootCandidates() {
  return [
    path.join(repoRoot, 'target'),
    path.join(repoRoot, 'src-tauri', 'target'),
  ];
}

function findMacAppBundle() {
  const names = ['Cockpit Tools Dev.app', 'Cockpit Tools.app'];
  for (const targetRoot of targetRootCandidates()) {
    for (const name of names) {
      const candidate = path.join(targetRoot, 'debug', 'bundle', 'macos', name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function findMacExecutable(appBundlePath) {
  const macosDir = path.join(appBundlePath, 'Contents', 'MacOS');
  const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  if (fs.existsSync(infoPlistPath)) {
    const result = spawnSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleExecutable', infoPlistPath],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const bundleExecutable = result.stdout?.trim();
    if (result.status === 0 && bundleExecutable) {
      const candidate = path.join(macosDir, bundleExecutable);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  const preferred = path.join(macosDir, 'cockpit-tools');
  if (fs.existsSync(preferred) && fs.statSync(preferred).isFile()) {
    return preferred;
  }

  const entries = fs.readdirSync(macosDir);
  for (const entry of entries) {
    if (entry.includes('cliproxy')) {
      continue;
    }
    const candidate = path.join(macosDir, entry);
    if (fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function findDebugExecutable() {
  const executableName = process.platform === 'win32' ? 'cockpit-tools.exe' : 'cockpit-tools';
  for (const targetRoot of targetRootCandidates()) {
    const candidate = path.join(targetRoot, 'debug', executableName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveLaunchTarget() {
  if (process.platform === 'darwin') {
    const appBundle = findMacAppBundle();
    if (!appBundle) {
      throw new Error('未找到本地 dist Dev App bundle');
    }
    const executable = findMacExecutable(appBundle);
    if (!executable) {
      throw new Error(`未找到 Dev App 可执行文件: ${appBundle}`);
    }
    return executable;
  }
  const executable = findDebugExecutable();
  if (!executable) {
    throw new Error('未找到本地 dist debug 可执行文件');
  }
  return executable;
}

function buildTauriArgs() {
  const args = [
    'tauri',
    'build',
    '--debug',
    '--config',
    devConfigPath,
    '--config',
    buildConfigOverride,
  ];
  if (process.platform === 'darwin') {
    args.push('--bundles', 'app', '--no-sign');
  } else {
    args.push('--no-bundle');
  }
  return args;
}

console.log('[tauri-dist-dev] building frontend dist and debug desktop app...');
terminateDevAppProcesses('before dist launch');
run('npm', ['run', 'build']);
run('npx', buildTauriArgs());

const executablePath = resolveLaunchTarget();
console.log(`[tauri-dist-dev] launching ${executablePath}`);

const child = spawn(executablePath, process.argv.slice(2), {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

function forwardSignal(signal) {
  if (!child.killed) {
    child.kill(signal);
  }
  setTimeout(() => {
    terminateDevAppProcesses(`after ${signal}`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }, 3000).unref();
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('error', (error) => {
  console.error(`[tauri-dist-dev] failed to launch app: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 0);
});
