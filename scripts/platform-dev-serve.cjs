#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE_INDEX_PATH = path.join(ROOT, 'platform-packages', 'index.json');
const LOCAL_ROOT = path.join(ROOT, '.tmp', 'platform-dev');
const DIST_DIR = path.join(LOCAL_ROOT, 'dist');
const METADATA_DIR = path.join(LOCAL_ROOT, 'metadata');
const INDEX_PATH = path.join(LOCAL_ROOT, 'index.local.json');
const SERVER_INFO_PATH = path.join(LOCAL_ROOT, 'server.json');
const DEFAULT_PORT = 14520;
const DEFAULT_HOST = '127.0.0.1';

function fail(message) {
  console.error(`[platform-dev-serve] ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  npm run platform:dev:serve -- [options]

Options:
  --platform <id[,id...]>       Build only selected platform package(s). Defaults to all.
  --port <port>                 Local HTTP port. Defaults to ${DEFAULT_PORT}.
  --host <host>                 Local HTTP host. Defaults to ${DEFAULT_HOST}.
  --no-build-ui                 Reuse existing platform-packages/<id>/ui output.
  --build-adapters              Rebuild selected sidecar adapters before packaging.
  --lazy                        Start the server without building zip files until /reload is called.
  --serve-only                  Serve existing .tmp/platform-dev/index.local.json and dist.
`);
}

function parseArgs(argv) {
  const args = {
    platforms: [],
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    buildUi: true,
    buildAdapters: false,
    lazy: false,
    serveOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--no-build-ui') {
      args.buildUi = false;
      continue;
    }
    if (arg === '--build-adapters') {
      args.buildAdapters = true;
      continue;
    }
    if (arg === '--lazy') {
      args.lazy = true;
      continue;
    }
    if (arg === '--serve-only') {
      args.serveOnly = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) fail(`Missing value for ${arg}`);
    index += 1;

    if (arg === '--platform') {
      args.platforms.push(
        ...next
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      );
    } else if (arg === '--port') {
      const port = Number.parseInt(next, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        fail(`Invalid --port: ${next}`);
      }
      args.port = port;
    } else if (arg === '--host') {
      args.host = next;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  args.platforms = Array.from(new Set(args.platforms));
  return args;
}

function normalizeOs(value) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  fail(`Unsupported OS: ${value}`);
}

function normalizeArch(value) {
  if (value === 'arm64') return 'aarch64';
  if (value === 'x64') return 'x86_64';
  if (value === 'aarch64' || value === 'x86_64') return value;
  fail(`Unsupported arch: ${value}`);
}

function rustTargetFor(os, arch) {
  if (os === 'macos') return `${arch}-apple-darwin`;
  if (os === 'windows') return `${arch}-pc-windows-msvc`;
  if (os === 'linux') return `${arch}-unknown-linux-gnu`;
  fail(`Unsupported target: ${os}/${arch}`);
}

function goTargetFor(os, arch) {
  const goOs = os === 'macos' ? 'darwin' : os;
  const goArch = arch === 'aarch64' ? 'arm64' : 'amd64';
  return { goOs, goArch };
}

function adapterEntryForOs(adapter, os) {
  if (!adapter) return null;
  if (os === 'macos') return adapter.macosEntry || adapter.entry;
  if (os === 'windows') return adapter.windowsEntry || adapter.entry;
  if (os === 'linux') return adapter.linuxEntry || adapter.entry;
  return adapter.entry;
}

