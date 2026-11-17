import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = process.env.GITHUB_REPOSITORY;
const branch = process.env.DEFAULT_BRANCH || 'main';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Некорректный GITHUB_REPOSITORY.');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const runs = JSON.parse(gh(['api', `repos/${repository}/actions/workflows/pages.yml/runs?status=success&branch=${encodeURIComponent(branch)}&per_page=30`])).workflow_runs;
let restored = false;
for (const run of runs) {
  if (String(run.id) === process.env.GITHUB_RUN_ID || !['push', 'workflow_dispatch'].includes(run.event)) continue;
  const artifacts = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`])).artifacts;
  if (!artifacts.some(item => item.name === 'adaptive-lab-reports' && !item.expired)) continue;
  const destination = path.join(root, '.pages-reports');
  await mkdir(destination, { recursive: true });
  gh(['run', 'download', String(run.id), '--repo', repository, '--name', 'adaptive-lab-reports', '--dir', destination]);
  console.log(`Восстановлена история из успешного запуска ${run.id}.`);
  restored = true;
  break;
}
if (!restored) console.log('Доступной истории нет: первая публикация либо артефакты истекли (до 90 дней).');
