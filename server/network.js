import http from 'node:http';
import net from 'node:net';
import dns, { Resolver } from 'node:dns/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';

const DNS_TIMEOUT_MS = 4_000;
const SOCKET_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TUNNEL_BYTES = 80 * 1024 * 1024;
const MAX_TOTAL_BYTES = 240 * 1024 * 1024;
const MAX_CONNECTIONS = 80;
const MAX_REQUESTS = 2_000;
const IPV4_DENY = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '168.63.129.16/32', // Azure platform endpoint looks public but serves runner infrastructure.
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
].map((cidr) => ipaddr.parseCIDR(cidr));
const IPV6_DENY = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20']
  .map((cidr) => ipaddr.parseCIDR(cidr));
const IPV6_GLOBAL = ipaddr.parseCIDR('2000::/3');

export function abortError() {
  return new DOMException('Аудит отменён.', 'AbortError');
}

function fail(message) {
  const error = new Error(message);
  error.code = 'UNSAFE_TARGET';
  return error;
}

function hostnameOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

export function isPublicAddress(address) {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv4') {
      return parsed.range() === 'unicast' && !IPV4_DENY.some((cidr) => parsed.match(cidr));
    }
    // Conservatively exclude transition/mapped addresses, not just their private payloads.
    return parsed.range() === 'unicast' && parsed.match(IPV6_GLOBAL)
      && !IPV6_DENY.some((cidr) => parsed.match(cidr));
  } catch {
    return false;
  }
}

function allowedDemoOrigin(raw) {
  if (!raw) return null;
  let origin;
  try { origin = new URL(raw); } catch { throw fail('Некорректный адрес демонстрационного стенда.'); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.port === '0'
    || origin.username || origin.password || origin.pathname !== '/'
    || origin.search || origin.hash) {
    throw fail('Демонстрационный стенд должен иметь локальный HTTP-адрес 127.0.0.1.');
  }
  return origin.origin;
}

function isDemo(url, demoOrigin) {
  return demoOrigin !== null && url.origin === demoOrigin
    && url.protocol === 'http:' && url.pathname === '/demo.html';
}

function parseTarget(raw, demoOrigin) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 8_192) {
    throw fail('Введите полный HTTP- или HTTPS-адрес сайта.');
  }
  let url;
  try { url = new URL(raw.trim()); } catch { throw fail('Не удалось распознать адрес сайта.'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw fail('Разрешены только публичные HTTP- и HTTPS-страницы.');
  }
  if (url.username || url.password || /^[a-z]+:\/\/[^/?#]*@/i.test(raw.trim())) {
    throw fail('Адрес не должен содержать логин или пароль.');
  }
  if (isDemo(url, demoOrigin)) return url;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (port !== 80 && port !== 443) throw fail('Для публичных сайтов разрешены только порты 80 и 443.');
  const hostname = hostnameOf(url);
  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) throw fail('Локальные, частные и зарезервированные IP-адреса запрещены.');
  } else if (!hostname.includes('.') || /(^|\.)(localhost|local|internal|home|lan|test|invalid|example|onion)$/.test(hostname)) {
    throw fail('Локальные и служебные имена узлов запрещены.');
  }
  return url;
}

async function systemDnsResults(hostname, signal) {
  // Windows VPN/DoH configurations may expose a non-listening stub to c-ares.
  // Ask the OS for ALL records of EACH family instead; never fall back to an unchecked connect.
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => finish(reject, fail('Превышено время проверки системного DNS (4 секунды).')), DNS_TIMEOUT_MS);
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    Promise.allSettled([4, 6].map((family) => dns.lookup(hostname, { family, all: true, verbatim: true })
      .then((records) => records.map((record) => record.address))))
      .then((results) => finish(resolve, results), (error) => finish(reject, error));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function resolvePublic(hostname, signal) {
  if (signal?.aborted) throw abortError();
  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw fail('Непубличный IP-адрес заблокирован.');
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  let timedOut = false;
  const cancel = () => resolver.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; resolver.cancel(); }, DNS_TIMEOUT_MS);
  timer.unref?.();
  try {
    // Resolve BOTH families; one public answer cannot hide a private answer in the other.
    let results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (signal?.aborted) throw abortError();
    if (timedOut) throw fail('Превышено время проверки DNS (4 секунды).');
    let systemFallback = false;
    if (results.every((result) => result.status === 'rejected'
      && ['ECONNREFUSED', 'EREFUSED', 'ESERVFAIL'].includes(result.reason?.code))) {
      clearTimeout(timer);
      results = await systemDnsResults(hostname, signal);
      systemFallback = true;
    }
    if (signal?.aborted) throw abortError();
    const addresses = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        addresses.push(...result.value.map((address) => ({ address, family: index ? 6 : 4 })));
      } else if (!['ENODATA', 'ENOTFOUND', ...(systemFallback ? ['ENOENT'] : [])].includes(result.reason?.code)) {
        throw fail('Не удалось безопасно проверить все DNS-адреса сайта.');
      }
    }
    if (!addresses.length) throw fail('DNS не вернул IP-адрес сайта. Проверьте адрес.');
    if (addresses.some(({ address }) => !isPublicAddress(address))) {
      throw fail('DNS сайта содержит локальный, частный или зарезервированный IP-адрес.');
    }
    return addresses;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}

