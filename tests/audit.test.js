import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dns, { Resolver } from 'node:dns/promises';
import { access } from 'node:fs/promises';
import { validateTargetUrl, isPublicAddress, createSafeProxy } from '../server/network.js';
import { runAudit, selectDevices, buildChecks, summarizeChecks } from '../server/audit.js';

const unsafeUrls = [
  'http://localhost/', 'http://localhost./', 'http://sub.localhost/', 'http://printer.local/',
  'http://127.0.0.1/', 'http://127.2.3.4/', 'http://10.0.0.1/', 'http://172.16.0.1/',
  'http://192.168.1.1/', 'http://169.254.169.254/', 'http://168.63.129.16/', 'http://100.64.0.1/', 'http://0.0.0.0/',
  'http://192.0.2.1/', 'http://198.18.0.1/', 'http://203.0.113.1/', 'http://224.0.0.1/',
  'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/',
  'http://[::1]/', 'http://[::]/', 'http://[fc00::1]/', 'http://[fe80::1]/',
  'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[2001:db8::1]/',
  'http://[2002:7f00:1::]/', 'http://[64:ff9b::7f00:1]/', 'http://[3fff::1]/',
  'http://user:password@8.8.8.8/', 'https://user@8.8.8.8/', 'http://@8.8.8.8/',
  'http://8.8.8.8:8080/', 'https://8.8.8.8:444/', 'http://8.8.8.8:0/',
  'file:///C:/Windows/win.ini', 'data:text/html,hello', 'javascript:alert(1)', 'ftp://8.8.8.8/',
  '', 'not a url', 'https://', 'http://[::1', 'http://8.8.8.8:99999/', null, {},
];

for (const raw of unsafeUrls) {
  test(`reject unsafe or invalid target: ${JSON.stringify(raw)}`, async () => {
    await assert.rejects(validateTargetUrl(raw), (error) => error.code === 'UNSAFE_TARGET');
  });
}

test('public IP targets normalize without opening a connection', async () => {
  assert.equal((await validateTargetUrl('https://8.8.8.8/path?q=1#anchor')).href, 'https://8.8.8.8/path?q=1#anchor');
  assert.equal((await validateTargetUrl('http://1.1.1.1:80/')).port, '');
  assert.equal((await validateTargetUrl('https://[2606:4700:4700::1111]/')).protocol, 'https:');
  assert.equal(isPublicAddress('8.8.4.4'), true);
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), false);
  assert.equal(isPublicAddress('240.0.0.1'), false);
});

test('demo exception is exact-origin, exact-path, HTTP only', async () => {
  const demoOrigin = 'http://127.0.0.1:45678';
  assert.equal((await validateTargetUrl(`${demoOrigin}/demo.html`, { demoOrigin })).origin, demoOrigin);
  for (const url of [
    `${demoOrigin}/`, `${demoOrigin}/api/audits`, `${demoOrigin}/demo.html/`,
    `${demoOrigin}/demo.html/../api`, `${demoOrigin}/demo.html%2f..%2fapi`,
    'http://127.0.0.1:45679/demo.html', 'http://localhost:45678/demo.html',
    'https://127.0.0.1:45678/demo.html', 'http://[::1]:45678/demo.html',
    'http://user:password@127.0.0.1:45678/demo.html',
  ]) await assert.rejects(validateTargetUrl(url, { demoOrigin }));
  await assert.rejects(validateTargetUrl(`${demoOrigin}/demo.html`));
  await assert.rejects(validateTargetUrl('http://127.0.0.1:0/demo.html', { demoOrigin: 'http://127.0.0.1:0' }));
  await assert.rejects(validateTargetUrl('http://192.168.1.1/demo.html', { demoOrigin: 'http://192.168.1.1' }));
});

test('every A and AAAA answer must be public, including later re-resolution', async (t) => {
  let rebinding = false;
  let ipv6Private = false;
  let calls4 = 0;
  let calls6 = 0;
  t.mock.method(Resolver.prototype, 'resolve4', async () => {
    calls4++;
    return rebinding ? ['8.8.8.8', '127.0.0.1'] : ['8.8.8.8'];
  });
  t.mock.method(Resolver.prototype, 'resolve6', async () => {
    calls6++;
    return ipv6Private ? ['::1'] : ['2606:4700:4700::1111'];
  });
  assert.equal((await validateTargetUrl('https://audit-host.com/')).hostname, 'audit-host.com');
  rebinding = true;
  await assert.rejects(validateTargetUrl('https://audit-host.com/'), /DNS/);
  rebinding = false;
  ipv6Private = true;
  await assert.rejects(validateTargetUrl('https://audit-host.com/'), /DNS/);
  assert.equal(calls4, 3);
  assert.equal(calls6, 3);
});

