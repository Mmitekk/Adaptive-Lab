import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { runAudit } from './audit.js';
import { validateTargetUrl } from './network.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.join(root, 'data');
const app = express();
const server = http.createServer(app);
const reports = new Map();
const jobs = new Map();
let activeJob = null;
let port;

await mkdir(dataDirectory, { recursive: true });
for (const name of await readdir(dataDirectory)) {
  if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
  try {
    const report = JSON.parse(await readFile(path.join(dataDirectory, name), 'utf8'));
    if (report.id && Array.isArray(report.devices)) reports.set(report.id, report);
  } catch { console.warn(`Не удалось прочитать сохранённый отчёт ${name}`); }
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
    return res.status(403).json({ error: 'Сервис доступен только через локальный адрес.' });
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if ((origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Запросы с других сайтов запрещены.' });
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.get('x-adaptive-lab') !== '1') {
      return res.status(403).json({ error: 'Необходим локальный запрос Adaptive Lab.' });
    }
  }
  next();
});
app.use(express.json({ limit: '8kb' }));

const historyList = () => [...reports.values()].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).map(({ id, url, title, checkedAt, score, summary, viewport, isDemo, devices }) => ({ id, url, title, checkedAt, score, summary, viewport, isDemo, deviceCount: devices.length }));
app.get('/api/health', (req, res) => res.json({ service: 'adaptive-lab', status: 'ok', version: '1.0.0', engine: 'Chromium', localOnly: true, activeJob: activeJob?.id || null }));
app.get('/api/history', (req, res) => res.json(historyList()));
app.get('/api/reports/:id', (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Отчёт не найден. Возможно, он удалён из истории.' });
  res.json(report);
});
app.delete('/api/reports/:id', async (req, res, next) => {
  try {
    if (!reports.has(req.params.id)) return res.status(404).json({ error: 'Отчёт не найден.' });
    await unlink(path.join(dataDirectory, `${req.params.id}.json`));
    reports.delete(req.params.id);
    res.json({ deleted: true });
  } catch (error) { next(error); }
});

app.post('/api/audits', async (req, res, next) => {
  try {
    if (activeJob) return res.status(409).json({ error: 'Одна проверка уже выполняется. Дождитесь завершения или отмените её.' });
    const { width = 390, height = 844, mode = 'quick', mobile = true, demo = false } = req.body || {};
    if (!Number.isInteger(width) || width < 280 || width > 2560 || !Number.isInteger(height) || height < 280 || height > 2560) {
      return res.status(400).json({ error: 'Ширина и высота должны быть от 280 до 2560 px.' });
    }
    if (!['quick', 'full'].includes(mode) || typeof mobile !== 'boolean' || typeof demo !== 'boolean') {
      return res.status(400).json({ error: 'Некорректные параметры проверки.' });
    }
    const demoOrigin = demo ? `http://127.0.0.1:${port}` : null;
    const raw = demo ? `${demoOrigin}/demo.html` : req.body?.url;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return res.status(400).json({ error: 'Введите адрес страницы (до 2048 символов).' });
    const url = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : (raw.includes('://') ? raw.trim() : `https://${raw.trim()}`);
    try { await validateTargetUrl(url, { demoOrigin }); } catch (error) { return res.status(400).json({ error: error.message }); }
    if (activeJob) return res.status(409).json({ error: 'Проверка уже выполняется.' });
    const job = { id: randomUUID(), state: 'running', percent: 3, label: 'Запускаем изолированный Chromium', controller: new AbortController() };
    activeJob = job;
    jobs.set(job.id, job);
    res.status(202).json({ id: job.id });
    const deadline = setTimeout(() => job.controller.abort(new Error('Проверка превысила лимит 4 минуты. Попробуйте один экран.')), 240000);
    try {
      const result = await runAudit({ url, width, height, mode, mobile, demoOrigin, signal: job.controller.signal, onProgress: (progress) => Object.assign(job, progress) });
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      const report = { ...result, id: job.id, isDemo: demo, mode };
      await writeFile(path.join(dataDirectory, `${job.id}.tmp`), JSON.stringify(report));
      await rename(path.join(dataDirectory, `${job.id}.tmp`), path.join(dataDirectory, `${job.id}.json`));
      reports.set(job.id, report);
      for (const expired of historyList().slice(20)) {
        await unlink(path.join(dataDirectory, `${expired.id}.json`));
        reports.delete(expired.id);
      }
      Object.assign(job, { state: 'complete', percent: 100, label: 'Проверка завершена', reportId: job.id });
    } catch (error) {
      const cancelled = job.controller.signal.aborted;
      Object.assign(job, { state: cancelled ? 'cancelled' : 'error', error: cancelled ? (job.controller.signal.reason?.message || 'Проверка отменена.') : (error.message || 'Не удалось проверить страницу.') });
      console.warn(`[audit ${job.id}] ${job.error}`);
    } finally {
      clearTimeout(deadline);
      activeJob = null;
      setTimeout(() => jobs.delete(job.id), 600000).unref();
    }
  } catch (error) { next(error); }
});
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Проверка не найдена. Обновите страницу.' });
  const { controller, ...state } = job;
  res.json(state);
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.state !== 'running') return res.status(409).json({ error: 'Эта проверка уже завершена.' });
  job.controller.abort(new Error('Проверка отменена.'));
  res.json({ cancelled: true });
});
app.get('/demo.html', (req, res) => res.sendFile(path.join(root, 'public/demo.html')));

if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/', (req, res) => res.sendFile(path.join(root, 'dist/index.html')));
}
app.use((req, res) => res.status(404).json({ error: 'Адрес не найден.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.type === 'entity.parse.failed' || error.type === 'entity.too.large' ? 400 : 500).json({ error: error.type?.startsWith('entity.') ? 'Некорректный запрос.' : 'Внутренняя ошибка. Подробности в журнале сервера.' });
  console.error(error.message);
});

const firstPort = Number(process.env.PORT || 4177);
if (!Number.isInteger(firstPort) || firstPort < 1024 || firstPort > 65515) throw new Error('PORT должен быть целым числом от 1024 до 65515.');
for (let candidate = firstPort; candidate < firstPort + 20; candidate++) {
  try {
    await new Promise((resolve, reject) => {
      const fail = (error) => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', fail); resolve(); };
      server.once('error', fail);
      server.once('listening', ready);
      port = candidate;
      server.listen(candidate, '127.0.0.1');
    });
    break;
  } catch (error) {
    if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    console.log(`Порт ${candidate} недоступен; пробуем следующий. Чужие процессы не затрагиваются.`);
  }
}
if (!server.listening) throw new Error('Свободный порт не найден. Укажите другой PORT.');
const localUrl = `http://127.0.0.1:${port}`;
if (process.env.NODE_ENV !== 'test') await writeFile(path.join(root, '.runtime.json'), JSON.stringify({ pid: process.pid, port, url: localUrl, startedAt: new Date().toISOString() }, null, 2));
console.log(`\nAdaptive Lab запущен: ${localUrl}\nТолько локальный доступ. История: ${dataDirectory}\n`);
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => {
  activeJob?.controller.abort(new Error('Сервер останавливается.'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
