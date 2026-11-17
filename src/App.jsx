import React, { useEffect, useRef, useState } from 'react';
import { api, isPages } from './api.js';
import ActionsDialog from './ActionsDialog.jsx';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2, Expand, ExternalLink, FileJson, FileText, Globe2, History, Info, Layers3, LoaderCircle, Monitor, MousePointer2, Plus, RotateCcw, ScanLine, Search, ShieldCheck, Smartphone, Tablet, Trash2, X } from 'lucide-react';

const presets = [
  { id: 'iphone14', name: 'iPhone 14', width: 390, height: 844, mobile: true },
  { id: 'iphone16', name: 'iPhone 16 Pro', width: 402, height: 874, mobile: true },
  { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667, mobile: true },
  { id: 'pixel', name: 'Google Pixel 7', width: 412, height: 915, mobile: true },
  { id: 'small', name: 'Маленький экран', width: 320, height: 740, mobile: true },
  { id: 'ipad', name: 'iPad', width: 768, height: 1024, mobile: true },
  { id: 'desktop', name: 'Desktop', width: 1440, height: 900, mobile: false },
];
const labels = { pass: 'Пройдено', warning: 'Рекомендация', fail: 'Проблема' };
const formatDate = value => new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const domain = report => { try { return report.isDemo ? 'Демонстрационный сайт' : new URL(report.url).hostname; } catch { return report.url; } };
function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
function htmlReport(report) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Adaptive Lab — отчёт</title><style>body{font:15px/1.6 system-ui;max-width:1000px;margin:40px auto;padding:24px;color:#222}h1{font-size:38px;letter-spacing:-2px}h2{margin-top:40px}article{border:1px solid #ddd;padding:16px;margin:12px 0;break-inside:avoid}small{color:#666}img{max-width:350px;width:100%;border:1px solid #ddd}code{overflow-wrap:anywhere}button{padding:10px}@media print{img{max-height:650px;width:auto}article{break-inside:avoid}}</style><h1>Adaptive Lab / Отчёт</h1><p>${escapeHtml(report.url)}</p><small>${escapeHtml(formatDate(report.checkedAt))} · Chromium · Независимая эвристическая оценка, не заключение Яндекса</small>${report.devices.map(device => `<h2>${escapeHtml(device.name)} · ${device.width} × ${device.height} · ${device.score}/100</h2>${device.checks.map(check => `<article><b>${escapeHtml(labels[check.status])} — ${escapeHtml(check.title)}</b><p>${escapeHtml(check.description)}</p>${check.status !== 'pass' ? `<p>${escapeHtml(check.recommendation)}</p>` : ''}${check.details?.length ? `<ul>${check.details.map(item => `<li><code>${escapeHtml(item.selector)}</code> ${escapeHtml(item.reason || item.text)}</li>`).join('')}</ul>` : ''}</article>`).join('')}${/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(device.screenshot?.data || '') ? `<img alt="Снимок страницы" src="${device.screenshot.data}">` : ''}`).join('')}<h2>Условия проверки</h2><p>Эмуляция экранов в Chromium, а не реальные устройства или Safari. Один снимок состояния страницы; интерактивные сценарии требуют ручного тестирования. Размеры текста и целей нажатия — рекомендации лаборатории.</p>${(report.notes || []).map(note => `<p>${escapeHtml(note)}</p>`).join('')}</html>`;
}
function StatusIcon({ status, size = 17 }) { return <span className={`status-icon ${status}`}>{status === 'pass' ? <Check size={size} /> : status === 'fail' ? <X size={size - 1} /> : <span>!</span>}</span>; }
function DeviceIcon({ width, size = 17 }) { const Icon = width >= 1000 ? Monitor : width >= 600 ? Tablet : Smartphone; return <Icon size={size} />; }

