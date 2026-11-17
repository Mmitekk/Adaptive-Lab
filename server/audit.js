import { access } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { abortError, createSafeProxy, validateTargetUrl } from './network.js';

const MAX_DETAILS = 30;
const MAX_SCREENSHOT_HEIGHT = 10_000;
const RENDER_TYPES = new Set(['document', 'stylesheet', 'script', 'image', 'font', 'media', 'xhr', 'fetch']);
const WEIGHTS = Object.freeze({
  viewport: 20, overflow: 20, 'font-size': 10, 'tap-targets': 15,
  zoom: 5, legacy: 10, images: 10, 'http-status': 7, resources: 3,
});

export function selectDevices(width, height, mobile, mode) {
  const selected = { id: 'selected', name: 'Выбранный экран', width, height, mobile };
  if (mode === 'quick') return [selected];
  return [selected, ...[
    { id: 'mobile-320', name: 'Компактный смартфон', width: 320, height: 740, mobile: true },
    { id: 'mobile-375', name: 'Смартфон', width: 375, height: 812, mobile: true },
    { id: 'tablet', name: 'Планшет', width: 768, height: 1024, mobile: true },
    { id: 'desktop', name: 'Большой экран', width: 1440, height: 900, mobile: false },
  ].filter((device) => device.width !== width)];
}

export function summarizeChecks(checks) {
  const summary = { passed: 0, warnings: 0, failed: 0 };
  for (const check of checks) {
    if (check.status === 'pass') summary.passed++;
    else if (check.status === 'warning') summary.warnings++;
    else if (check.status === 'fail') summary.failed++;
  }
  const weightTotal = checks.reduce((sum, check) => sum + (WEIGHTS[check.id] || 0), 0);
  const penalty = checks.reduce((sum, check) => sum + (WEIGHTS[check.id] || 0)
    * (check.status === 'fail' ? 1 : check.status === 'warning' ? 0.5 : 0), 0);
  return {
    score: weightTotal ? Math.max(0, Math.round(100 * (1 - penalty / weightTotal))) : 100,
    summary,
    status: summary.failed ? 'fail' : summary.warnings ? 'warning' : 'pass',
  };
}

