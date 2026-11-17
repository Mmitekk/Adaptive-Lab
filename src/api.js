export const isPages = __PAGES__;
export const repository = __REPOSITORY__;
export const workflowUrl = `https://github.com/${repository}/actions/workflows/pages.yml`;

async function readJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 404 ? 'Отчёт не найден в этой публикации. Обновите историю.' : 'Не удалось загрузить отчёты. Проверьте соединение.');
  return response.json();
}

export async function api(url, options = {}) {
  if (isPages) {
    if (options.method && options.method !== 'GET') throw new Error('На GitHub Pages изменения выполняются через GitHub Actions.');
    if (url === '/api/health') return { status: 'ok', engine: 'GitHub Actions', activeJob: null };
    if (url === '/api/history') return (await readJson('./reports/index.json')).reports;
    const match = /^\/api\/reports\/([a-f0-9-]{36})$/.exec(url);
    if (match) return readJson(`./reports/${match[1]}.json`);
    throw new Error('Эта операция доступна только в локальном режиме.');
  }
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-Adaptive-Lab': '1', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
  return data;
}