test('Azure runner infrastructure is blocked through DNS and the proxy', async (t) => {
  t.mock.method(Resolver.prototype, 'resolve4', async () => ['168.63.129.16']);
  t.mock.method(Resolver.prototype, 'resolve6', async () => []);
  await assert.rejects(validateTargetUrl('https://azure-host.com/'), /DNS/);
  const proxy = await createSafeProxy();
  try {
    assert.equal((await proxyRequest(proxy, 'http://azure-host.com/')).status, 403);
    assert.equal((await proxyRequest(proxy, 'http://168.63.129.16/')).status, 403);
  } finally { await proxy.close(); }
});

test('a failed DNS family is not silently trusted', async (t) => {
  t.mock.method(Resolver.prototype, 'resolve4', async () => ['8.8.8.8']);
  t.mock.method(Resolver.prototype, 'resolve6', async () => { throw Object.assign(new Error('DNS failure'), { code: 'ETIMEOUT' }); });
  await assert.rejects(validateTargetUrl('http://audit-host.com/'), /все DNS/);
});

test('Windows system DNS fallback still checks all answers of both families', async (t) => {
  for (const method of ['resolve4', 'resolve6']) {
    t.mock.method(Resolver.prototype, method, async () => { throw Object.assign(new Error('stub refused'), { code: 'ECONNREFUSED' }); });
  }
  const families = [];
  let privateAnswer = true;
  t.mock.method(dns, 'lookup', async (_hostname, options) => {
    assert.equal(options.all, true);
    families.push(options.family);
    if (options.family === 6) return [{ address: privateAnswer ? '::1' : '2606:4700:4700::1111', family: 6 }];
    return [{ address: '8.8.8.8', family: 4 }];
  });
  await assert.rejects(validateTargetUrl('https://audit-host.com/'), /DNS/);
  privateAnswer = false;
  assert.equal((await validateTargetUrl('https://audit-host.com/')).hostname, 'audit-host.com');
  assert.deepEqual(families, [4, 6, 4, 6]);
});