async function resolveTarget(raw, { demoOrigin = null, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const demo = allowedDemoOrigin(demoOrigin);
  const url = parseTarget(raw, demo);
  const addresses = isDemo(url, demo)
    ? [{ address: '127.0.0.1', family: 4 }]
    : await resolvePublic(hostnameOf(url), signal);
  return { url, addresses };
}

/** Async API validation; returns a canonical URL object. The proxy validates again at connection time. */
export async function validateTargetUrl(raw, options = {}) {
  return (await resolveTarget(raw, options)).url;
}

const HOP_HEADERS = new Set([
  'connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
  'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
]);

function cleanHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of String(headers.connection || '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

/** An authenticated, short-lived HTTP forward proxy. DNS answers are never handed back to Chromium. */
export async function createSafeProxy({ demoOrigin = null, signal, onBlocked = () => {} } = {}) {
  allowedDemoOrigin(demoOrigin);
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const sockets = new Set();
  const timers = new Set();
  const username = 'adaptive-lab';
  const password = randomBytes(24).toString('hex');
  const authorization = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  let closed = false;
  let requests = 0;
  let totalBytes = 0;
  let closePromise;
  const notify = (url, reason) => {
    try { onBlocked({ url: String(url).slice(0, 2_048), reason }); } catch { /* Observer only. */ }
  };
  const server = http.createServer({
    maxHeaderSize: 16_384, requestTimeout: SOCKET_TIMEOUT_MS,
    headersTimeout: 10_000, keepAliveTimeout: 1_000,
  });
  server.maxConnections = MAX_CONNECTIONS;
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    return socket;
  };
  server.on('connection', track);
  const deadline = (destroy) => {
    const timer = setTimeout(() => { timers.delete(timer); destroy(); }, SOCKET_TIMEOUT_MS);
    timer.unref?.();
    timers.add(timer);
    return () => { clearTimeout(timer); timers.delete(timer); };
  };
  const authenticated = (request) => {
    const value = Buffer.from(String(request.headers['proxy-authorization'] || ''));
    return value.length === authorization.length && timingSafeEqual(value, authorization);
  };
  const takeBudget = () => !closed && ++requests <= MAX_REQUESTS && totalBytes <= MAX_TOTAL_BYTES;

  server.on('request', async (request, response) => {
    const reject = (status, reason) => {
      notify(request.url, reason);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        response.end(reason);
      } else response.destroy();
    };
    if (!authenticated(request)) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="Adaptive Lab"', connection: 'close' });
      response.end();
      return;
    }
    if (!takeBudget()) return reject(503, 'Достигнут сетевой лимит аудита.');
    if (!['GET', 'HEAD'].includes(request.method)
      || request.headers.upgrade || request.headers['transfer-encoding']
      || Number(request.headers['content-length'] || 0) !== 0) {
      return reject(405, 'Аудит разрешает только GET и HEAD без тела запроса.');
    }
    let upstream;
    const cancelDeadline = deadline(() => {
      upstream?.destroy();
      reject(504, 'Превышено время сетевого запроса (30 секунд).');
    });
    response.once('close', () => { cancelDeadline(); upstream?.destroy(); });
    try {
      const { url, addresses } = await resolveTarget(request.url, { demoOrigin, signal: controller.signal });
      if (closed || response.destroyed) return;
      if (url.protocol !== 'http:') return reject(400, 'HTTPS должен использовать защищённый CONNECT-туннель.');
      const selected = addresses[0];
      const headers = cleanHeaders(request.headers);
      headers.host = url.host;
      headers.connection = 'close';
      // Numeric hostname pins the TCP destination. The HTTP Host header preserves the original origin.
      upstream = http.request({
        hostname: selected.address, family: selected.family,
        port: Number(url.port || 80), method: request.method,
        path: `${url.pathname}${url.search}`, headers, agent: false,
        maxHeaderSize: 32_768,
      });
      upstream.on('socket', track);
      upstream.on('error', () => reject(502, 'Не удалось получить ответ сайта через защищённый прокси.'));
      upstream.on('response', (incoming) => {
        const contentLength = Number(incoming.headers['content-length'] || 0);
        if (contentLength > MAX_RESPONSE_BYTES) {
          incoming.destroy();
          return reject(502, 'Ресурс превышает сетевой лимит 32 МиБ.');
        }
        response.writeHead(incoming.statusCode || 502, cleanHeaders(incoming.headers));
        let bytes = 0;
        incoming.on('data', (chunk) => {
          bytes += chunk.length;
          totalBytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
            notify(url.href, 'Превышен лимит объёма сетевых данных.');
            incoming.destroy();
            response.destroy();
          }
        });
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      });
      upstream.end();
    } catch (error) {
      if (!closed) reject(403, error.code === 'UNSAFE_TARGET' ? error.message : 'Сетевой адрес заблокирован.');
    }
  });

  server.on('connect', async (request, client, head) => {
    const reject = (status, reason, authenticate = false) => {
      if (!authenticate) notify(`https://${request.url}/`, reason);
      if (!client.destroyed) {
        client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n${authenticate ? 'Proxy-Authenticate: Basic realm="Adaptive Lab"\r\n' : ''}Content-Length: 0\r\n\r\n`);
      }
    };
    if (!authenticated(request)) return reject('407 Proxy Authentication Required', '', true);
    if (!takeBudget()) return reject('503 Service Unavailable', 'Достигнут сетевой лимит аудита.');
    let upstream;
    const cancelDeadline = deadline(() => { upstream?.destroy(); client.destroy(); });
    client.once('close', () => { cancelDeadline(); upstream?.destroy(); });
    try {
      // Strict authority form prevents @, paths, fragments and alternate CONNECT parser interpretations.
      if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):(?:80|443)$/.test(request.url)) {
        return reject('403 Forbidden', 'Недопустимый адрес CONNECT-туннеля.');
      }
      // Demo permission is intentionally NEVER applicable to CONNECT or HTTPS.
      const { url, addresses } = await resolveTarget(`https://${request.url}/`, { signal: controller.signal });
      if (closed || client.destroyed) return;
      const selected = addresses[0];
      upstream = track(net.connect({ host: selected.address, family: selected.family, port: Number(url.port || 443) }));
      upstream.once('error', () => client.destroy());
      upstream.once('close', () => client.destroy());
      upstream.once('connect', () => {
        if (closed || client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        let bytes = head.length;
        const count = (chunk) => {
          bytes += chunk.length;
          totalBytes += chunk.length;
          if (bytes > MAX_TUNNEL_BYTES || totalBytes > MAX_TOTAL_BYTES) {
            notify(url.href, 'Превышен лимит объёма HTTPS-туннеля.');
            upstream.destroy();
            client.destroy();
          }
        };
        client.on('data', count);
        upstream.on('data', count);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch (error) {
      if (!closed) reject('403 Forbidden', error.code === 'UNSAFE_TARGET' ? error.message : 'Адрес туннеля заблокирован.');
    }
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());

  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    controller.abort();
    signal?.removeEventListener('abort', onAbort);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    closePromise = new Promise((resolve) => server.close(() => resolve()));
    return closePromise;
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    if (signal?.aborted || closed) {
      // An abort can race the asynchronous listen callback.
      server.close();
      throw abortError();
    }
    server.on('error', () => { void close(); });
    return {
      server: `http://127.0.0.1:${server.address().port}`, username, password, close,
      get stats() { return { requests, bytes: totalBytes }; },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
