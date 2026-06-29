const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const PLATFORM_PACKAGE_TEST_INDEX_URL =
  'https://raw.githubusercontent.com/jlcodes99/cockpit-tools/platform-test/platform-packages/index.test.json';
const DEV_APP_EXECUTABLE_PATH = path.join(
  path.resolve(__dirname, '..'),
  'target',
  'dev-app',
  'Cockpit Tools Dev.app',
  'Contents',
  'MacOS',
  'cockpit-tools-dev',
);
const codexApiServicePort = process.env.COCKPIT_CODEX_API_SERVICE_PORT || '12345';

const rawArgs = process.argv.slice(2);
const fastMode = rawArgs.includes('--fast');
const extraArgs = rawArgs.filter((arg) => arg !== '--fast');

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
    process.env.COCKPIT_SKIP_PLATFORM_ADAPTER_STARTUP_RESTORE ||
    (fastMode ? '1' : ''),
  VITE_COCKPIT_TOOLS_PROFILE: process.env.VITE_COCKPIT_TOOLS_PROFILE || 'dev',
  VITE_COCKPIT_PLATFORM_PERF_LOG:
    process.env.VITE_COCKPIT_PLATFORM_PERF_LOG || '1',
};

if (fastMode) {
  console.log(
    '[tauri-dev] fast mode: skip startup adapter restore; run `npm run tauri:dev:full` for typecheck + full startup restore.',
  );
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listDevAppPids() {
  if (process.platform !== 'darwin') {
    return [];
  }
  const result = spawnSync('pgrep', ['-f', DEV_APP_EXECUTABLE_PATH], {
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
  console.log(`[tauri-dev] cleanup ${pids.length} stale dev app process(es): ${reason}`);
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

terminateDevAppProcesses('before launch');

const syncResult = spawnSync('npm', ['run', 'sync-version'], {
  stdio: 'inherit',
  env,
});

if (syncResult.status !== 0) {
  process.exit(syncResult.status ?? 1);
}

const tauriArgs = [
  'dev',
  '--config',
  'src-tauri/tauri.dev.conf.json',
  ...(process.platform === 'darwin' &&
  !extraArgs.some((arg) => arg === '--runner' || arg === '-r' || arg.startsWith('--runner='))
    ? ['--runner', path.resolve(__dirname, 'tauri-dev-app-runner.cjs')]
    : []),
  ...extraArgs,
];

const tauriProcess = spawn('tauri', tauriArgs, {
  stdio: 'inherit',
  env,
});

let finishing = false;

function finish(code) {
  if (finishing) {
    return;
  }
  finishing = true;
  terminateDevAppProcesses('after tauri dev exit');
  process.exit(code);
}

function forwardSignal(signal, exitCode) {
  if (tauriProcess.exitCode === null && !tauriProcess.killed) {
    tauriProcess.kill(signal);
  }
  setTimeout(() => finish(exitCode), 5000).unref();
}

process.on('SIGINT', () => forwardSignal('SIGINT', 130));
process.on('SIGTERM', () => forwardSignal('SIGTERM', 143));

tauriProcess.on('error', (error) => {
  console.error(`[tauri-dev] failed to start tauri dev: ${error.message}`);
  finish(1);
});

tauriProcess.on('exit', (code, signal) => {
  if (signal === 'SIGINT') {
    finish(130);
    return;
  }
  if (signal === 'SIGTERM') {
    finish(143);
    return;
  }
  finish(code ?? 1);
});