export default function App() {
  const [view, setView] = useState('audit');
  const [url, setUrl] = useState('');
  const [preset, setPreset] = useState('iphone14');
  const [width, setWidth] = useState(390);
  const [height, setHeight] = useState(844);
  const [mobile, setMobile] = useState(true);
  const [mode, setMode] = useState('quick');
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState({ percent: 0, label: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [deviceIndex, setDeviceIndex] = useState(0);
  const [tab, setTab] = useState('overview');
  const [filter, setFilter] = useState('all');
  const [openRule, setOpenRule] = useState(null);
  const [highlight, setHighlight] = useState(null);
  const [showHighlights, setShowHighlights] = useState(true);
  const [zoom, setZoom] = useState('fit');
  const [expanded, setExpanded] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [search, setSearch] = useState('');
  const [online, setOnline] = useState(true);
  const [actionDraft, setActionDraft] = useState(null);
  const previewRef = useRef(null);
  const firstField = useRef(null);
  const busy = Boolean(jobId) || submitting;
  const device = report?.devices[deviceIndex] || report?.devices[0];
  const checks = device?.checks || [];
  const counts = { pass: checks.filter(c => c.status === 'pass').length, warning: checks.filter(c => c.status === 'warning').length, fail: checks.filter(c => c.status === 'fail').length };
  const refreshHistory = () => api('/api/history').then(setHistory);
  const loadReport = async id => {
    const result = await api(`/api/reports/${id}`);
    setReport(result); setDeviceIndex(0); setHighlight(null); setOpenRule(null); setView('audit'); setTab('overview'); setError('');
    if (!result.isDemo) setUrl(result.url);
    return result;
  };
  useEffect(() => {
    Promise.all([refreshHistory(), api('/api/health').then(health => { if (health.activeJob) setJobId(health.activeJob); })]).catch(err => { setOnline(false); setError(err.message); });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!expanded) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const listener = event => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', listener);
    return () => { document.body.style.overflow = old; window.removeEventListener('keydown', listener); };
  }, [expanded]);
  useEffect(() => {
    if (!jobId) return;
    let alive = true; let timer;
    const update = async () => {
      try {
        const status = await api(`/api/jobs/${jobId}`);
        if (!alive) return;
        setProgress(status);
        if (status.state === 'complete') {
          await loadReport(status.reportId); await refreshHistory();
          if (alive) { setJobId(null); setToast('Проверка завершена. Отчёт сохранён локально.'); }
        } else if (['error', 'cancelled'].includes(status.state)) {
          setJobId(null);
          if (status.state === 'error') setError(status.error); else setToast(status.error);
        } else timer = setTimeout(update, 900);
      } catch (err) { if (alive) { setJobId(null); setError(err.message); } }
    };
    update();
    return () => { alive = false; clearTimeout(timer); };
  }, [jobId]);
  async function startAudit(demo = false) {
    if (busy) return;
    setError('');
    if (isPages) {
      try {
        const target = demo && !url.trim() ? null : new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
        if (target && (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)) throw new Error('Используйте HTTP(S)-адрес без логина и пароля.');
        if (![Number(width), Number(height)].every(value => Number.isInteger(value) && value >= 280 && value <= 2560)) throw new Error('Размеры экрана должны быть от 280 до 2560 px.');
        setActionDraft({ url: target?.href || '', width: Number(width), height: Number(height), mobile, mode });
      } catch (err) { setError(err.message === 'Invalid URL' ? 'Введите корректный адрес страницы.' : err.message); }
      return;
    }
    setSubmitting(true); setView('audit');
    try {
      const result = await api('/api/audits', { method: 'POST', body: JSON.stringify({ url, width: Number(width), height: Number(height), mobile, mode, demo }) });
      setProgress({ percent: 2, label: 'Подготавливаем проверку' }); setJobId(result.id); setOnline(true);
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  }
  function choosePreset(value) {
    setPreset(value);
    const selected = presets.find(p => p.id === value);
    if (selected) { setWidth(selected.width); setHeight(selected.height); setMobile(selected.mobile); }
  }
  function newAudit() { setView('audit'); setReport(null); setUrl(''); setError(''); setHighlight(null); setTimeout(() => firstField.current?.focus(), 0); }
  async function cancel() { try { await api(`/api/jobs/${jobId}/cancel`, { method: 'POST' }); setProgress(p => ({ ...p, label: 'Останавливаем проверку…' })); } catch (err) { setError(err.message); } }
  function exportReport(type) {
    if (!report) return;
    const name = `adaptive-lab-${report.isDemo ? 'demo' : domain(report)}-${report.id.slice(0, 8)}`;
    download(type === 'json' ? JSON.stringify(report, null, 2) : htmlReport(report), `${name}.${type}`, type === 'json' ? 'application/json' : 'text/html;charset=utf-8');
    setExportMenu(false); setToast('Отчёт подготовлен для скачивания.');
  }
  async function removeReport(item) {
    if (!window.confirm(`Удалить проверку «${domain(item)}» из локальной истории?`)) return;
    try { await api(`/api/reports/${item.id}`, { method: 'DELETE' }); await refreshHistory(); if (report?.id === item.id) setReport(null); setToast('Проверка удалена.'); } catch (err) { setError(err.message); }
  }
  function revealElement(item) {
    setHighlight(item); setShowHighlights(true);
    requestAnimationFrame(() => {
      const image = previewRef.current?.querySelector('.screenshot-image');
      if (image) previewRef.current.scrollTo({ top: Math.max(0, item.y * (image.clientWidth / device.screenshot.width) - 70), left: Math.max(0, item.x * (image.clientWidth / device.screenshot.width) - 20), behavior: 'smooth' });
    });
  }
  const screenshotDownload = () => { if (!device) return; const a = document.createElement('a'); a.href = device.screenshot.data; a.download = `adaptive-${device.width}x${device.height}.png`; a.click(); };
  const relevantChecks = checks.filter(c => filter === 'all' || (filter === 'issues' ? c.status !== 'pass' : c.status === filter));
  const overlayItems = highlight ? [highlight] : openRule ? checks.find(c => c.id === openRule)?.details || [] : [];

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView('audit'); }} aria-label="Adaptive Lab — главная"><span className="brand-symbol">a<span>.</span></span><span>adaptive<span className="brand-light">lab</span><small>RESPONSIVE WORKSPACE</small></span></a>
      <div className="workspace-label">ВАША ЛАБОРАТОРИЯ</div>
      <nav className="main-nav" aria-label="Основная навигация">
        <button aria-label="Проверка сайта" title="Проверка сайта" className={view === 'audit' ? 'nav-item active' : 'nav-item'} onClick={() => setView('audit')}><ScanLine size={19} /><span>Проверка сайта</span><span className="nav-shortcut">↗</span></button>
        <button aria-label="История проверок" title="История проверок" className={view === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('history'); refreshHistory().catch(err => setError(err.message)); }}><History size={18} /><span>История проверок</span>{history.length > 0 && <span className="nav-count">{history.length}</span>}</button>
        <button aria-label="Как это работает" title="Как это работает" className={view === 'method' ? 'nav-item active' : 'nav-item'} onClick={() => setView('method')}><Layers3 size={18} /><span>Как это работает</span></button>
      </nav>
      <div className="sidebar-divider" />
      <div className="recent-heading"><span>НЕДАВНИЕ</span><button title="Новая проверка" aria-label="Новая проверка" onClick={newAudit}><Plus size={16} /></button></div>
      <div className="recent-list">{history.length ? history.slice(0, 4).map(item => <button key={item.id} className="recent-item" onClick={() => loadReport(item.id).catch(err => setError(err.message))}><span className="recent-favicon"><Globe2 size={14} /></span><span><strong>{domain(item)}</strong><small>{formatDate(item.checkedAt)}</small></span><span className="recent-score">{item.score}</span></button>) : <p className="recent-empty">Здесь будут ваши<br />последние проверки</p>}</div>
      <div className="sidebar-bottom"><div className="local-illustration"><Monitor size={32} strokeWidth={1} /><Smartphone size={19} strokeWidth={1.4} /></div><strong>{isPages ? 'Chromium в GitHub Actions.' : 'Ваш сайт. Ваши данные.'}</strong><p>{isPages ? 'Опубликованные отчёты доступны посетителям Pages.' : <>Проверки и отчёты остаются<br />на этом компьютере.</>}</p><span className="version"><span />{isPages ? 'GITHUB PAGES + ACTIONS' : 'LOCAL WORKSPACE · V1.0'}</span></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">Инструменты <ChevronRight size={14} /><span>{view === 'history' ? 'История проверок' : view === 'method' ? 'Методика' : 'Адаптивность сайта'}</span></div><div className="topbar-right"><span className={`connection ${online ? '' : 'offline'}`}><span />{online ? (isPages ? 'GitHub Pages' : 'Локальный сервер') : 'Нет соединения'}</span><span className="topbar-divider" /><button className="icon-button" title="О лаборатории" aria-label="О лаборатории" onClick={() => setView('method')}><CircleHelp size={19} /></button></div></header>
      <main>
        {view === 'audit' && <>
          <section className="page-heading"><div><div className="eyebrow"><span /> ПИКСЕЛИ ПОД КОНТРОЛЕМ</div><h1>Хорошо на любом экране<span>.</span></h1><p>Проверьте адаптивность сайта. Посмотрите на него глазами ваших пользователей.</p></div><span className="heading-mark" aria-hidden="true"><Smartphone size={34} strokeWidth={1.2} /><Monitor size={59} strokeWidth={1} /></span></section>
          <section className="audit-form panel" aria-label="Параметры проверки">
            <form onSubmit={event => { event.preventDefault(); startAudit(false); }}>
              <label className="form-label" htmlFor="site-url">Адрес страницы <span>Проверяем конкретную страницу, не весь сайт</span></label>
              <div className="url-row"><div className="url-field"><Globe2 size={20} /><input ref={firstField} id="site-url" type="text" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://ваш-сайт.ru" required maxLength={2048} autoComplete="url" spellCheck="false" disabled={busy} /><span className="input-hint">URL</span></div><button className="primary-button" disabled={busy} type="submit">{busy ? <LoaderCircle className="spin" size={17} /> : <ScanLine size={18} />}{busy ? 'Проверяем…' : isPages ? 'Проверить через Actions' : 'Проверить сайт'}{!busy && <ArrowRight size={17} />}</button></div>
              <div className="settings-row"><div className="device-select"><Smartphone size={16} /><select aria-label="Устройство" value={preset} onChange={event => choosePreset(event.target.value)} disabled={busy}>{presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="custom">Свой размер</option></select><ChevronDown size={13} /></div><div className="dimensions"><input aria-label="Ширина экрана" type="number" min="280" max="2560" value={width} disabled={busy} onChange={event => { setWidth(event.target.value); setPreset('custom'); }} /><span>×</span><input aria-label="Высота экрана" type="number" min="280" max="2560" value={height} disabled={busy} onChange={event => { setHeight(event.target.value); setPreset('custom'); }} /><span>px</span></div><button className="icon-button rotate-button" type="button" title="Повернуть экран" aria-label="Повернуть экран" disabled={busy} onClick={() => { setWidth(height); setHeight(width); setPreset('custom'); }}><RotateCcw size={16} /></button><label className="mobile-checkbox" title="Мобильный User-Agent и эмуляция касаний"><input type="checkbox" checked={mobile} disabled={busy} onChange={event => setMobile(event.target.checked)} />Мобильный режим</label><div className="mode-control" aria-label="Объём проверки"><button type="button" className={mode === 'quick' ? 'selected' : ''} disabled={busy} onClick={() => setMode('quick')}><Smartphone size={14} />Один экран</button><button type="button" className={mode === 'full' ? 'selected' : ''} disabled={busy} onClick={() => setMode('full')}><Layers3 size={14} />Все экраны</button></div></div>
            </form>
            <div className="form-footer"><span><ShieldCheck size={14} />{isPages ? 'Запуск с правами на репозиторий' : 'Без входа в аккаунт'}<i /> Реальный Chromium <i /> {isPages ? 'Очередь Actions + проверка + публикация' : mode === 'quick' ? 'Обычно 15–40 секунд' : 'До 4 минут · 4–5 размеров'}</span><button onClick={() => startAudit(true)} disabled={busy}>{isPages ? 'Как запустить проверку' : 'Попробовать на примере'}<ArrowUpRight size={14} /></button></div>
          </section>
          {isPages && <div className="pages-notice panel"><div><Info size={20} /><p>Проверка запускается в GitHub Actions, а результат появляется здесь после публикации. URL и снимки будут доступны посетителям Pages.</p></div><button className="subtle-button" onClick={async () => { try { await refreshHistory(); setOnline(true); setView('history'); setError(''); } catch (err) { setError(err.message); } }}><RotateCcw size={17} />Обновить отчёты</button></div>}
          {error && <div className="error-banner" role="alert"><Info size={18} /><span>{error}</span><button aria-label="Закрыть ошибку" onClick={() => setError('')}><X size={16} /></button></div>}
          {busy && <section className="progress-panel" aria-live="polite"><div className="progress-heading"><span><LoaderCircle size={17} className="spin" />{progress.label || 'Подготавливаем браузер'}</span><button onClick={cancel} disabled={!jobId}>Отменить <X size={13} /></button></div><div className="progress-track"><div style={{ width: `${Math.min(progress.percent || 3, 100)}%` }} /></div><p>Открываем страницу без ваших cookies и авторизации. Формы не отправляются.</p></section>}
          <div className={`result-grid ${busy ? 'is-running' : ''}`}>
            <section className="results-column">
              <div className="section-heading"><h2>Результат проверки</h2>{report ? <div className="export-container"><button className="subtle-button" onClick={() => setExportMenu(!exportMenu)} aria-expanded={exportMenu}><ArrowDownToLine size={15} />Экспорт<ChevronDown size={12} /></button>{exportMenu && <div className="dropdown"><button onClick={() => exportReport('html')}><FileText size={16} />HTML-отчёт / печать</button><button onClick={() => exportReport('json')}><FileJson size={16} />Данные JSON</button></div>}</div> : <span className="small-label">ОЖИДАЕТ ПРОВЕРКИ</span>}</div>
              {!report ? <div className="empty-results panel"><div className="empty-icon"><ScanLine size={29} strokeWidth={1.3} /><span /></div><h3>Один адрес.<br />Полная картина.</h3><p className="empty-description">Узнайте, что мешает вашему сайту<br className="desktop-break" /> быть удобным на маленьком экране.</p><div className="feature-list"><div><span className="feature-number">01</span><div><strong>Проверка ключевых параметров</strong><p>Viewport, ширина контента, шрифты и кнопки</p></div><CheckCheck size={19} /></div><div><span className="feature-number">02</span><div><strong>Сайт как на ладони</strong><p>Снимки экранов и подсветка проблемных мест</p></div><Smartphone size={19} /></div><div><span className="feature-number">03</span><div><strong>Понятный следующий шаг</strong><p>Конкретные элементы и рекомендации</p></div><MousePointer2 size={19} /></div></div><div className="empty-bottom"><span>Начните с адреса выше</span><ArrowUpRight size={18} /></div></div> : <>
                <div className="score-card panel"><div className="score-ring" style={{ '--score': `${device.score}%` }}><div><strong>{device.score}</strong><span>ИЗ 100</span></div></div><div className="score-copy"><div className="score-eyebrow">АДАПТИВНОСТЬ СТРАНИЦЫ</div><h3>{counts.fail ? 'Есть над чем поработать' : counts.warning ? 'Хорошо, но можно лучше' : 'Экрану всё подходит'}</h3><p>{domain(report)}<span> · {device.width} × {device.height}</span></p><div className="score-counts"><span><Check size={13} />{counts.pass} пройдено</span><span>! {counts.warning} советов</span><span><X size={12} />{counts.fail} проблем</span></div></div></div>
                <div className="report-meta"><span><Clock3 size={12} />{formatDate(report.checkedAt)}</span><span>{(report.durationMs / 1000).toFixed(1)} сек. · {report.devices.length} экр.</span></div>
                {report.devices.length > 1 && <div className="device-strip">{report.devices.map((item, index) => <button className={index === deviceIndex ? 'selected' : ''} key={item.id} onClick={() => { setDeviceIndex(index); setHighlight(null); setOpenRule(null); }}><DeviceIcon width={item.width} /><span>{item.width}<small>{item.score}/100</small></span></button>)}</div>}
                <div className="report-tabs" role="tablist" aria-label="Разделы отчёта">{[['overview', 'Проверки'], ['compare', 'Экраны'], ['network', 'Загрузка']].map(([id, title]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{title}{id === 'overview' && <span>{checks.length}</span>}</button>)}</div>
                {tab === 'overview' && <><div className="filter-row"><span>ЧТО МЫ ПРОВЕРИЛИ</span><select aria-label="Фильтр проверок" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Все проверки</option><option value="issues">Только замечания</option><option value="fail">Проблемы</option><option value="pass">Пройдено</option></select></div><div className="checks-list">{relevantChecks.length ? relevantChecks.map(check => <article className={`check-card ${openRule === check.id ? 'open' : ''}`} key={check.id}><button className="check-heading" onClick={() => { setOpenRule(openRule === check.id ? null : check.id); setHighlight(null); }} aria-expanded={openRule === check.id}><StatusIcon status={check.status} /><span><strong>{check.title}</strong><small>{check.description}</small></span><ChevronDown size={15} /></button>{openRule === check.id && <div className="check-details"><div className="rule-label"><span className={`status-tag ${check.status}`}>{labels[check.status]}</span><span>{check.category === 'core' ? 'Основная проверка' : 'Рекомендация лаборатории'}</span></div><p>{check.recommendation || 'Изменения не требуются.'}</p>{check.details?.length > 0 && <div className="elements-list"><span>ЭЛЕМЕНТЫ НА СТРАНИЦЕ · {check.details.length}</span>{check.details.map((item, i) => <button key={`${item.selector}-${i}`} className={highlight === item ? 'selected' : ''} onClick={() => revealElement(item)} title="Подсветить на снимке"><Code2 size={14} /><span><code>{item.selector}</code><small>{item.reason || item.text}</small></span><ScanLine size={14} /></button>)}</div>}</div>}</article>) : <div className="filter-empty"><CheckCheck size={24} /><p>В этой категории замечаний нет.</p></div>}</div></>}
                {tab === 'compare' && <div className="compare-panel">{report.devices.length === 1 && <div className="notice"><Info size={16} /><span>Проверен один экран. Выберите «Все экраны» выше и запустите проверку для сравнения размеров.</span></div>}<div className="comparison-grid">{report.devices.map((item, index) => <button key={item.id} className="comparison-card" onClick={() => { setDeviceIndex(index); setHighlight(null); setTab('overview'); }}><div><DeviceIcon width={item.width} /><strong>{item.width} × {item.height}</strong><span>{item.score}/100</span></div><img src={item.screenshot.data} alt={`Страница на экране ${item.width} пикселей`} /></button>)}</div></div>}
                {tab === 'network' && <div className="network-panel panel"><h3>Загрузка страницы</h3><div className="network-stats"><div><strong>{device.metrics?.requestCount ?? report.resources.total}</strong><span>запросов</span></div><div><strong>{((device.metrics?.loadMs || 0) / 1000).toFixed(1)}<small> с</small></strong><span>загрузка DOM</span></div><div><strong>{report.resources.failed.length}</strong><span>ошибок ресурсов</span></div></div><div className="network-url"><span>Итоговый адрес</span><code>{report.finalUrl}</code></div><p className="muted">Это диагностические замеры данной сессии, не Core Web Vitals. Ошибки ресурсов ниже собраны по всем проверенным экранам.</p>{report.resources.failed.map((item, i) => <div className="resource-error" key={i}><code>{item.url}</code><small>{item.reason}</small></div>)}<h4>Ошибки JavaScript · {report.resources.consoleErrors.length}</h4>{report.resources.consoleErrors.length ? report.resources.consoleErrors.map((item, i) => <pre key={i}>{typeof item === 'string' ? item : JSON.stringify(item)}</pre>) : <p className="muted">Во время проверки ошибок не зафиксировано.</p>}</div>}
                <div className="report-footnote"><Info size={14} /><span>Независимая оценка, не заключение Яндекса. <button onClick={() => setView('method')}>О методике</button></span></div>
              </>}
            </section>
            <section className="preview-column"><div className="section-heading"><h2>Предпросмотр <span className="preview-badge">CHROMIUM</span></h2><div className="preview-heading-actions"><button className="icon-button" disabled={!device} onClick={screenshotDownload} title="Скачать снимок PNG" aria-label="Скачать снимок PNG"><ArrowDownToLine size={16} /></button><button className="icon-button" disabled={!device} onClick={() => setExpanded(true)} title="Открыть большой снимок" aria-label="Открыть большой снимок"><Expand size={16} /></button></div></div><div className="preview-panel panel"><div className="preview-toolbar"><span><DeviceIcon width={device?.width || Number(width)} size={15} />{device ? `${device.width} × ${device.height}` : `${width} × ${height}`}<small>px</small></span><div><button className={`icon-button ${showHighlights ? 'is-active' : ''}`} onClick={() => setShowHighlights(!showHighlights)} disabled={!device} title="Подсветка выбранной проверки" aria-label="Подсветка выбранной проверки" aria-pressed={showHighlights}><ScanLine size={15} /></button><select aria-label="Масштаб предпросмотра" value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">По ширине</option><option value="0.75">75%</option><option value="1">100%</option></select></div></div><div className="preview-stage"><div className={`device-frame ${device && device.width >= 600 ? 'wide-device' : ''}`} style={device ? (zoom !== 'fit' ? { width: device.width * Number(zoom) + 16, minWidth: device.width * Number(zoom) + 16 } : { width: `calc(${device.width / device.height} * var(--preview-height, 380px) + 16px)` }) : {}}><div className="device-top"><span>9:41</span><div className="device-notch" /><div className="phone-signals"><i /><i /><i /><span /></div></div><div className="device-screen" ref={previewRef} style={device ? { height: 'auto', aspectRatio: `${device.width} / ${device.height}` } : {}}>{device ? <div className="screenshot-wrapper" style={{ width: `${device.screenshot.width / device.width * 100}%` }}><img className="screenshot-image" src={device.screenshot.data} alt={`Снимок ${domain(report)}, экран ${device.width} × ${device.height}`} />{showHighlights && overlayItems.filter(item => item.width > 0 && item.height > 0).map((item, i) => <div key={i} className="element-overlay" title={item.selector} style={{ left: `${item.x / device.screenshot.width * 100}%`, top: `${item.y / device.screenshot.height * 100}%`, width: `${item.width / device.screenshot.width * 100}%`, height: `${item.height / device.screenshot.height * 100}%` }}><span>{i + 1}</span></div>)}</div> : <div className="phone-empty"><div className="wire-header"><span /><span /></div><div className="wire-hero"><div /><div /><div /><span /></div><div className="wire-picture"><div /><div /><span /></div><div className="wire-lines"><span /><span /></div><div className="phone-empty-message"><span><ScanLine size={27} strokeWidth={1.3} /></span><strong>Здесь появится ваш сайт</strong><p>Настоящий снимок страницы<br />в выбранном разрешении</p></div><div className="wire-cards"><span /><span /></div></div>}</div><div className="device-bottom"><span /></div></div></div><div className="preview-footer"><span className="tiny-dot" /><span>{device ? 'Снимок страницы · прокручивайте внутри экрана' : 'Предпросмотр появится после проверки'}</span><MousePointer2 size={13} /></div></div><div className="preview-note"><Info size={14} /><p>Эмуляция размера экрана, не реальное устройство.{device ? ' Ссылки на снимке не интерактивны.' : ' Никаких расширений — только адрес сайта.'}</p></div>{report?.notes?.length > 0 && <details className="session-notes"><summary>Условия этой проверки <ChevronDown size={14} /></summary>{report.notes.map((note, i) => <p key={i}>{note}</p>)}</details>}</section>
          </div>
          <footer className="page-footer"><span>ADAPTIVE LAB <span className="footer-slash">/</span> МЕНЬШЕ ДОГАДОК. БОЛЬШЕ ТОЧНОСТИ.</span><button onClick={() => setView('method')}>Создано для хорошего веба <ArrowUpRight size={12} /></button></footer>
        </>}
        {view === 'history' && <><section className="page-heading"><div><div className="eyebrow"><span /> ВАШИ ИССЛЕДОВАНИЯ</div><h1>Каждая проверка — под рукой<span>.</span></h1><p>{isPages ? 'До 20 опубликованных отчётов. Это общедоступная история, а не личное хранилище.' : 'Последние 20 отчётов хранятся локально, включая снимки экранов.'}</p></div><button className="primary-button" onClick={newAudit}><Plus size={17} />Новая проверка</button></section><div className="history-search"><Search size={18} /><input aria-label="Поиск в истории" placeholder="Найти по адресу или названию…" value={search} onChange={event => setSearch(event.target.value)} /></div>{error && <div className="error-banner" role="alert">{error}</div>}<div className="history-list">{history.filter(item => `${item.url} ${item.title} ${domain(item)}`.toLowerCase().includes(search.toLowerCase())).map(item => <article className="history-card panel" key={item.id}><button className="history-main" onClick={() => loadReport(item.id).catch(err => setError(err.message))}><span className="history-score">{item.score}<small>/ 100</small></span><div><h3>{domain(item)}</h3><p>{item.title}</p><small>{formatDate(item.checkedAt)}<i />{item.viewport.width} × {item.viewport.height}<i />{item.deviceCount} экр.</small></div><ArrowUpRight size={21} /></button>{!isPages && <button className="icon-button history-delete" title="Удалить отчёт" aria-label={`Удалить отчёт ${domain(item)}`} onClick={() => removeReport(item)}><Trash2 size={16} /></button>}</article>)}</div>{!history.length && <div className="history-empty panel"><History size={36} strokeWidth={1.2} /><h2>Чистый лист — хорошее начало</h2><p>Запустите первую проверку, и отчёт появится здесь.</p><button className="primary-button" onClick={newAudit}>Проверить сайт <ArrowRight size={16} /></button></div>}{history.length > 0 && !history.some(item => `${item.url} ${item.title} ${domain(item)}`.toLowerCase().includes(search.toLowerCase())) && <div className="history-empty panel"><Search size={30} /><h2>Ничего не найдено</h2><p>Попробуйте другой адрес или название.</p></div>}</>}
        {view === 'method' && <><section className="page-heading"><div><div className="eyebrow"><span /> НИКАКОЙ МАГИИ</div><h1>Проверяем. Объясняем.<br />Не выдаём догадки за факты<span>.</span></h1><p>Независимая лаборатория адаптивности на настоящем браузерном движке.</p></div></section><div className="method-grid"><section className="panel method-card"><span className="method-number">01 / ПРИНЦИП</span><h2>Не картинка в iframe.<br />Реальная страница.</h2><p>Изолированный Chromium загружает страницу, исполняет JavaScript и измеряет элементы после загрузки DOM и короткого ожидания отрисовки. Для каждого размера создаётся отдельный контекст браузера.</p><p>Блокировка встраивания через X-Frame-Options не мешает снимкам. Страницы с авторизацией, CAPTCHA и защитой от ботов могут быть недоступны — защиты не обходятся.</p></section><section className="panel method-card"><span className="method-number">02 / КРИТЕРИИ</span><h2>Базовые требования.<br />Полезные дополнения.</h2><p>Проверяем viewport, горизонтальное переполнение, ширину изображений, устаревшие плагины и HTTP-ответ. Отдельно отмечаем мелкий текст, небольшие цели нажатия, запрет масштабирования и ошибки ресурсов.</p><p>Размер текста менее 12 px — эвристика лаборатории. Для целей нажатия 24 px — нижний ориентир, 44 px — рекомендация. Это не опубликованные числовые пороги Яндекса.</p></section><section className="panel method-card"><span className="method-number">03 / ИНТЕРПРЕТАЦИЯ</span><h2>Оценка — ориентир,<br />а не сертификат.</h2><p>100 баллов означает отсутствие найденных замечаний в проверенных правилах. Итог зависит от важности правил и их статусов; оценка всегда относится к выбранному экрану и состоянию страницы.</p><p>Проверка одной страницы не характеризует весь сайт. Chromium с размерами iPhone — не Safari. Меню, формы, состояния при наведении и реальное устройство нужно проверять вручную. Загрузка DOM — не Core Web Vitals.</p></section><section className="panel method-card"><span className="method-number">04 / ПРИВАТНОСТЬ</span><h2>{isPages ? <>Публичные отчёты.<br />Осознанная публикация.</> : <>Локально.<br />Без лишнего доступа.</>}</h2><p>{isPages ? 'Проверку выполняет временный runner GitHub Actions. Для запуска workflow нужны права на репозиторий; токены не вводятся и не хранятся в интерфейсе. Профили браузера и cookies пользователя не используются.' : 'Сервер слушает только 127.0.0.1. Профили браузера и cookies не используются. Проверяются публичные HTTP(S)-страницы на портах 80 и 443; доступ к частным адресам заблокирован. Исключение — встроенный демонстрационный макет.'}</p><p>{isPages ? 'URL, отчёты и снимки публикуются на Pages только после подтверждения publish в workflow. Не проверяйте конфиденциальные страницы. До 20 отчётов и 200 МиБ истории восстанавливаются из артефактов Actions (до 90 дней); после их истечения новая публикация начнёт историю заново. Нужные отчёты скачивайте. Для удаления публикаций владелец репозитория удаляет артефакты adaptive-lab-reports и запускает workflow без URL.' : 'Проверяемый сайт и его ресурсы получают обычные запросы с вашего компьютера. Никакой сторонний сервис не получает отчёты. Последние 20 отчётов со снимками сохраняются на диске до удаления; они могут содержать данные проверяемой страницы.'}</p></section></div><section className="method-source panel"><div><Info size={20} /><div><h3>Что общего с Яндекс.Вебмастером?</h3><p>Открытые рекомендации по мобильным сайтам. Закрытый алгоритм, оценки робота и его доступность не воспроизводятся.</p></div></div><a href="https://yandex.ru/support/webmaster/ru/recommendations/mobile-site" target="_blank" rel="noreferrer">Справка Яндекса <ExternalLink size={15} /></a></section><button className="subtle-button back-button" onClick={() => setView('audit')}><ArrowLeft size={16} />Вернуться к проверке</button></>}
      </main>
    </div>
    {actionDraft && <ActionsDialog draft={actionDraft} onClose={() => setActionDraft(null)} />}
    {toast && <div className="toast" role="status"><Check size={17} />{toast}<button aria-label="Закрыть уведомление" onClick={() => setToast('')}><X size={14} /></button></div>}
    {expanded && device && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setExpanded(false); }}><section className="screenshot-modal" role="dialog" aria-modal="true" aria-label="Полный снимок страницы"><header><span><DeviceIcon width={device.width} />{domain(report)} <small>{device.width} × {device.height}</small></span><div><button className="subtle-button" onClick={screenshotDownload}><ArrowDownToLine size={16} />PNG</button><button autoFocus className="icon-button" aria-label="Закрыть полный снимок" onClick={() => setExpanded(false)}><X size={21} /></button></div></header><div className="modal-image"><img src={device.screenshot.data} alt="Полный снимок проверенной страницы" style={{ maxWidth: device.screenshot.width }} /></div></section></div>}
  </div>;
}
