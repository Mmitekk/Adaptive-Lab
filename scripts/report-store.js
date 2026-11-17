import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export const reportFilePattern = /^[a-f0-9-]{36}\.json$/;
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;
export const MAX_STORE_BYTES = 200 * 1024 * 1024;

export function validateReport(report) {
  const invalid = () => { throw new Error('Некорректный формат отчёта.'); };
  if (!report || !reportFilePattern.test(`${report.id}.json`) || typeof report.url !== 'string' || !/^https?:\/\//.test(report.url)
    || !Number.isFinite(Date.parse(report.checkedAt)) || !Number.isFinite(report.score) || report.score < 0 || report.score > 100
    || !Number.isInteger(report.viewport?.width) || !Number.isInteger(report.viewport?.height)
    || !Array.isArray(report.devices) || !report.devices.length || report.devices.length > 5
    || !Array.isArray(report.resources?.failed) || !Array.isArray(report.resources?.consoleErrors)) invalid();
  for (const device of report.devices) {
    if (!Number.isFinite(device.score) || device.score < 0 || device.score > 100 || !Number.isInteger(device.width) || device.width < 280 || device.width > 2560
      || !Number.isInteger(device.height) || device.height < 280 || device.height > 2560 || !Array.isArray(device.checks)
      || !Number.isInteger(device.screenshot?.width) || device.screenshot.width < 1 || device.screenshot.width > 4096
      || !Number.isInteger(device.screenshot?.height) || device.screenshot.height < 1 || device.screenshot.height > 10000
      || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(device.screenshot?.data || '')) invalid();
    for (const check of device.checks) {
      if (!['pass', 'warning', 'fail'].includes(check.status) || !Array.isArray(check.details) || check.details.length > 30) invalid();
    }
  }
  return report;
}

export function summarizeReport({ id, url, title, checkedAt, score, summary, viewport, isDemo, devices }) {
  return { id, url, title, checkedAt, score, summary, viewport, isDemo, deviceCount: devices.length };
}

export async function readReports(directory) {
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const reports = [];
  for (const name of names) {
    if (!reportFilePattern.test(name)) continue;
    const raw = await readFile(path.join(directory, name));
    if (raw.length > MAX_REPORT_BYTES) throw new Error(`Отчёт ${name} превышает 32 МиБ.`);
    const report = validateReport(JSON.parse(raw));
    if (name !== `${report.id}.json`) throw new Error('Имя отчёта не совпадает с идентификатором.');
    reports.push({ report, bytes: raw.length });
  }
  return reports.sort((a, b) => b.report.checkedAt.localeCompare(a.report.checkedAt));
}

export async function mergeReports(directory, incomingDirectory) {
  await mkdir(directory, { recursive: true });
  for (const { report } of await readReports(incomingDirectory)) {
    await writeFile(path.join(directory, `${report.id}.json`), JSON.stringify(report));
  }
  let total = 0;
  const kept = [];
  for (const entry of await readReports(directory)) {
    if (kept.length < 20 && total + entry.bytes <= MAX_STORE_BYTES) {
      kept.push(entry.report);
      total += entry.bytes;
    } else await unlink(path.join(directory, `${entry.report.id}.json`));
  }
  return kept;
}
