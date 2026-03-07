const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { once } = require('events');
const { execFileSync } = require('child_process');

process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH = 'true';
process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.ADMIN_PASSWORD = 'admin123456';

const serverRoot = path.resolve(__dirname, '..');
let tempDir;
let buildServer;
let prisma;
let app;

const { parseProxyUrl, buildSiteFetchOptions, siteFetch } = require('../src/site-http');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function createUpstreamServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const bodyChunks = [];

    req.on('data', (chunk) => bodyChunks.push(chunk));
    req.on('end', () => {
      requests.push({
        path: url.pathname,
        method: req.method,
        viaProxy: req.headers['x-through-proxy'] === 'yes'
      });

      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'claude-3-5-sonnet' }] }));
        return;
      }

      if (url.pathname === '/v1/dashboard/billing/subscription') {
        res.end(JSON.stringify({ system_hard_limit_usd: 12.5 }));
        return;
      }

      if (url.pathname === '/v1/dashboard/billing/usage') {
        res.end(JSON.stringify({ total_usage: 250 }));
        return;
      }

      if (url.pathname === '/api/token/') {
        res.end(JSON.stringify({ success: true, data: [{ id: 1, key: 'tok-1' }] }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: `Unhandled path: ${url.pathname}` }));
    });
  });

  return { server, requests };
}

function createHttpProxyServer() {
  const requests = [];
  const server = http.createServer((clientReq, clientRes) => {
    const targetUrl = new URL(clientReq.url);
    requests.push({ method: clientReq.method, url: clientReq.url });

    const proxyReq = http.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        host: targetUrl.host,
        'x-through-proxy': 'yes'
      }
    }, (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (error) => {
      clientRes.statusCode = 502;
      clientRes.end(JSON.stringify({ error: error.message }));
    });

    clientReq.pipe(proxyReq);
  });

  return { server, requests };
}

async function createSite(payload) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sites',
    payload
  });

  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplehub-site-proxy-'));
  process.env.DATABASE_URL = `file:${path.join(tempDir, 'db.sqlite')}`;

  execFileSync('npx', ['prisma', 'db', 'push', '--force-reset', '--skip-generate'], {
    cwd: serverRoot,
    env: process.env,
    stdio: 'inherit'
  });

  ({ buildServer } = require('../src/server'));
  ({ prisma } = require('../src/db'));
  app = await buildServer();
});

test.after(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test.afterEach(async () => {
  await prisma.modelDiff.deleteMany();
  await prisma.modelSnapshot.deleteMany();
  await prisma.site.deleteMany();
});

test('site-http validates proxy URLs and attaches proxy agents', async () => {
  assert.equal(parseProxyUrl('socks5://user:pass@127.0.0.1:1080').protocol, 'socks5:');
  assert.throws(() => parseProxyUrl('ftp://127.0.0.1:21'), /代理协议/);

  const directOptions = buildSiteFetchOptions({ proxyUrl: null }, { method: 'GET' });
  assert.equal(directOptions.agent, undefined);

  let receivedOptions;
  await siteFetch(
    { proxyUrl: 'http://127.0.0.1:7890' },
    'http://example.com',
    { method: 'GET' },
    {
      fetchImpl: async (url, options) => {
        receivedOptions = options;
        return { ok: true };
      }
    }
  );

  assert.equal(typeof receivedOptions.agent, 'function');
  assert.equal(receivedOptions.method, 'GET');
});

test('site CRUD persists encrypted proxyUrl and allows clearing it', async () => {
  const created = await createSite({
    name: 'proxy-site',
    baseUrl: 'http://127.0.0.1:18080',
    apiKey: 'sk-test',
    apiType: 'other',
    proxyUrl: 'http://user:pass@127.0.0.1:18888'
  });

  const savedSite = await prisma.site.findUnique({ where: { id: created.id } });
  assert.ok(savedSite.proxyUrlEnc);
  assert.notEqual(savedSite.proxyUrlEnc, 'http://user:pass@127.0.0.1:18888');

  const detailResponse = await app.inject({
    method: 'GET',
    url: `/api/sites/${created.id}`
  });

  assert.equal(detailResponse.statusCode, 200, detailResponse.body);
  assert.equal(detailResponse.json().proxyUrl, 'http://user:pass@127.0.0.1:18888');

  const clearedResponse = await app.inject({
    method: 'PATCH',
    url: `/api/sites/${created.id}`,
    payload: { proxyUrl: '' }
  });

  assert.equal(clearedResponse.statusCode, 200, clearedResponse.body);

  const clearedSite = await prisma.site.findUnique({ where: { id: created.id } });
  assert.equal(clearedSite.proxyUrlEnc, null);

  const invalidResponse = await app.inject({
    method: 'POST',
    url: '/api/sites',
    payload: {
      name: 'invalid-proxy',
      baseUrl: 'http://127.0.0.1:18080',
      apiKey: 'sk-test',
      proxyUrl: 'ftp://127.0.0.1:21'
    }
  });

  assert.equal(invalidResponse.statusCode, 400, invalidResponse.body);
  assert.match(invalidResponse.body, /代理协议/);
});

test('site checks and token proxy routes honor per-site proxy settings', async () => {
  const upstream = createUpstreamServer();
  const proxy = createHttpProxyServer();
  const upstreamPort = await listen(upstream.server);
  const proxyPort = await listen(proxy.server);

  try {
    const proxiedSite = await createSite({
      name: 'proxied-site',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: 'sk-proxy',
      apiType: 'other',
      proxyUrl: `http://127.0.0.1:${proxyPort}`
    });

    const proxiedCheckResponse = await app.inject({
      method: 'POST',
      url: `/api/sites/${proxiedSite.id}/check?skipNotification=true`
    });

    assert.equal(proxiedCheckResponse.statusCode, 200, proxiedCheckResponse.body);
    assert.equal(proxiedCheckResponse.json().ok, true);
    assert.ok(proxy.requests.some((request) => request.url.includes('/v1/models')));
    assert.ok(upstream.requests.some((request) => request.path === '/v1/models' && request.viaProxy));

    const proxiedTokensResponse = await app.inject({
      method: 'GET',
      url: `/api/sites/${proxiedSite.id}/tokens`
    });

    assert.equal(proxiedTokensResponse.statusCode, 200, proxiedTokensResponse.body);
    assert.ok(upstream.requests.some((request) => request.path === '/api/token/' && request.viaProxy));

    const proxyRequestCount = proxy.requests.length;

    const directSite = await createSite({
      name: 'direct-site',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: 'sk-direct',
      apiType: 'other'
    });

    const directCheckResponse = await app.inject({
      method: 'POST',
      url: `/api/sites/${directSite.id}/check?skipNotification=true`
    });

    assert.equal(directCheckResponse.statusCode, 200, directCheckResponse.body);
    assert.equal(proxy.requests.length, proxyRequestCount);
    assert.ok(upstream.requests.some((request) => request.path === '/v1/models' && !request.viaProxy));
  } finally {
    await Promise.all([
      new Promise((resolve) => proxy.server.close(resolve)),
      new Promise((resolve) => upstream.server.close(resolve))
    ]);
  }
});