export function buildChecks(snapshot, { httpStatus = null, failedResources = [], navigationWarning = '' } = {}) {
  const check = (id, title, status, category, description, recommendation, details = []) => ({
    id, title, status, category, description, recommendation, details: details.slice(0, MAX_DETAILS),
  });
  const viewport = snapshot.viewports.join(', ');
  const deviceWidth = snapshot.viewports.some((content) => /(?:^|[,;\s])width\s*=\s*device-width(?:$|[,;\s])/i.test(content));
  const zoomDisabled = snapshot.viewports.some((content) => /(?:^|[,;\s])user-scalable\s*=\s*(?:no|0)(?:$|[,;\s])/i.test(content)
    || [...content.matchAll(/(?:^|[,;\s])maximum-scale\s*=\s*([\d.]+)/gi)]
      .some((match) => Number.isFinite(Number(match[1])) && Number(match[1]) <= 1));
  const overflow = snapshot.domWidth > snapshot.layoutWidth + 2;
  const tapStatus = snapshot.tinyTapCount ? 'fail' : snapshot.smallTapCount ? 'warning' : 'pass';
  return [
    check('viewport', 'Мобильный viewport', deviceWidth ? 'pass' : 'fail', 'core',
      !snapshot.viewports.length ? 'Мета-тег viewport отсутствует: мобильный браузер может уменьшать широкую страницу.'
        : deviceWidth ? `Найден viewport с width=device-width: ${viewport.slice(0, 240)}.`
          : `Viewport есть, но width=device-width не указан: ${viewport.slice(0, 240)}.`,
      'Укажите <meta name="viewport" content="width=device-width, initial-scale=1">. Не ограничивайте масштабирование.'),
    check('overflow', 'Горизонтальная прокрутка', overflow ? 'fail' : 'pass', 'core',
      overflow ? `Ширина документа ${snapshot.domWidth} px превышает ширину области вёрстки ${snapshot.layoutWidth} px. Найдено возможных источников: ${snapshot.overflowCount}.`
        : `Документ (${snapshot.domWidth} px) не выходит за ширину области вёрстки (${snapshot.layoutWidth} px).`,
      'Проверьте фиксированные ширины, min-width, таблицы и длинные строки. Используйте max-width: 100%, min-width: 0 и переносы. Скрытые части каруселей сами по себе не считаются ошибкой.', snapshot.overflow),
    check('font-size', 'Читаемость текста', snapshot.smallTextCount ? 'warning' : 'pass', 'core',
      snapshot.smallTextCount ? `Видимый текст меньше 12 CSS px найден в ${snapshot.smallTextCount} элементах. Это эвристика, а не измерение удобства чтения.`
        : 'В обследованном видимом тексте не обнаружен шрифт меньше 12 CSS px. Контраст и фактическое удобство чтения нужно оценить вручную.',
      'Увеличьте мелкий текст, проверьте межстрочный интервал и масштаб на реальном устройстве. Порог 12 px — внутренний ориентир Adaptive Lab.', snapshot.smallText),
    check('tap-targets', 'Размеры интерактивных элементов', tapStatus, 'extra',
      `Целей с одной стороной меньше 24 CSS px: ${snapshot.tinyTapCount}; дополнительных целей меньше 44 CSS px: ${snapshot.smallTapCount}. Учитываются видимые связанные подписи полей; расстояния между целями не проверяются.`,
      'Увеличьте доступную для нажатия область примерно до 44×44 CSS px и проверьте интервалы. 24/44 px — эвристики этого инструмента, не официальные пороги Яндекса и не заключение о соответствии WCAG.', [...snapshot.tinyTaps, ...snapshot.smallTaps]),
    check('zoom', 'Масштабирование страницы', zoomDisabled ? 'warning' : 'pass', 'extra',
      zoomDisabled ? 'Viewport содержит user-scalable=no/0 или maximum-scale ≤ 1. Это может мешать увеличению текста.'
        : 'В мета-тегах viewport не найдено запрета масштабирования.',
      'Уберите user-scalable=no и слишком низкий maximum-scale. Проверьте увеличение страницы на реальном мобильном устройстве.'),
    check('legacy', 'Устаревшие плагины', snapshot.legacyCount ? 'fail' : 'pass', 'core',
      snapshot.legacyCount ? `Найдены видимые элементы Flash, Silverlight или Java applet: ${snapshot.legacyCount}. Chromium не поддерживает эти плагины.`
        : 'Видимых элементов Flash, Silverlight и Java applet не обнаружено. Обычные object/embed без признаков этих плагинов не считаются ошибкой.',
      'Замените Flash, Silverlight и applet на HTML, SVG, Canvas или стандартное видео.', snapshot.legacy),
    check('images', 'Изображения в границах страницы', snapshot.imageOverflowCount ? 'fail' : 'pass', 'core',
      snapshot.imageOverflowCount ? `Изображения, расширяющие документ за область вёрстки: ${snapshot.imageOverflowCount}.`
        : 'Не обнаружены видимые изображения, расширяющие документ по горизонтали.',
      'Для адаптивных изображений используйте max-width: 100% и height: auto; проверьте размеры контейнера и object-fit.', snapshot.imageOverflow),
    check('http-status', 'Ответ страницы', httpStatus !== null && httpStatus >= 400 ? 'fail'
      : httpStatus === null || navigationWarning ? 'warning' : 'pass', 'extra',
      `${httpStatus === null ? 'HTTP-статус основной страницы не получен.' : `Основная страница вернула HTTP ${httpStatus}.`}${navigationWarning ? ` ${navigationWarning}` : ''}`,
      'Страница должна открываться без сетевых ошибок. При 4xx/5xx проверьте доступность, защиту от ботов и ответ сервера; не обходите CAPTCHA.'),
    check('resources', 'Загрузка ресурсов', failedResources.length ? 'warning' : 'pass', 'extra',
      failedResources.length ? `Не удалось загрузить ресурсов, влияющих на отображение: ${failedResources.length}. Результат может быть неполным.`
        : 'Среди наблюдавшихся ресурсов отображения не обнаружены ошибки загрузки. Намеренно заблокированные POST-запросы сюда не включены.',
      'Проверьте адреса CSS, JS, шрифтов и изображений, сертификаты и сетевые ответы. Ограничения безопасности аудитора также могут блокировать ресурсы.'),
  ];
}