test('an already aborted validation and audit reject with AbortError', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(validateTargetUrl('https://8.8.8.8', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(runAudit({ url: 'https://8.8.8.8', signal: controller.signal }), { name: 'AbortError' });
});

function cleanSnapshot() {
  return {
    viewports: ['width=device-width, initial-scale=1'], domWidth: 390, layoutWidth: 390,
    overflow: [], overflowCount: 0, smallText: [], smallTextCount: 0,
    tinyTaps: [], tinyTapCount: 0, smallTaps: [], smallTapCount: 0,
    legacy: [], legacyCount: 0, imageOverflow: [], imageOverflowCount: 0,
  };
}

test('healthy snapshot passes all rules with deterministic score', () => {
  const checks = buildChecks(cleanSnapshot(), { httpStatus: 200 });
  assert.equal(checks.length, 9);
  assert.deepEqual(summarizeChecks(checks), { score: 100, summary: { passed: 9, warnings: 0, failed: 0 }, status: 'pass' });
});

test('viewport, zoom, overflow, tap and font heuristics have stable weights', () => {
  const snapshot = { ...cleanSnapshot(), viewports: ['width=980, maximum-scale=1, user-scalable=no'], domWidth: 600, tinyTapCount: 1, smallTextCount: 1 };
  const checks = buildChecks(snapshot, { httpStatus: 200 });
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.equal(byId.viewport.status, 'fail');
  assert.equal(byId.overflow.status, 'fail');
  assert.equal(byId.zoom.status, 'warning');
  assert.equal(byId['tap-targets'].status, 'fail');
  assert.equal(byId['font-size'].status, 'warning');
  assert.equal(summarizeChecks(checks).score, 38);
  assert.deepEqual(summarizeChecks(checks).summary, { passed: 4, warnings: 2, failed: 3 });
});

test('device-width token is not accepted as a prefix; zoom scale >1 is allowed', () => {
  const checks = buildChecks({ ...cleanSnapshot(), viewports: ['width=device-width-fake, maximum-scale=2'] }, { httpStatus: 200 });
  assert.equal(checks.find((check) => check.id === 'viewport').status, 'fail');
  assert.equal(checks.find((check) => check.id === 'zoom').status, 'pass');
});

test('rule detail output is capped at 30, while counters retain all findings', () => {
  const details = Array.from({ length: 80 }, (_, index) => ({ selector: `#item-${index}`, text: '', x: 0, y: index, width: 20, height: 20, reason: 'test' }));
  const checks = buildChecks({ ...cleanSnapshot(), tinyTaps: details, tinyTapCount: 80 }, { httpStatus: 200 });
  const taps = checks.find((check) => check.id === 'tap-targets');
  assert.equal(taps.details.length, 30);
  assert.match(taps.description, /80/);
});

test('quick/full device selection deduplicates the selected width', () => {
  assert.deepEqual(selectDevices(390, 844, true, 'quick').map((device) => device.id), ['selected']);
  assert.deepEqual(selectDevices(390, 844, true, 'full').map((device) => device.id), ['selected', 'mobile-320', 'mobile-375', 'tablet', 'desktop']);
  assert.deepEqual(selectDevices(375, 900, true, 'full').map((device) => device.id), ['selected', 'mobile-320', 'tablet', 'desktop']);
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function proxyRequest(proxy, url, method = 'GET', auth = true) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(proxy.server);
    const request = http.request({
      hostname: endpoint.hostname, port: endpoint.port, path: url, method, agent: false,
      headers: auth ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` } : {},
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(5_000, () => request.destroy(new Error('test request timeout')));
    request.end();
  });
}

test('proxy only forwards the authorized demo path, not private paths or mutations', async () => {
  const reached = [];
  const fixture = http.createServer((request, response) => {
    reached.push(`${request.method} ${request.url}`);
    response.end('fixture');
  });
  const origin = await listen(fixture);
  const proxy = await createSafeProxy({ demoOrigin: origin });
  try {
    assert.deepEqual(await proxyRequest(proxy, `${origin}/demo.html`), { status: 200, body: 'fixture' });
    assert.equal((await proxyRequest(proxy, `${origin}/demo.html`, 'GET', false)).status, 407);
    assert.equal((await proxyRequest(proxy, `${origin}/private`)).status, 403);
    assert.equal((await proxyRequest(proxy, `${origin}/demo.html`, 'POST')).status, 405);
    assert.equal((await proxyRequest(proxy, 'http://169.254.169.254/')).status, 403);
    assert.equal((await proxyRequest(proxy, 'http://8.8.8.8:8080/')).status, 403);
    assert.deepEqual(reached, ['GET /demo.html']);
  } finally {
    await proxy.close();
    await proxy.close();
    await closeServer(fixture);
  }
});

test('HTTP proxy pins the public numeric destination and preserves only the target Host', async (t) => {
  t.mock.method(Resolver.prototype, 'resolve4', async () => ['8.8.8.8']);
  t.mock.method(Resolver.prototype, 'resolve6', async () => []);
  let receivedHost;
  let receivedProxyAuth;
  const fixture = http.createServer((request, response) => {
    receivedHost = request.headers.host;
    receivedProxyAuth = request.headers['proxy-authorization'];
    response.end('pinned');
  });
  const origin = await listen(fixture);
  const originalRequest = http.request;
  let pinned = false;
  t.mock.method(http, 'request', function (options, ...args) {
    if (options.hostname === '8.8.8.8') {
      pinned = true;
      assert.equal(options.family, 4);
      assert.equal(options.port, 80);
      // Test-only transport substitution: no public network request is made.
      return originalRequest.call(this, { ...options, hostname: '127.0.0.1', port: Number(new URL(origin).port) }, ...args);
    }
    return originalRequest.call(this, options, ...args);
  });
  const proxy = await createSafeProxy();
  try {
    assert.deepEqual(await proxyRequest(proxy, 'http://pin-host.com/page'), { status: 200, body: 'pinned' });
    assert.equal(pinned, true);
    assert.equal(receivedHost, 'pin-host.com');
    assert.equal(receivedProxyAuth, undefined);
  } finally { await proxy.close(); await closeServer(fixture); }
});

test('proxy revalidates DNS after a successful API preflight', async (t) => {
  let rebound = false;
  t.mock.method(Resolver.prototype, 'resolve4', async () => rebound ? ['127.0.0.1'] : ['8.8.8.8']);
  t.mock.method(Resolver.prototype, 'resolve6', async () => []);
  await validateTargetUrl('http://rebind-host.com/');
  rebound = true;
  const proxy = await createSafeProxy();
  try {
    const response = await proxyRequest(proxy, 'http://rebind-host.com/');
    assert.equal(response.status, 403);
    assert.match(response.body, /DNS/);
  } finally { await proxy.close(); }
});

test('CONNECT cannot use demo exemption or a private destination', async () => {
  const proxy = await createSafeProxy({ demoOrigin: 'http://127.0.0.1:443' });
  try {
    const response = await new Promise((resolve, reject) => {
      const endpoint = new URL(proxy.server);
      const socket = net.connect({ host: endpoint.hostname, port: Number(endpoint.port) });
      socket.setEncoding('utf8');
      socket.setTimeout(5_000, () => socket.destroy(new Error('CONNECT test timeout')));
      let received = '';
      socket.on('data', (chunk) => { received += chunk; });
      socket.on('error', reject);
      socket.on('end', () => resolve(received));
      socket.on('connect', () => socket.write(`CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n\r\n`));
    });
    assert.match(response, /^HTTP\/1\.1 403/);
  } finally { await proxy.close(); }
});

async function browserAvailable() {
  try {
    const { chromium } = await import('playwright');
    for (const path of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', chromium.executablePath()]) {
      try { await access(path); return true; } catch { /* Try the next executable. */ }
    }
  } catch { /* Unit tests still run without a browser installation. */ }
  return false;
}

test('real Chromium audit: screenshot, clipped carousel, rules and blocked requests', { timeout: 60_000 }, async (t) => {
  if (!await browserAvailable()) return t.skip('Chrome/Edge/Playwright Chromium is not installed.');
  const reached = [];
  const fixture = http.createServer((request, response) => {
    reached.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"><title>Тест аудита</title><style>
      html,body{margin:0;padding:0}body{min-height:11000px;font:16px sans-serif}
      #carousel{width:390px;overflow:hidden}#hidden-slide{width:1200px;height:30px}
      #wide-image{width:600px;height:40px}#tiny{width:20px;height:20px;padding:0;border:0}
      #small{font-size:10px}#hidden{display:none;font-size:8px}
      </style></head><body><div id="carousel"><div id="hidden-slide">Clipped carousel</div></div>
      <img id="wide-image" alt="Wide image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='40'%3E%3Crect fill='red' width='600' height='40'/%3E%3C/svg%3E">
      <button id="tiny">x</button><p id="small">Мелкий видимый текст</p><p id="hidden">Скрытый текст</p>
      <script>fetch('/demo.html',{method:'POST',body:'not sent'}).catch(()=>{});fetch('/private').catch(()=>{});new WebSocket('ws://127.0.0.1:1/private');</script>
      </body></html>`);
  });
  const origin = await listen(fixture);
  const progress = [];
  try {
    const report = await runAudit({ url: `${origin}/demo.html`, demoOrigin: origin, onProgress: (event) => progress.push(event.percent) });
    assert.equal(report.title, 'Тест аудита');
    assert.equal(report.devices.length, 1);
    assert.equal(report.devices[0].id, 'selected');
    assert.equal(report.devices[0].screenshot.height, 10_000);
    assert.ok(report.devices[0].screenshot.width >= 390);
    assert.match(report.devices[0].screenshot.data, /^data:image\/png;base64,/);
    assert.ok(report.resources.failed.every((entry) => !entry.url.endsWith('/demo.html')));
    assert.ok(report.resources.failed.some((entry) => entry.url.endsWith('/private')));
    assert.ok(report.notes.some((note) => note.includes('GET/HEAD: 1')));
    assert.deepEqual(reached, ['GET /demo.html']);
    const checks = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.equal(checks.viewport.status, 'pass');
    assert.equal(checks.overflow.status, 'fail');
    assert.ok(!checks.overflow.details.some((entry) => entry.selector === '#hidden-slide'));
    assert.equal(checks.images.status, 'fail');
    assert.equal(checks['font-size'].status, 'warning');
    assert.ok(checks['font-size'].details.some((entry) => entry.selector === '#small'));
    assert.ok(!checks['font-size'].details.some((entry) => entry.selector === '#hidden'));
    assert.equal(checks['tap-targets'].status, 'fail');
    assert.equal(checks.zoom.status, 'warning');
    assert.equal(checks['http-status'].status, 'pass');
    assert.equal(checks.resources.status, 'warning');
    assert.equal(progress.at(-1), 100);
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
    assert.deepEqual(report.summary, summarizeChecks(report.checks).summary);
    assert.equal(report.score, report.devices[0].score);
  } finally { await closeServer(fixture); }
});

test('abort promptly closes an in-flight browser navigation and proxy sockets', { timeout: 30_000 }, async (t) => {
  if (!await browserAvailable()) return t.skip('Chrome/Edge/Playwright Chromium is not installed.');
  const controller = new AbortController();
  let reached;
  const requested = new Promise((resolve) => { reached = resolve; });
  const fixture = http.createServer((_request, _response) => reached());
  const origin = await listen(fixture);
  try {
    const auditing = runAudit({ url: `${origin}/demo.html`, demoOrigin: origin, signal: controller.signal });
    // Observe rejection immediately, even if startup fails before the fixture receives a request.
    const rejected = assert.rejects(auditing, { name: 'AbortError' });
    await Promise.race([requested, auditing]);
    const started = Date.now();
    controller.abort();
    await rejected;
    assert.ok(Date.now() - started < 5_000, 'Cancellation should close Chromium and proxy promptly.');
  } finally { controller.abort(); await closeServer(fixture); }
});
