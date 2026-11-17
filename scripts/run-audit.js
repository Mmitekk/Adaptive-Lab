import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runAudit } from '../server/audit.js';
import { MAX_REPORT_BYTES, validateReport } from './report-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.env.AUDIT_URL || '').trim();
if (process.env.AUDIT_PUBLISH !== 'true') throw new Error('Подтвердите публикацию отчёта и снимков (publish = true).');
if (!/^https?:\/\//i.test(url) || url.length > 2048) throw new Error('Нужен полный публичный HTTP(S)-адрес, не более 2048 символов.');
const width = Number(process.env.AUDIT_WIDTH || 390);
const height = Number(process.env.AUDIT_HEIGHT || 844);
const mode = process.env.AUDIT_MODE || 'full';
const mobileInput = process.env.AUDIT_MOBILE || 'true';
if (!['true', 'false'].includes(mobileInput)) throw new Error('mobile должен быть true или false.');
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 240000);
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
try {
  const result = await runAudit({ url, width, height, mode, mobile: mobileInput === 'true', signal: controller.signal,
    onProgress: ({ percent, label }) => console.log(`${percent}% ${label}`) });
  const report = validateReport({ ...result, id: randomUUID(), mode, isDemo: false });
  const content = JSON.stringify(report);
  if (Buffer.byteLength(content) > MAX_REPORT_BYTES) throw new Error('Отчёт превышает 32 МиБ. Попробуйте режим quick.');
  const output = path.join(root, '.audit-output');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `${report.id}.json`), content);
  console.log(`Готово: ${report.score}/100, ${report.devices.length} экранов. Отчёт ${report.id}.`);
} finally { clearTimeout(timeout); }
