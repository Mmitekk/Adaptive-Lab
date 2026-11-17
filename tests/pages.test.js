import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { MAX_REPORT_BYTES, mergeReports, readReports, summarizeReport, validateReport } from '../scripts/report-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagesUrl = process.env.TEST_PAGES_URL;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=';
const fixture = (day = 1) => ({
  id: randomUUID(), url: 'https://audit.example/', title: 'Fixture', checkedAt: new Date(Date.UTC(2026, 0, day)).toISOString(),
  score: 100, summary: { passed: 1, warnings: 0, failed: 0 }, viewport: { width: 390, height: 844 }, isDemo: false,
  devices: [{ id: 'selected', width: 390, height: 844, score: 100, checks: [{ status: 'pass', details: [] }], screenshot: { width: 390, height: 844, data: png } }],
  resources: { failed: [], consoleErrors: [] },
});

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'adaptive-pages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Pages report validation rejects paths, unsafe images and invalid dimensions', () => {
  assert.equal(validateReport(fixture()).score, 100);
  for (const mutate of [
    report => { report.id = '../outside'; },
    report => { report.url = 'javascript:alert(1)'; },
    report => { report.score = NaN; },
    report => { report.devices[0].screenshot.data = 'data:image/svg+xml,<svg/>'; },
    report => { report.devices[0].screenshot.height = 10001; },
    report => { report.devices[0].width = 100000; },
    report => { report.devices[0].checks[0].details = Array(31).fill({}); },
  ]) {
    const report = fixture();
    mutate(report);
    assert.throws(() => validateReport(report), /формат/);
  }
  const summary = summarizeReport(fixture());
  assert.equal(summary.deviceCount, 1);
  assert.equal('devices' in summary, false);
  assert.equal('resources' in summary, false);
});

test('Pages store merges, deduplicates and keeps only the newest 20 reports', async t => {
  const directory = await temporary(t);
  const incoming = path.join(directory, 'incoming');
  const store = path.join(directory, 'store');
  await mkdir(incoming);
  const reports = Array.from({ length: 22 }, (_, index) => fixture(index + 1));
  for (const report of reports) await writeFile(path.join(incoming, `${report.id}.json`), JSON.stringify(report));
  await writeFile(path.join(incoming, 'index.json'), 'not a report');
  const kept = await mergeReports(store, incoming);
  assert.equal(kept.length, 20);
  assert.equal(kept[0].id, reports[21].id);
  assert.equal(kept.at(-1).id, reports[2].id);
  assert.equal((await readdir(store)).length, 20);
  assert.equal((await mergeReports(store, incoming)).length, 20);
  assert.deepEqual(await readReports(path.join(directory, 'missing')), []);
});

test('Pages store rejects mismatched names, broken JSON and oversized files', async t => {
  const directory = await temporary(t);
  const filename = path.join(directory, `${randomUUID()}.json`);
  await writeFile(filename, JSON.stringify(fixture()));
  await assert.rejects(readReports(directory), /идентификатор/);
  await writeFile(filename, '{broken');
  await assert.rejects(readReports(directory), SyntaxError);
  await writeFile(filename, Buffer.alloc(MAX_REPORT_BYTES + 1));
  await assert.rejects(readReports(directory), /32 МиБ/);
});

test('Actions command requires publication consent and rejects invalid inputs before auditing', () => {
  const cases = [
    [{ AUDIT_PUBLISH: 'false' }, /Подтвердите публикацию/],
    [{ AUDIT_URL: 'file:///etc/passwd' }, /HTTP\(S\)/],
    [{ AUDIT_WIDTH: '0' }, /280 до 2560/],
    [{ AUDIT_HEIGHT: '280.5' }, /280 до 2560/],
    [{ AUDIT_MODE: 'unknown' }, /режим аудита/],
    [{ AUDIT_MOBILE: 'yes' }, /mobile должен/],
    [{ AUDIT_URL: 'http://127.0.0.1/' }, /публичн|частн|локальн|запрещ/i],
  ];
  for (const [overrides, expected] of cases) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/run-audit.js')], {
      env: { ...process.env, AUDIT_URL: 'https://8.8.8.8/', AUDIT_PUBLISH: 'true', AUDIT_WIDTH: '390', AUDIT_HEIGHT: '844', AUDIT_MODE: 'quick', AUDIT_MOBILE: 'true', ...overrides },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1, JSON.stringify(overrides));
    assert.match(result.stderr, expected);
  }
});