function expectedAdapterCrateName(platformId) {
  if (platformId === 'claude_manager') return 'cockpit-claude-adapter';
  return `cockpit-${platformId.replace(/_/g, '-')}-adapter`;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label}: failed to read JSON: ${error.message}`);
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function loadBaseIndex() {
  const index = readJson(BASE_INDEX_PATH, 'platform package index');
  if (!Array.isArray(index.packages) || index.packages.length === 0) {
    fail('platform-packages/index.json has no packages');
  }
  return index;
}

function selectPackages(index, requestedPlatformIds) {
  const packages = index.packages || [];
  if (requestedPlatformIds.length === 0) return packages;
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  return requestedPlatformIds.map((platformId) => {
    const pkg = byId.get(platformId);
    if (!pkg) fail(`Unknown platform package: ${platformId}`);
    return pkg;
  });
}

function ensureCodexHelper(os, arch) {
  const rustTarget = rustTargetFor(os, arch);
  const extension = os === 'windows' ? '.exe' : '';
  const output = path.join(
    ROOT,
    'sidecars',
    'cockpit-cliproxy',
    'bin',
    `cockpit-cliproxy-${rustTarget}${extension}`,
  );
  if (fs.existsSync(output)) {
    return;
  }

  const { goOs, goArch } = goTargetFor(os, arch);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  console.log(`[platform-dev-serve] building Codex helper -> ${path.relative(ROOT, output)}`);
  run('go', [
    'build',
    '-trimpath',
    '-ldflags',
    '-s -w',
    '-o',
    output,
    '.',
  ], {
    cwd: path.join(ROOT, 'sidecars', 'cockpit-cliproxy'),
    env: {
      ...process.env,
      GOOS: goOs,
      GOARCH: goArch,
      CGO_ENABLED: '0',
    },
  });
}

function platformNeedsAdapterBuild(pkg, os, forceBuild) {
  if (pkg.installKind !== 'sidecarAdapter') return false;
  if (forceBuild) return true;
  const manifest = readJson(path.join(ROOT, 'platform-packages', pkg.id, 'manifest.json'), `${pkg.id} manifest`);
  const entry = adapterEntryForOs(manifest.adapter, os);
  if (!entry) return true;
  return !fs.existsSync(path.join(ROOT, 'platform-packages', pkg.id, entry));
}

function buildAdapter(pkg) {
  const crate = expectedAdapterCrateName(pkg.id);
  console.log(`[platform-dev-serve] building adapter ${crate}`);
  run('cargo', ['build', '--release', '-p', crate]);
}

function buildSelectedPackages(packages, args, os, arch, origin, options = {}) {
  if (options.reset !== false) {
    fs.rmSync(LOCAL_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(METADATA_DIR, { recursive: true });

  const builtAdapterIds = new Set();

  for (const pkg of packages) {
    if (args.buildUi) {
      run(process.execPath, ['scripts/build-platform-ui.cjs', pkg.id]);
    }

    const useReleaseAdapterBin = platformNeedsAdapterBuild(pkg, os, args.buildAdapters);
    if (useReleaseAdapterBin && !builtAdapterIds.has(pkg.id)) {
      buildAdapter(pkg);
      builtAdapterIds.add(pkg.id);
    }
    if (pkg.id === 'codex') {
      ensureCodexHelper(os, arch);
    }

    const metadataOut = path.join(METADATA_DIR, `${pkg.id}-${pkg.version}-${os}-${arch}.json`);
    const packageArgs = [
      'scripts/package-platform-package.cjs',
      '--platform',
      pkg.id,
      '--os',
      os,
      '--arch',
      arch,
      '--filename-template',
      'os-arch',
      '--dist-dir',
      DIST_DIR,
      '--metadata-out',
      metadataOut,
      '--download-url',
      `${origin}/dist/${pkg.id}-${pkg.version}-${os}-${arch}.zip`,
    ];

    if (pkg.installKind === 'sidecarAdapter' && useReleaseAdapterBin) {
      packageArgs.push('--adapter-bin-dir', path.join(ROOT, 'target', 'release'));
    }

    run(process.execPath, packageArgs);
  }
}

function readMetadataRows() {
  if (!fs.existsSync(METADATA_DIR)) return [];
  return fs
    .readdirSync(METADATA_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(METADATA_DIR, name), name));
}

function updatePackageFromManifest(pkg) {
  const manifestPath = path.join(ROOT, 'platform-packages', pkg.id, 'manifest.json');
  const manifest = readJson(manifestPath, `${pkg.id} manifest`);
  const next = { ...pkg };
  for (const key of [
    'platformId',
    'version',
    'apiVersion',
    'minCoreVersion',
    'displayName',
    'entry',
    'packageMode',
    'installKind',
    'adapter',
    'ui',
    'capabilities',
    'changelog',
    'contributions',
  ]) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) {
      next[key] = manifest[key];
    }
  }
  return next;
}

function writeLocalIndex(baseIndex, origin) {
  const metadataRows = readMetadataRows();
  const metadataById = new Map(metadataRows.map((metadata) => [metadata.id, metadata]));
  const packages = (baseIndex.packages || []).map((pkg) => {
    const metadata = metadataById.get(pkg.id);
    if (!metadata) return pkg;

    const next = updatePackageFromManifest(pkg);
    const artifact = {
      os: metadata.os,
      arch: metadata.arch,
      downloadUrl: `${origin}/dist/${metadata.zipName}`,
      downloadSizeBytes: metadata.downloadSizeBytes,
      sha256: metadata.sha256,
    };
    const existingArtifacts = Array.isArray(next.artifacts) ? next.artifacts : [];
    next.artifacts = [
      artifact,
      ...existingArtifacts.filter((item) => item.os !== artifact.os || item.arch !== artifact.arch),
    ];
    next.downloadUrl = artifact.downloadUrl;
    next.downloadSizeBytes = artifact.downloadSizeBytes;
    next.sha256 = artifact.sha256;
    return next;
  });

  const localIndex = {
    ...baseIndex,
    packages,
  };

  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, `${JSON.stringify(localIndex, null, 2)}\n`);
  return localIndex;
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

function sendFile(response, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
    });
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'content-length': fs.statSync(filePath).size,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  fs.createReadStream(filePath).pipe(response);
}

function resolveDistFile(urlPath) {
  const name = decodeURIComponent(urlPath.slice('/dist/'.length));
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return null;
  }
  return path.join(DIST_DIR, name);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(body);
}

function startServer(args, packageRows, initialLocalIndex, context) {
  const origin = `http://${args.host}:${args.port}`;
  let localIndex = initialLocalIndex;
  let reloadInFlight = Promise.resolve();
  fs.writeFileSync(SERVER_INFO_PATH, `${JSON.stringify({
    indexUrl: `${origin}/index.local.json`,
    reloadUrl: `${origin}/reload`,
    root: LOCAL_ROOT,
    distDir: DIST_DIR,
    platforms: packageRows.map((pkg) => pkg.id),
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  async function reloadPackage(platformId) {
    reloadInFlight = reloadInFlight.catch(() => undefined).then(() => {
      const rows = selectPackages(context.baseIndex, [platformId]);
      console.log(`[platform-dev-serve] reloading local package: ${platformId}`);
      buildSelectedPackages(rows, args, context.os, context.arch, origin, { reset: false });
      localIndex = writeLocalIndex(context.baseIndex, origin);
      return rows[0];
    });
    return await reloadInFlight;
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', origin);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
        'access-control-allow-headers': '*',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      sendText(response, 405, 'method not allowed');
      return;
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      sendJson(response, 200, {
        ok: true,
        indexUrl: `${origin}/index.local.json`,
        reloadUrl: `${origin}/reload`,
        packages: packageRows.map((pkg) => pkg.id),
      });
      return;
    }
    if (url.pathname === '/index.local.json') {
      sendFile(response, INDEX_PATH);
      return;
    }
    if (url.pathname === '/reload') {
      const platformId = String(url.searchParams.get('platformId') || '').trim();
      if (!platformId) {
        sendJson(response, 400, { ok: false, error: 'missing platformId' });
        return;
      }
      void reloadPackage(platformId)
        .then((pkg) => {
          sendJson(response, 200, {
            ok: true,
            platformId: pkg.id,
            indexUrl: `${origin}/index.local.json`,
          });
        })
        .catch((error) => {
          sendJson(response, 500, {
            ok: false,
            platformId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    if (url.pathname.startsWith('/dist/')) {
      const filePath = resolveDistFile(url.pathname);
      sendFile(response, filePath || '');
      return;
    }
    sendText(response, 404, 'not found');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      fail(`port ${args.port} is already in use`);
    }
    fail(error.message);
  });

  server.listen(args.port, args.host, () => {
    console.log(`[platform-dev-serve] serving ${INDEX_PATH}`);
    console.log(`[platform-dev-serve] index: ${origin}/index.local.json`);
    console.log('[platform-dev-serve] run desktop with: npm run tauri:test:local');
    console.table(
      (localIndex.packages || [])
        .filter((pkg) => packageRows.some((row) => row.id === pkg.id))
        .map((pkg) => ({
          id: pkg.id,
          version: pkg.version,
          size: pkg.downloadSizeBytes,
          sha256: String(pkg.sha256 || '').slice(0, 12),
        })),
    );
  });

  const cleanup = () => {
    try {
      server.close();
    } finally {
      fs.rmSync(SERVER_INFO_PATH, { force: true });
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

function verifyExistingLocalDist() {
  if (!fs.existsSync(INDEX_PATH)) fail('missing .tmp/platform-dev/index.local.json; remove --serve-only first');
  if (!fs.existsSync(DIST_DIR)) fail('missing .tmp/platform-dev/dist; remove --serve-only first');
  const index = readJson(INDEX_PATH, 'local platform package index');
  for (const pkg of index.packages || []) {
    for (const artifact of pkg.artifacts || []) {
      if (!String(artifact.downloadUrl || '').includes('/dist/')) continue;
      const fileName = String(artifact.downloadUrl).split('/').pop();
      const zipPath = path.join(DIST_DIR, fileName);
      if (!fs.existsSync(zipPath)) continue;
      if (fs.statSync(zipPath).size !== artifact.downloadSizeBytes) {
        fail(`${fileName}: local zip size mismatch`);
      }
      if (sha256(zipPath) !== artifact.sha256) {
        fail(`${fileName}: local zip sha256 mismatch`);
      }
    }
  }
  return index;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const os = normalizeOs(process.platform);
  const arch = normalizeArch(process.arch);
  const origin = `http://${args.host}:${args.port}`;
  const baseIndex = loadBaseIndex();
  const packageRows = selectPackages(baseIndex, args.platforms);

  let localIndex;
  if (args.serveOnly) {
    localIndex = verifyExistingLocalDist();
  } else if (args.lazy) {
    fs.rmSync(LOCAL_ROOT, { recursive: true, force: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.mkdirSync(METADATA_DIR, { recursive: true });
    console.log(`[platform-dev-serve] lazy mode target=${os}/${arch}, packages=${packageRows.map((pkg) => pkg.id).join(', ')}`);
    localIndex = writeLocalIndex(baseIndex, origin);
  } else {
    console.log(`[platform-dev-serve] target=${os}/${arch}, packages=${packageRows.map((pkg) => pkg.id).join(', ')}`);
    buildSelectedPackages(packageRows, args, os, arch, origin);
    localIndex = writeLocalIndex(baseIndex, origin);
  }

  startServer(args, packageRows, localIndex, { baseIndex, os, arch });
}

main();
