import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { mergeReports, summarizeReport } from './report-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = path.join(root, '.pages-reports');
const reports = await mergeReports(store, path.join(root, '.audit-output'));
const output = path.join(root, 'dist-pages/reports');
await mkdir(output, { recursive: true });
for (const report of reports) await copyFile(path.join(store, `${report.id}.json`), path.join(output, `${report.id}.json`));
await writeFile(path.join(output, 'index.json'), JSON.stringify({ version: 1, publishedAt: new Date().toISOString(), reports: reports.map(summarizeReport) }));
await writeFile(path.join(root, 'dist-pages/.nojekyll'), '');
console.log(`Pages: ${reports.length} отчётов; сборка dist-pages. Локальная папка data не публикуется.`);
