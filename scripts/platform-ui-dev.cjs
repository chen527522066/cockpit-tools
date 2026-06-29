#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE_INDEX_PATH = path.join(ROOT, 'platform-packages', 'index.json');
const DEV_ROOT = path.join(ROOT, '.tmp', 'platform-ui-dev');
const SERVER_INFO_PATH = path.join(DEV_ROOT, 'server.json');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 14522;
const REBUILD_DEBOUNCE_MS = 250;

function fail(message) {
  console.error(`[platform-ui-dev] ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  npm run platform:ui:dev -- [--platform <id[,id...]>] [options]

Options:
  --platform <id[,id...]>  Platform UI(s) to serve. Defaults to all platform packages.
  --port <port>            Local HTTP port. Defaults to ${DEFAULT_PORT}.
  --host <host>            Local HTTP host. Defaults to ${DEFAULT_HOST}.
  --no-watch               Build once and serve without watching src changes.
`);
}

function parseArgs(argv) {
  const args = {
    platforms: [],
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    watch: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--no-watch') {
      args.watch = false;
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
      if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`Invalid --port: ${next}`);
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

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label}: failed to read JSON: ${error.message}`);
  }
}

function loadSupportedPlatforms() {
  const index = readJson(BASE_INDEX_PATH, 'platform package index');
  return (index.packages || []).map((pkg) => pkg.id);
}

function validatePlatforms(platforms) {
  const supported = new Set(loadSupportedPlatforms());
  for (const platformId of platforms) {
    if (!supported.has(platformId)) fail(`Unknown platform package: ${platformId}`);
    const entry = path.join(ROOT, 'src', 'platform-ui', platformId, 'remote.tsx');
    if (!fs.existsSync(entry)) fail(`${platformId}: missing ${path.relative(ROOT, entry)}`);
  }
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return false;
  return true;
}

function buildPlatformUi(platformId) {
  const startedAt = Date.now();
  console.log(`[platform-ui-dev] building ${platformId} UI...`);
  const ok = run(process.execPath, ['scripts/build-platform-ui.cjs', platformId]);
  const elapsed = Date.now() - startedAt;
  if (!ok) {
    console.error(`[platform-ui-dev] build failed: platform=${platformId}, elapsed=${elapsed}ms`);
    return false;
  }
  console.log(`[platform-ui-dev] built ${platformId} UI in ${elapsed}ms`);
  return true;
}

function buildAll(platforms) {
  let ok = true;
  for (const platformId of platforms) {
    ok = buildPlatformUi(platformId) && ok;
  }
  return ok;
}

function contentTypeFor(fileName) {
  if (fileName.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (fileName.endsWith('.css')) return 'text/css; charset=utf-8';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function sendText(response, status, body) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(body);
}

function sendJson(response, body) {
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(body));
}

function sendFile(response, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(response, 404, 'not found');
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

function parsePlatformAssetPath(pathname, platforms) {
  const match = /^\/([^/]+)\/(remoteEntry\.js|style\.css)$/u.exec(pathname);
  if (!match) return null;
  const platformId = decodeURIComponent(match[1]);
  const fileName = match[2];
  if (!platforms.includes(platformId)) return null;
  return {
    platformId,
    filePath: path.join(ROOT, 'platform-packages', platformId, 'ui', fileName),
  };
}

function createEventHub() {
  const clients = new Set();

  function send(client, event) {
    client.response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  return {
    add(request, response, platformId) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      const client = { response, platformId };
      clients.add(client);
      response.write(': connected\n\n');
      request.on('close', () => {
        clients.delete(client);
      });
    },
    broadcast(event) {
      for (const client of clients) {
        if (client.platformId && client.platformId !== event.platformId) continue;
        send(client, event);
      }
    },
    close() {
      for (const client of clients) {
        client.response.end();
      }
      clients.clear();
    },
  };
}

function startServer(args, eventHub) {
  const baseUrl = `http://${args.host}:${args.port}`;
  fs.mkdirSync(DEV_ROOT, { recursive: true });
  fs.writeFileSync(SERVER_INFO_PATH, `${JSON.stringify({
    baseUrl,
    platforms: args.platforms,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', baseUrl);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,HEAD,OPTIONS',
        'access-control-allow-headers': '*',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'method not allowed');
      return;
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      sendJson(response, { ok: true, platforms: args.platforms });
      return;
    }
    if (url.pathname === '/events') {
      const platformId = url.searchParams.get('platformId') || '';
      eventHub.add(request, response, platformId);
      return;
    }
    const asset = parsePlatformAssetPath(url.pathname, args.platforms);
    if (asset) {
      sendFile(response, asset.filePath);
      return;
    }
    sendText(response, 404, 'not found');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') fail(`port ${args.port} is already in use`);
    fail(error.message);
  });

  server.listen(args.port, args.host, () => {
    console.log(`[platform-ui-dev] serving ${baseUrl}`);
    console.log('[platform-ui-dev] run desktop with: npm run tauri:test:ui');
    console.table(args.platforms.map((platformId) => ({
      platform: platformId,
      remoteEntry: `${baseUrl}/${platformId}/remoteEntry.js`,
      style: `${baseUrl}/${platformId}/style.css`,
    })));
  });

  return server;
}

function affectedPlatformsForSource(platforms, fileName) {
  const normalized = String(fileName || '').replace(/\\/g, '/');
  const platformMatch = /^platform-ui\/([^/]+)\//u.exec(normalized);
  if (platformMatch) {
    const platformId = platformMatch[1];
    return platforms.includes(platformId) ? [platformId] : [];
  }
  return platforms;
}

function watchSource(platforms, eventHub) {
  const srcRoot = path.join(ROOT, 'src');
  let timer = null;
  let building = false;
  let pending = false;
  let pendingPlatforms = new Set();

  const rebuild = () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    pending = false;
    const targets = Array.from(pendingPlatforms);
    pendingPlatforms = new Set();
    for (const platformId of targets) {
      if (buildPlatformUi(platformId)) {
        eventHub.broadcast({
          platformId,
          revision: Date.now(),
        });
      }
    }
    building = false;
    if (pending) rebuild();
  };

  const schedule = (targets) => {
    for (const platformId of targets) {
      pendingPlatforms.add(platformId);
    }
    if (pendingPlatforms.size === 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, REBUILD_DEBOUNCE_MS);
  };

  try {
    const watcher = fs.watch(srcRoot, { recursive: true }, (_eventType, fileName) => {
      const name = String(fileName || '');
      if (!name.endsWith('.ts') && !name.endsWith('.tsx') && !name.endsWith('.css')) return;
      schedule(affectedPlatformsForSource(platforms, name));
    });
    console.log(`[platform-ui-dev] watching ${path.relative(ROOT, srcRoot)}`);
    return watcher;
  } catch (error) {
    console.warn(`[platform-ui-dev] fs.watch recursive unavailable: ${error.message}`);
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.platforms.length === 0) {
    args.platforms = loadSupportedPlatforms();
  }
  validatePlatforms(args.platforms);
  const ok = buildAll(args.platforms);
  if (!ok) process.exit(1);

  const eventHub = createEventHub();
  const server = startServer(args, eventHub);
  const watcher = args.watch ? watchSource(args.platforms, eventHub) : null;

  const cleanup = (exitCode) => {
    watcher?.close();
    eventHub.close();
    server.close();
    fs.rmSync(SERVER_INFO_PATH, { force: true });
    process.exit(exitCode);
  };

  process.on('SIGINT', () => cleanup(130));
  process.on('SIGTERM', () => cleanup(143));
}

main();