test('Pages browser: static reports, Actions dialog, exports, desktop typography and missing reports', { skip: !pagesUrl, timeout: 120000 }, async () => {
  const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  try {
    await page.route('**/reports/index.json', route => route.fulfill({ json: { version: 1, reports: [] } }));
    await page.goto(pagesUrl);
    await page.getByRole('heading', { name: 'Хорошо на любом экране.' }).waitFor();
    await page.getByRole('button', { name: 'Обновить отчёты', exact: true }).click();
    await page.getByRole('heading', { name: 'Чистый лист — хорошее начало' }).waitFor();
    await page.getByRole('button', { name: 'Проверка сайта', exact: true }).click();
    await page.getByRole('textbox', { name: 'Адрес страницы' }).fill('narkorating.ru');
    await page.getByRole('button', { name: 'Все экраны', exact: true }).click();
    await page.getByRole('button', { name: 'Проверить через Actions', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Запустить проверку в GitHub' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('#actions-url').inputValue(), 'https://narkorating.ru/');
    assert.match(await dialog.innerText(), /проверка ещё не запущена/);
    assert.deepEqual(await dialog.locator('dd').allTextContents(), ['390', '844', 'full', 'true']);
    assert.equal(await dialog.getByRole('link').getAttribute('href'), 'https://github.com/Mmitekk/Adaptive-Lab/actions/workflows/pages.yml');
    for (const width of [320, 390, 1280, 2560]) {
      await page.setViewportSize({ width, height: width === 2560 ? 1440 : 900 });
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `Dialog overflows at ${width}px`);
      assert.equal(await dialog.evaluate(element => element.getBoundingClientRect().right <= innerWidth), true);
    }
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    await page.getByRole('textbox', { name: 'Адрес страницы' }).fill('https://user:password@example.com/');
    await page.getByRole('button', { name: 'Проверить через Actions', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /без логина и пароля/);
    await page.unroute('**/reports/index.json');
    await page.reload();
    await page.getByRole('button', { name: 'Обновить отчёты', exact: true }).click();
    await page.locator('.history-main').first().waitFor();
    assert.equal(await page.locator('.history-delete').count(), 0);
    await page.locator('.history-main').first().click();
    await page.getByRole('button', { name: 'Экспорт', exact: true }).waitFor();
    assert.equal(await page.locator('.screenshot-image').evaluate(image => image.complete && image.naturalWidth > 0), true);
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    for (const width of [320, 390, 768, 1024, 1200, 1280, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: width === 2560 ? 1440 : 1080 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Report overflows at ${width}px`);
      if (width >= 1920) {
        const dimensions = await page.evaluate(() => ({
          h1: getComputedStyle(document.querySelector('h1')).fontSize,
          input: getComputedStyle(document.querySelector('#site-url')).fontSize,
          details: getComputedStyle(document.querySelector('.check-heading small')).fontSize,
          main: document.querySelector('main').getBoundingClientRect().width,
        }));
        assert.equal(dimensions.h1, '39px');
        assert.equal(dimensions.input, '24px');
        assert.equal(dimensions.details, '18px');
        if (width === 2560) assert.ok(dimensions.main > 2100);
        await page.screenshot({ path: path.join(root, `artifacts/pages-${width}.png`) });
      }
    }
    await page.locator('.check-heading').filter({ hasText: /интерактивных/i }).click();
    await page.locator('.elements-list button').first().click();
    assert.ok(await page.locator('.element-overlay').count() > 0);
    const pngDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Скачать снимок PNG', exact: true }).click();
    assert.match((await pngDownload).suggestedFilename(), /\.png$/);
    await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
    const jsonDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Данные JSON', exact: true }).click();
    const exported = JSON.parse(await readFile(await (await jsonDownload).path(), 'utf8'));
    assert.equal(exported.devices.length, 5);
    await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
    const htmlDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'HTML-отчёт / печать', exact: true }).click();
    assert.match(await readFile(await (await htmlDownload).path(), 'utf8'), /<!doctype html>/);
    await page.getByRole('tab', { name: 'Экраны', exact: true }).click();
    assert.equal(await page.locator('.comparison-card').count(), 5);
    await page.locator('.comparison-card').last().click();
    assert.match(await page.locator('.preview-toolbar > span').innerText(), /1440/);
    await page.getByRole('button', { name: 'История проверок', exact: true }).click();
    await page.getByRole('textbox', { name: 'Поиск в истории' }).fill('no-such-report-example');
    await page.getByRole('heading', { name: 'Ничего не найдено' }).waitFor();
    await page.getByRole('textbox', { name: 'Поиск в истории' }).fill('');
    await page.route(/\/reports\/[a-f0-9-]{36}\.json$/, route => route.fulfill({ status: 404, body: 'Not found' }));
    await page.locator('.history-main').first().click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /Отчёт не найден/);
    assert.deepEqual(errors, []);
    assert.equal(requests.some(request => new URL(request.url).pathname.includes('/api/')), false);
    assert.equal(requests.some(request => request.method !== 'GET'), false);
  } finally { await browser.close(); }
});