// Runs exclusively inside the fresh browser context. Coordinates are document-relative CSS pixels.
export function collectPageMetrics() {
  const root = document.documentElement;
  const body = document.body;
  const layoutWidth = root.clientWidth || innerWidth;
  const domWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0, layoutWidth);
  const domHeight = Math.max(root.scrollHeight, body?.scrollHeight || 0, innerHeight);
  const result = {
    title: document.title.slice(0, 300),
    viewports: [...document.querySelectorAll('meta[name]')]
      .filter((element) => element.getAttribute('name').toLowerCase() === 'viewport')
      .map((element) => (element.getAttribute('content') || '').slice(0, 1_000)).slice(0, 10),
    domWidth, domHeight, layoutWidth,
    overflow: [], overflowCount: 0, smallText: [], smallTextCount: 0,
    tinyTaps: [], tinyTapCount: 0, smallTaps: [], smallTapCount: 0,
    legacy: [], legacyCount: 0, imageOverflow: [], imageOverflowCount: 0,
    inspectedElements: 0, truncated: false,
  };
  const styles = new WeakMap();
  const styleOf = (element) => {
    if (!styles.has(element)) styles.set(element, getComputedStyle(element));
    return styles.get(element);
  };
  const selectorOf = (element) => {
    if (element.id && document.getElementById(element.id) === element) return `#${CSS.escape(element.id)}`.slice(0, 240);
    const parts = [];
    for (let current = element; current && parts.length < 5; current = current.parentElement) {
      let index = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === current.localName) index++;
      }
      parts.unshift(`${CSS.escape(current.localName)}:nth-of-type(${index})`);
    }
    return parts.join(' > ').slice(0, 300);
  };
  const visibleRect = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const visible = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    let depth = 0;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (++depth > 200) return null;
      const style = styleOf(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return null;
      if (ancestor === element || ancestor === root || ancestor === body) continue;
      const clipX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX);
      const clipY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY);
      if (clipX || clipY) {
        const parent = ancestor.getBoundingClientRect();
        if (clipX) {
          visible.left = Math.max(visible.left, parent.left + ancestor.clientLeft);
          visible.right = Math.min(visible.right, parent.left + ancestor.clientLeft + ancestor.clientWidth);
        }
        if (clipY) {
          visible.top = Math.max(visible.top, parent.top + ancestor.clientTop);
          visible.bottom = Math.min(visible.bottom, parent.top + ancestor.clientTop + ancestor.clientHeight);
        }
      }
      if (visible.right <= visible.left || visible.bottom <= visible.top) return null;
    }
    if (visible.right + scrollX <= 0 || visible.left + scrollX >= domWidth
      || visible.bottom + scrollY <= 0 || visible.top + scrollY >= domHeight) return null;
    return {
      x: visible.left + scrollX, y: visible.top + scrollY,
      width: visible.right - visible.left, height: visible.bottom - visible.top,
    };
  };
  const detail = (element, rect, reason) => ({
    selector: selectorOf(element),
    text: (element.getAttribute('aria-label') || element.getAttribute('alt')
      || element.textContent || element.getAttribute('title') || element.localName)
      .replace(/\s+/g, ' ').trim().slice(0, 160),
    x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100,
    width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100,
    reason,
  });
  const add = (list, count, element, rect, reason) => {
    result[count]++;
    if (result[list].length < 30) result[list].push(detail(element, rect, reason));
  };
  // A bounded traversal prevents a pathological DOM from growing the returned report indefinitely.
  const walker = document.createTreeWalker(body || root, NodeFilter.SHOW_ELEMENT);
  let element = walker.currentNode;
  while (element) {
    if (++result.inspectedElements > 20_000) { result.truncated = true; break; }
    const rect = visibleRect(element);
    if (rect) {
      const style = styleOf(element);
      const expandsDocument = domWidth > layoutWidth + 2
        && rect.x + rect.width > layoutWidth + 2 && rect.x + rect.width <= domWidth + 2;
      if (element !== root && element !== body && expandsDocument) {
        add('overflow', 'overflowCount', element, rect, 'Видимая часть элемента выходит за область вёрстки и входит в горизонтальную ширину документа.');
        if (element.matches('img,svg,video,canvas')) {
          add('imageOverflow', 'imageOverflowCount', element, rect, 'Изображение или графический элемент расширяет документ по горизонтали.');
        }
      }
      const hasText = !element.matches('script,style,noscript,template')
        && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const fontSize = parseFloat(style.fontSize);
      if (hasText && fontSize > 0 && fontSize < 12) {
        add('smallText', 'smallTextCount', element, rect, `Шрифт ${Math.round(fontSize * 10) / 10} CSS px меньше 12 px (эвристика).`);
      }
      if (element.matches('a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[onclick],[tabindex]:not([tabindex="-1"])')
        && !element.matches(':disabled,[aria-disabled="true"]') && !element.closest('[inert]') && style.pointerEvents !== 'none') {
        let target = rect;
        // A label is also a real activation area for a checkbox/radio or other labelled input.
        for (const label of element.labels || []) {
          const labelRect = visibleRect(label);
          if (labelRect && Math.min(labelRect.width, labelRect.height) > Math.min(target.width, target.height)) target = labelRect;
        }
        const side = Math.min(target.width, target.height);
        if (side < 24) add('tinyTaps', 'tinyTapCount', element, target,
          `Область нажатия ${Math.round(target.width)}×${Math.round(target.height)} CSS px: одна сторона меньше 24 px (эвристика; исключения и интервалы не оценивались).`);
        else if (side < 44) add('smallTaps', 'smallTapCount', element, target,
          `Область нажатия ${Math.round(target.width)}×${Math.round(target.height)} CSS px: рекомендуется около 44×44 px.`);
      }
      if (element.matches('applet,object,embed')) {
        const signature = [element.getAttribute('type'), element.getAttribute('data'), element.getAttribute('src'), element.getAttribute('classid'),
          ...[...element.querySelectorAll('param')].map((param) => param.getAttribute('value'))].filter(Boolean).join(' ');
        if (element.localName === 'applet' || /shockwave|flash|silverlight|\.swf(?:[?#\s]|$)|\.xap(?:[?#\s]|$)|d27cdb6e|dfeaf541/i.test(signature)) {
          add('legacy', 'legacyCount', element, rect, 'Обнаружен видимый элемент устаревшего браузерного плагина.');
        }
      }
    }
    element = walker.nextNode();
  }
  return result;
}

async function installedBrowser() {
  for (const [path, name] of [
    ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'Google Chrome'],
    ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'Microsoft Edge'],
  ]) {
    try { await access(path); return { executablePath: path, name }; } catch { /* Try the next installed browser. */ }
  }
  return { executablePath: undefined, name: 'Playwright Chromium' };
}

