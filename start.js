import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtimePath = path.join(root, '.runtime.json');
async function getRunning() {
  try {
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(runtime.url)) return null;
    const response = await fetch(`${runtime.url}/api/health`, { signal: AbortSignal.timeout(1200) });
    const health = await response.json();
    return health.service === 'adaptive-lab' && health.status === 'ok' ? runtime : null;
  } catch { return null; }
}
let running = await getRunning();
if (!running) {
  if (!existsSync(path.join(root, 'node_modules'))) throw new Error('Сначала установите зависимости: npm install');
  if (!existsSync(path.join(root, 'dist/index.html'))) {
    const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (build.status !== 0) throw new Error('Не удалось собрать интерфейс.');
  }
  const output = openSync(path.join(root, 'server.log'), 'a');
  const errors = openSync(path.join(root, 'server-errors.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, detached: true, stdio: ['ignore', output, errors], windowsHide: true });
  closeSync(output); closeSync(errors);
  child.on('error', error => console.error(error.message));
  child.unref();
  for (let attempt = 0; attempt < 40 && !running; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    running = await getRunning();
  }
  if (!running) throw new Error('Сервер не запустился. Подробности: server-errors.log');
}
console.log(`Adaptive Lab: ${running.url}\nPID: ${running.pid}\nСервис работает в фоне. Занятые порты и чужие процессы не затрагиваются.`);
if (!process.argv.includes('--no-open')) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', running.url] : [running.url];
  const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  opener.on('error', () => console.log(`Откройте адрес вручную: ${running.url}`));
  opener.unref();
}
