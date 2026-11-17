import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let occupied;
let child;
let baseUrl;
let occupiedPort;
let startupOutput = '';

before(async () => {
  occupied = net.createServer(socket => socket.end());
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  occupiedPort = occupied.address().port;
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(occupiedPort), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', data => { startupOutput += data; });
  baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${startupOutput}`)), 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${startupOutput}`)); });
    child.stdout.on('data', data => {
      startupOutput += data;
      const match = startupOutput.match(/Adaptive Lab запущен: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
});
after(async () => {
  if (child && child.exitCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await ended;
  }
  if (occupied?.listening) await new Promise(resolve => occupied.close(resolve));
});
const post = (body, headers = {}) => fetch(`${baseUrl}/api/audits`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Adaptive-Lab': '1', ...headers }, body: JSON.stringify(body) });

test('occupied port is skipped without stopping its owner', async () => {
  assert.ok(occupied.listening);
  assert.notEqual(new URL(baseUrl).port, String(occupiedPort));
  assert.match(startupOutput, /Чужие процессы не затрагиваются/);
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.service, 'adaptive-lab');
  assert.equal(health.localOnly, true);
});
test('production UI and self-contained demo are served', async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Adaptive Lab/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const demo = await fetch(`${baseUrl}/demo.html`);
  assert.equal(demo.status, 200);
  assert.match(await demo.text(), /FORMA/);
});
test('cross-origin API calls are blocked', async () => {
  assert.equal((await post({ demo: true }, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/history`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
test('mutation requires custom local header', async () => {
  const response = await fetch(`${baseUrl}/api/audits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"demo":true}' });
  assert.equal(response.status, 403);
});
test('invalid screen parameters and URLs fail before browser launch', async () => {
  for (const body of [{ width: 0, demo: true }, { height: 99999, demo: true }, { width: 390.5, demo: true }, { mode: 'invalid', demo: true }, { mobile: 'yes', demo: true }, { url: '' }, { url: 'file:///etc/passwd' }, { url: 'http://127.0.0.1/' }, { url: 'http://169.254.169.254/' }]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.ok((await response.json()).error);
  }
  assert.equal((await (await fetch(`${baseUrl}/api/health`)).json()).activeJob, null);
});
test('unknown report and malformed JSON return useful errors', async () => {
  assert.equal((await fetch(`${baseUrl}/api/reports/not-found`)).status, 404);
  const response = await fetch(`${baseUrl}/api/audits`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Adaptive-Lab': '1' }, body: '{not json' });
  assert.equal(response.status, 400);
  assert.ok((await response.json()).error);
});
