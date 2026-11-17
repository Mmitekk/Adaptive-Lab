import React, { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Info, X } from 'lucide-react';
import { workflowUrl, repository } from './api.js';

export default function ActionsDialog({ draft, onClose }) {
  const dialog = useRef(null);
  const [copyState, setCopyState] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  async function copyUrl() {
    try { await navigator.clipboard.writeText(draft.url); setCopyState('URL скопирован'); }
    catch { setCopyState('Выделите и скопируйте URL вручную.'); }
  }
  return <dialog ref={dialog} className="actions-dialog" onCancel={onClose} aria-labelledby="actions-title">
    <header><span>GITHUB ACTIONS / {repository}</span><button className="icon-button" aria-label="Закрыть запуск Actions" onClick={onClose}><X size={24} /></button></header>
    <h2 id="actions-title">Запустить проверку в GitHub</h2>
    <p>Браузерная проверка выполняется в Actions, не на Pages. Нажатие кнопки ниже только откроет workflow — проверка ещё не запущена.</p>
    <ol>
      <li>Войдите в GitHub с правами на этот репозиторий.</li>
      <li>Откройте workflow, нажмите <strong>Run workflow</strong> и выберите ветку <strong>main</strong>.</li>
      <li>Перенесите параметры ниже, включите <strong>publish</strong> и подтвердите <strong>Run workflow</strong>.</li>
      <li>Дождитесь зелёного результата шагов <strong>build</strong> и <strong>deploy</strong>, затем вернитесь и нажмите «Обновить отчёты».</li>
    </ol>
    <div className="actions-parameters">
      <label htmlFor="actions-url">url</label><div className="actions-url"><input id="actions-url" readOnly value={draft.url} placeholder="Укажите полный адрес в поле URL workflow" onFocus={event => event.target.select()} /><button className="icon-button" disabled={!draft.url} onClick={copyUrl} aria-label="Скопировать URL"><Copy size={20} /></button></div>
      <dl><div><dt>width</dt><dd>{draft.width}</dd></div><div><dt>height</dt><dd>{draft.height}</dd></div><div><dt>mode</dt><dd>{draft.mode}</dd></div><div><dt>mobile</dt><dd>{String(draft.mobile)}</dd></div></dl>
    </div>
    {copyState && <p role="status">{copyState}</p>}
    <div className="actions-warning"><Info size={20} /><p>Отчёт, URL и снимки будут опубликованы. Не указывайте конфиденциальные страницы или ссылки с секретами. Возможна очередь; действуют лимиты вашего тарифа GitHub Actions.</p></div>
    <footer><button className="subtle-button" onClick={onClose}>Вернуться</button><a className="primary-button" href={workflowUrl} target="_blank" rel="noreferrer">Открыть GitHub Actions <ExternalLink size={20} /></a></footer>
  </dialog>;
}
