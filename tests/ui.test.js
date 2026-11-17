import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = process.env.TEST_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('browser UI: responsive layouts, demo, highlights, exports, history, errors and cancellation', { skip: !baseUrl, timeout: 240000 }, async () => {
  const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(baseUrl);
    await page.getByRole('heading', { name: 'Хорошо на любом экране.' }).waitFor();
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `UI overflows at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Повернуть экран', exact: true }).click();
    assert.equal(await page.getByRole('spinbutton', { name: 'Ширина экрана', exact: true }).inputValue(), '844');
    assert.equal(await page.getByRole('spinbutton', { name: 'Высота экрана', exact: true }).inputValue(), '390');
    await page.getByRole('button', { name: 'Повернуть экран', exact: true }).click();
    await page.getByRole('button', { name: 'Все экраны', exact: true }).click();
    await page.getByRole('button', { name: 'Попробовать на примере', exact: true }).click();
    await page.getByRole('button', { name: 'Экспорт', exact: true }).waitFor({ timeout: 180000 });
    await page.locator('.score-ring strong').waitFor();
    const score = Number(await page.locator('.score-ring strong').innerText());
    assert.ok(score >= 0 && score < 100, `Demo should have intentional issues, score=${score}`);
    assert.equal(await page.locator('.device-strip>button').count(), 5);
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Report overflows at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.check-heading').filter({ hasText: /Горизонтал|переполн|ширин/i }).first().click();
    const elements = page.locator('.elements-list button');
    assert.ok(await elements.count() > 0);
    await elements.first().click();
    assert.ok(await page.locator('.element-overlay').count() > 0);
    await page.getByRole('button', { name: 'Подсветка выбранной проверки', exact: true }).click();
    assert.equal(await page.locator('.element-overlay').count(), 0);
    await page.getByRole('button', { name: 'Подсветка выбранной проверки', exact: true }).click();
    await page.getByRole('button', { name: 'Открыть большой снимок', exact: true }).click();
    await page.getByRole('dialog', { name: 'Полный снимок страницы' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    const pngDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Скачать снимок PNG', exact: true }).click();
    assert.match((await pngDownload).suggestedFilename(), /\.png$/);
    await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
    const jsonDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Данные JSON', exact: true }).click();
    assert.match((await jsonDownload).suggestedFilename(), /\.json$/);
    await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
    const htmlDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'HTML-отчёт / печать', exact: true }).click();
    assert.match((await htmlDownload).suggestedFilename(), /\.html$/);
    await page.getByRole('tab', { name: 'Экраны', exact: true }).click();
    assert.equal(await page.locator('.comparison-card').count(), 5);
    await page.locator('.comparison-card').last().click();
    assert.match(await page.locator('.preview-toolbar>span').innerText(), /1440/);
    await page.getByRole('tab', { name: 'Загрузка', exact: true }).click();
    await page.getByRole('heading', { name: 'Загрузка страницы' }).waitFor();
    await page.getByRole('button', { name: 'История проверок' }).click();
    await page.getByRole('textbox', { name: 'Поиск в истории' }).fill('definitely-no-such-report');
    await page.getByRole('heading', { name: 'Ничего не найдено' }).waitFor();
    await page.getByRole('textbox', { name: 'Поиск в истории' }).fill('');
    await page.locator('.history-main').first().click();
    await page.getByRole('button', { name: 'Экспорт', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Адрес страницы', exact: false }).fill('http://127.0.0.1/');
    await page.getByRole('button', { name: 'Проверить сайт', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /локальн|публичн|частн|запрещ|недопуст/i);
    await page.getByRole('button', { name: 'Попробовать на примере', exact: true }).click();
    await page.getByRole('button', { name: 'Отменить', exact: false }).click();
    await page.getByRole('button', { name: 'Проверить сайт', exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Как это работает', exact: true }).click();
    await page.getByRole('heading', { name: /Проверяем. Объясняем/ }).waitFor();
    await page.getByRole('button', { name: 'Вернуться к проверке', exact: true }).click();
    await page.screenshot({ path: path.join(root, 'ui-verified.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