function awaitBounded(promise, signal, timeout = 0, message = 'Превышено время операции аудита.') {
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => finish(reject, abortError());
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    // Always observe the operation, including rejection after a cancellation.
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeout) timer = setTimeout(() => finish(reject, new Error(message)), timeout);
  });
}

function safeError(error) {
  return String(error?.message || error).split('\n')[0].slice(0, 300);
}

/** Audit an untrusted public page without a user profile, interactions, TLS bypass or private-network access. */
export async function runAudit({ url, width = 390, height = 844, mobile = true, mode = 'quick', demoOrigin = null, signal, onProgress = () => {} }) {
  const started = performance.now();
  if (!Number.isInteger(width) || width < 280 || width > 2560 || !Number.isInteger(height) || height < 280 || height > 2560) {
    throw new Error('Ширина и высота должны быть целыми числами от 280 до 2560 px.');
  }
  if (!['quick', 'full'].includes(mode)) throw new Error('Неизвестный режим аудита. Выберите quick или full.');
  if (typeof mobile !== 'boolean') throw new Error('Параметр mobile должен быть логическим значением.');
  if (signal?.aborted) throw abortError();
  let lastPercent = 0;
  const progress = (percent, label) => {
    lastPercent = Math.max(lastPercent, Math.min(100, Math.round(percent)));
    try { onProgress({ percent: lastPercent, label }); } catch { /* UI observer cannot affect cleanup. */ }
  };
  progress(2, 'Проверяем адрес и публичные DNS-записи');
  const target = await validateTargetUrl(url, { demoOrigin, signal });
  const selectedDevices = selectDevices(width, height, mobile, mode);
  let browser;
  let proxy;
  let activeDevice;
  const proxyFailures = [];
  const devices = [];
  const allFailures = [];
  const consoleErrors = [];
  const notes = [
    'Это независимый аудит Adaptive Lab. Он не воспроизводит алгоритмы Яндекса и не гарантирует индексацию, позиции или соответствие требованиям поисковых систем.',
    'Используется эмуляция viewport в Chromium, а не реальный смартфон, Safari или робот Яндекса. Итоговые проверки и оценка относятся к первому выбранному экрану.',
    'Оценка — эвристика: 100 минус взвешенные штрафы; ошибка — полный вес, предупреждение — половина. Веса: viewport 20, переполнение 20, текст 10, нажатия 15, масштаб 5, плагины 10, изображения 10, HTTP 7, ресурсы 3.',
    'Снимок — неинтерактивное изображение. Аудитор не нажимает кнопки, не принимает cookie, не отправляет формы и не обходит CAPTCHA. Проверяется исходное состояние страницы в новом профиле.',
    'Измерения охватывают основной документ без содержимого iframe и Shadow DOM. Скрытые элементы и контент, загружаемый только после прокрутки или действий, могут остаться непроверенными.',
    'loadMs — время ожидания DOMContentLoaded (либо тайм-аута навигации), а не полной загрузки и не метрика Core Web Vitals.',
    'Разрешены только GET/HEAD по публичным HTTP/HTTPS на портах 80/443. WebSocket и service worker отключены; сетевые лимиты и отсутствие действий могут отличать результат от обычного посещения.',
  ];
  let selectedFinalUrl = target.href;
  let selectedTitle = '';
  let selectedUserAgent = '';
  let browserName = '';
  let requestCount = 0;
  let blockedMutations = 0;
  const closeResources = async () => {
    await Promise.allSettled([proxy?.close(), browser?.close()]);
  };
  const onAbort = () => { void closeResources(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    proxy = await createSafeProxy({
      demoOrigin, signal,
      onBlocked: (entry) => { if (proxyFailures.length < 200) proxyFailures.push({ ...entry, deviceId: activeDevice }); },
    });
    progress(8, 'Запускаем изолированный браузер');
    const { chromium } = await import('playwright');
    const installed = await installedBrowser();
    if (signal?.aborted) throw abortError();
    const launch = chromium.launch({
      executablePath: installed.executablePath, headless: true, chromiumSandbox: true, timeout: 20_000,
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: '<-loopback>' },
      args: [
        '--proxy-bypass-list=<-loopback>', '--disable-quic', '--no-pings',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      ],
    }).then(async (instance) => {
      if (signal?.aborted) { await instance.close(); throw abortError(); }
      browser = instance;
      return instance;
    });
    browser = await awaitBounded(launch, signal);
    browserName = `${installed.name} ${browser.version()} (headless Chromium)`;
    progress(14, 'Браузер готов');
    for (const [index, device] of selectedDevices.entries()) {
      if (signal?.aborted) throw abortError();
      activeDevice = device.id;
      const stage = (fraction, label) => progress(14 + (index + fraction) / selectedDevices.length * 82, `${device.width}×${device.height}: ${label}`);
      const userAgent = device.mobile
        ? `Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()}${device.width < 768 ? ' Mobile' : ''} Safari/537.36`
        : undefined;
      const context = await awaitBounded(browser.newContext({
        viewport: { width: device.width, height: device.height }, screen: { width: device.width, height: device.height },
        deviceScaleFactor: 1, isMobile: device.mobile, hasTouch: device.mobile, userAgent,
        locale: 'ru-RU', colorScheme: 'light', serviceWorkers: 'block',
        acceptDownloads: false, ignoreHTTPSErrors: false,
      }), signal);
      try {
        let page;
        const deliberatelyBlocked = new WeakSet();
        const failed = [];
        const failureKeys = new Set();
        let deviceRequests = 0;
        let httpStatus = null;
        let navigationWarning = '';
        let observing = true;
        const recordFailure = (request, reason) => {
          if (!observing || deliberatelyBlocked.has(request) || !['GET', 'HEAD'].includes(request.method())
            || !RENDER_TYPES.has(request.resourceType())) return;
          const resourceUrl = request.url().slice(0, 2_048);
          const key = `${resourceUrl}\n${reason}`;
          if (!failureKeys.has(key)) {
            failureKeys.add(key);
            if (failed.length < 200) failed.push({ url: resourceUrl, reason: reason.slice(0, 300) });
          }
        };
        await context.route('**/*', async (route) => {
          const request = route.request();
          try {
            const protocol = new URL(request.url()).protocol;
            if (!['GET', 'HEAD'].includes(request.method())) {
              deliberatelyBlocked.add(request);
              blockedMutations++;
              await route.abort('blockedbyclient');
            } else if (!['http:', 'https:'].includes(protocol)) {
              recordFailure(request, 'Протокол заблокирован политикой безопасности аудитора.');
              deliberatelyBlocked.add(request);
              await route.abort('blockedbyclient');
            } else {
              // Every connection and redirect is validated and pinned by the local proxy.
              await route.continue();
            }
          } catch { try { await route.abort('blockedbyclient'); } catch { /* Context may have closed. */ } }
        });
        if (typeof context.routeWebSocket !== 'function') throw new Error('Для безопасного аудита требуется Playwright с поддержкой routeWebSocket (1.48 или новее).');
        await context.routeWebSocket('**/*', (socket) => socket.close({ code: 1008, reason: 'WebSocket отключён в режиме аудита' }));
        page = await context.newPage();
        context.on('page', (popup) => { if (popup !== page) void popup.close().catch(() => {}); });
        page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
        page.on('download', (download) => { void download.cancel().catch(() => {}); });
        page.on('request', (request) => {
          if (observing) { deviceRequests++; requestCount++; }
        });
        page.on('requestfailed', (request) => recordFailure(request, `Ошибка загрузки: ${request.failure()?.errorText || 'нет ответа'}`));
        page.on('response', (response) => {
          const request = response.request();
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) httpStatus = response.status();
          if (response.status() >= 400 && !(request.isNavigationRequest() && request.frame() === page.mainFrame())) {
            recordFailure(request, `HTTP ${response.status()}`);
          }
        });
        page.on('console', (message) => {
          if (observing && message.type() === 'error' && consoleErrors.length < 100) consoleErrors.push(message.text().slice(0, 500));
        });
        page.on('pageerror', (error) => {
          if (observing && consoleErrors.length < 100) consoleErrors.push(safeError(error));
        });
        stage(0.04, 'Открываем страницу');
        const navigationStart = performance.now();
        try {
          const response = await awaitBounded(page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }), signal);
          if (response) httpStatus = response.status();
        } catch (error) {
          if (signal?.aborted) throw abortError();
          if (error.name === 'TimeoutError' && page.url() !== 'about:blank') {
            navigationWarning = 'За 30 секунд страница не завершила DOMContentLoaded; проверяется доступное состояние.';
          } else throw new Error(`Не удалось открыть страницу. Проверьте доступность сайта и сертификат. ${safeError(error)}`);
        }
        const loadMs = Math.round(performance.now() - navigationStart);
        stage(0.45, 'Ждём отрисовку (не более 1,5 с)');
        await awaitBounded(page.waitForTimeout(1_200), signal);
        // Reset script-driven initial scrolling without clicking or activating anything.
        await awaitBounded(page.evaluate(() => { window.scrollTo(0, 0); }), signal, 5_000, 'Страница не отвечает на запрос измерения.');
        stage(0.6, 'Измеряем вёрстку и элементы');
        const snapshot = await awaitBounded(page.evaluate(collectPageMetrics), signal, 8_000, 'Страница слишком долго отвечает на измерение вёрстки.');
        if (snapshot.truncated) notes.push(`${device.width} px: обследование DOM ограничено первыми 20 000 элементами; часть страницы не проверена.`);
        if (index === 0) {
          selectedFinalUrl = page.url();
          selectedTitle = snapshot.title;
          selectedUserAgent = await awaitBounded(page.evaluate(() => navigator.userAgent), signal, 3_000);
        }
        stage(0.8, 'Сохраняем цветной снимок');
        const clipWidth = Math.min(4096, Math.max(device.width, snapshot.domWidth));
        const clipHeight = Math.min(MAX_SCREENSHOT_HEIGHT, Math.max(device.height, snapshot.domHeight));
        if (snapshot.domHeight > MAX_SCREENSHOT_HEIGHT) notes.push(`${device.width} px: снимок ограничен первыми 10 000 CSS px по высоте.`);
        if (snapshot.domWidth > 4096) notes.push(`${device.width} px: очень широкий снимок обрезан до 4096 CSS px.`);
        const image = await awaitBounded(page.screenshot({
          type: 'png', fullPage: true, clip: { x: 0, y: 0, width: clipWidth, height: clipHeight },
          scale: 'css', animations: 'disabled', timeout: 15_000,
        }), signal);
        observing = false;
        // Proxy explanations replace opaque Chromium tunnel/HTTP errors where possible.
        for (const failure of failed) {
          const explained = proxyFailures.find((entry) => entry.deviceId === device.id
            && (entry.url === failure.url || (() => {
              try { return new URL(entry.url).origin === new URL(failure.url).origin; } catch { return false; }
            })()));
          if (explained) failure.reason = explained.reason;
        }
        const checks = buildChecks(snapshot, { httpStatus, failedResources: failed, navigationWarning });
        const { score, status } = summarizeChecks(checks);
        allFailures.push(...failed);
        const seen = new Set();
        const elements = checks.flatMap((check) => check.details.map((entry) => ({ ...entry, checkId: check.id, status: check.status })))
          .filter((entry) => { const key = `${entry.checkId}:${entry.selector}`; if (seen.has(key)) return false; seen.add(key); return true; });
        devices.push({
          id: device.id, name: device.name, width: device.width, height: device.height,
          score, status, checks,
          metrics: { domWidth: snapshot.domWidth, loadMs, requestCount: deviceRequests, failedRequests: failed.length },
          screenshot: { data: `data:image/png;base64,${image.toString('base64')}`, width: image.readUInt32BE(16), height: image.readUInt32BE(20) },
          elements,
        });
        stage(1, 'Проверки завершены');
      } finally {
        await context.close().catch(() => {});
      }
    }
    if (signal?.aborted) throw abortError();
    if (blockedMutations) notes.push(`Намеренно заблокированы запросы, отличные от GET/HEAD: ${blockedMutations}. Они не учитываются как ошибки загрузки страницы.`);
    if (proxyFailures.length) notes.push(`Защищённый прокси отклонил или ограничил запросы: ${proxyFailures.length}. Частные адреса и недоступные ресурсы могут делать результат неполным.`);
    if (demoOrigin) notes.push('Демо-исключение разрешает только /demo.html на явно заданном локальном стенде; другие локальные страницы и ресурсы запрещены.');
    const first = devices[0];
    const { summary } = summarizeChecks(first.checks);
    progress(99, 'Формируем отчёт');
    const report = {
      url: target.href, finalUrl: selectedFinalUrl, title: selectedTitle,
      checkedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
      viewport: { width, height }, score: first.score, summary, checks: first.checks, devices,
      resources: { total: requestCount, failed: allFailures, consoleErrors },
      environment: { browser: browserName, userAgent: selectedUserAgent }, notes,
    };
    await closeResources();
    report.durationMs = Math.round(performance.now() - started);
    progress(100, 'Аудит завершён');
    return report;
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw abortError();
    if (/Executable doesn't exist|browserType\.launch/.test(error.message || '')) {
      throw new Error(`Не удалось запустить Chrome/Edge/Chromium для аудита. Установите браузер или Chromium для Playwright. ${safeError(error)}`);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await closeResources();
  }
}
