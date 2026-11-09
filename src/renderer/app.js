'use strict';

(function () {
/**
 * 渲染层逻辑：表单录入、平台勾选、任务进度、历史与设置。
 * 只通过 window.api 与主进程通信。
 */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const api = window.api;

const STATUS_KEYS = {
  idle: 'status.idle',
  opening: 'status.opening',
  need_login: 'status.need_login',
  uploading: 'status.uploading',
  filling: 'status.filling',
  filled: 'status.filled',
  failed: 'status.failed',
  skipped: 'status.skipped',
};

const T = (key, vars) => (window.T ? window.T(key, vars) : key);
const statusLabel = (status) => T(STATUS_KEYS[status] || 'status.idle');
const platformName = (platform) => {
  if (!platform) return '';
  return window.i18n && window.i18n.get() === 'en' && platform.nameEn ? platform.nameEn : platform.name;
};
const platformNote = (platform) => {
  if (!platform) return '';
  return window.i18n && window.i18n.get() === 'en' && platform.noteEn ? platform.noteEn : platform.note || '';
};

const DRAFT_KEY = 'media-publisher-draft-v1';
const CHROME_NOTICE_KEY = 'media-publisher-chrome-notice-v1';

const state = {
  info: null,
  platforms: [],
  tabs: [],
  checked: new Set(),
  statusMap: {},
  results: {},
  taskId: '',
  currentTask: null,
  running: false,
  video: null,
  cover: null,
  tags: [],
  logs: [],
  settings: {},
  lastDiagnostic: '',
  themePref: 'system',
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 5200 : 3200);
}

/* ---------------- 主题：跟随系统 / 浅色 / 深色 ---------------- */
const THEME_MEDIA = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return THEME_MEDIA.matches ? 'dark' : 'light';
}

function syncThemeSegs() {
  for (const seg of $$('#theme-seg .seg')) {
    seg.dataset.active = seg.dataset.themeValue === (state.themePref || 'system') ? 'true' : 'false';
  }
}

function concurrencyValue() {
  const current = Number(state.settings && state.settings.concurrency);
  return Number.isFinite(current) ? current : 2;
}

function syncConcurrencySegs() {
  const value = String(concurrencyValue());
  for (const seg of $$('[data-concurrency]')) {
    seg.dataset.active = String(Number(seg.dataset.concurrency)) === value ? 'true' : 'false';
  }
}

function syncNetworkSegs() {
  const current = (state.settings && state.settings.networkMode) || 'system';
  for (const seg of $$('#network-seg .seg')) {
    seg.dataset.active = seg.dataset.network === current ? 'true' : 'false';
  }
}

function syncLanguageSegs() {
  const current = (state.settings && state.settings.language) || 'system';
  for (const seg of $$('#language-seg .seg')) {
    seg.dataset.active = seg.dataset.language === current ? 'true' : 'false';
  }
}

function applyLanguage(setting) {
  const resolved = window.i18n ? window.i18n.resolve(setting) : 'zh';
  if (window.i18n) window.i18n.setLang(resolved);
  syncLanguageSegs();
  if (!state.info) return;
  renderTabs();
  renderPlatforms();
  renderVideoInfo();
  renderCoverInfo();
  updateCounters();
  renderProgress();
  updateRunState();
}

function applyTheme(pref) {
  state.themePref = pref === 'light' || pref === 'dark' ? pref : 'system';
  document.documentElement.dataset.theme = resolveTheme(state.themePref);
  try {
    localStorage.setItem('media-publisher-theme', state.themePref);
  } catch (err) {
    /* ignore */
  }
  syncThemeSegs();
}

async function setThemePref(pref) {
  applyTheme(pref);
  try {
    state.settings = await api.saveSettings({ theme: state.themePref });
  } catch (err) {
    toast(err.message, 'error');
  }
}

THEME_MEDIA.addEventListener('change', () => {
  if ((state.themePref || 'system') === 'system') {
    document.documentElement.dataset.theme = resolveTheme('system');
  }
});

function saveDraft() {
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        title: $('#input-title').value,
        description: $('#input-desc').value,
        tags: state.tags,
        checked: Array.from(state.checked),
        video: state.video,
        cover: state.cover,
      })
    );
  } catch (err) {
    /* ignore */
  }
}

function restoreDraft() {
  let draft = null;
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch (err) {
    draft = null;
  }
  if (!draft) {
    state.checked = new Set(state.platforms.map((p) => p.id));
    return;
  }
  $('#input-title').value = draft.title || '';
  $('#input-desc').value = draft.description || '';
  state.tags = Array.isArray(draft.tags) ? draft.tags : [];
  state.video = draft.video || null;
  state.cover = draft.cover || null;
  const ids = state.platforms.map((p) => p.id);
  const chosen = Array.isArray(draft.checked) ? draft.checked.filter((id) => ids.includes(id)) : [];
  state.checked = new Set(chosen.length ? chosen : ids);
}

function renderVideoInfo() {
  const info = $('#video-info');
  const clearBtn = $('#btn-clear-video');
  const wrap = $('#video-preview-wrap');
  const video = $('#video-preview');
  if (state.video) {
    info.textContent = `${state.video.name}（${state.video.sizeMB} MB）`;
    info.classList.remove('muted');
    clearBtn.classList.remove('hidden');
    wrap.classList.remove('hidden');
    const src = `app-media://video?v=${Date.now()}`;
    if (video.getAttribute('src') !== src) video.setAttribute('src', src);
  } else {
    info.textContent = T('form.noVideo');
    info.classList.add('muted');
    clearBtn.classList.add('hidden');
    wrap.classList.add('hidden');
    video.removeAttribute('src');
    try {
      video.load();
    } catch (err) {
      /* ignore */
    }
  }
}

function renderCoverInfo() {
  const info = $('#cover-info');
  const clearBtn = $('#btn-clear-cover');
  const img = $('#cover-preview');
  if (state.cover) {
    info.textContent = state.cover.name;
    info.classList.remove('muted');
    clearBtn.classList.remove('hidden');
    img.classList.remove('hidden');
    img.src = `app-media://cover?v=${Date.now()}`;
  } else {
    info.textContent = T('form.noCover');
    info.classList.add('muted');
    clearBtn.classList.add('hidden');
    img.classList.add('hidden');
    img.removeAttribute('src');
  }
}

async function setVideoFile(picked) {
  if (!picked || !picked.path) return;
  state.video = picked;
  try {
    await api.setMedia('video', picked.path);
  } catch (err) {
    toast(err.message, 'error');
  }
  renderVideoInfo();
  saveDraft();
  await refreshVideoLimits(picked.path);
}

async function setCoverFile(picked) {
  if (!picked || !picked.path) return;
  state.cover = picked;
  try {
    await api.setMedia('cover', picked.path);
  } catch (err) {
    toast(err.message, 'error');
  }
  renderCoverInfo();
  saveDraft();
}

async function resetForm(options = {}) {
  if (state.running) {
    toast(T('action.hintRunning'));
    return;
  }
  const hasContent = !!(
    state.video ||
    state.cover ||
    $('#input-title').value.trim() ||
    $('#input-desc').value.trim() ||
    state.tags.length
  );
  if (hasContent && !options.skipConfirm && !window.confirm(T('toast.confirmClear'))) return;
  state.video = null;
  state.cover = null;
  state.tags = [];
  $('#input-title').value = '';
  $('#input-desc').value = '';
  $('#input-tags').value = '';
  $('#video-limits').textContent = '';
  try {
    await api.setMedia('video', '');
    await api.setMedia('cover', '');
  } catch (err) {
    /* ignore */
  }
  renderVideoInfo();
  renderCoverInfo();
  renderTags();
  updateCounters();
  saveDraft();
  toast(T('toast.cleared'));
  state.results = {};
  state.statusMap = {};
  renderProgress();
  syncDots();
}

/** 第一次打开 Chrome 通道平台时说明原因（为什么会弹出一个独立浏览器窗口） */
async function ensureChromeNotice(platform) {
  if (!platform || platform.engine !== 'chrome') return;
  try {
    if (localStorage.getItem(CHROME_NOTICE_KEY)) return;
  } catch (err) {
    /* ignore */
  }
  await new Promise((resolve) => {
    const dialog = $('#chrome-dialog');
    const ok = $('#btn-chrome-notice-ok');
    const onOk = () => {
      try {
        localStorage.setItem(CHROME_NOTICE_KEY, '1');
      } catch (err) {
        /* ignore */
      }
      dialog.close();
    };
    const onClose = () => {
      ok.removeEventListener('click', onOk);
      dialog.removeEventListener('close', onClose);
      resolve();
    };
    ok.addEventListener('click', onOk);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

async function refreshVideoLimits(videoPath) {
  const box = $('#video-limits');
  if (!box) return;
  box.innerHTML = '';
  if (!videoPath) return;
  try {
    const check = await api.checkVideo(videoPath);
    const selected = new Set(state.checked);
    if (!selected.size) return;
    const bad = check.platforms.filter((p) => selected.has(p.id) && !p.ok);
    if (!bad.length) {
      box.textContent = T('form.sizeOk');
      return;
    }
    for (const item of bad) {
      const span = document.createElement('span');
      span.className = 'warn';
      span.textContent = `${item.name}：${item.errors.join('；')}`;
      box.appendChild(span);
    }
  } catch (err) {
    box.textContent = err.message;
  }
}

function renderTags() {
  const wrap = $('#tag-chips');
  wrap.innerHTML = '';
  for (const tag of state.tags) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const text = document.createElement('span');
    text.textContent = `#${tag}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.title = T('form.remove');
    btn.addEventListener('click', () => {
      state.tags = state.tags.filter((t) => t !== tag);
      renderTags();
      saveDraft();
    });
    chip.appendChild(text);
    chip.appendChild(btn);
    wrap.appendChild(chip);
  }
}

function addTag(raw) {
  const parts = String(raw || '')
    .split(/[\s,，、;；]+/)
    .map((t) => t.trim().replace(/^#+/, ''))
    .filter(Boolean);
  for (const part of parts) {
    if (!state.tags.includes(part) && state.tags.length < 20) state.tags.push(part);
  }
  renderTags();
  saveDraft();
}

function checkedPlatforms() {
  return state.platforms.filter((p) => state.checked.has(p.id));
}

function updateCounters() {
  const title = $('#input-title').value;
  const desc = $('#input-desc').value;
  $('#title-count').textContent = T('form.charUnit', { n: Array.from(title).length });
  $('#desc-count').textContent = T('form.charUnit', { n: Array.from(desc).length });

  const list = checkedPlatforms();
  const hint = $('#title-limit-hint');
  if (!list.length) {
    hint.textContent = '';
    return;
  }
  const strict = list.reduce((acc, p) => (p.limits.title < acc.limits.title ? p : acc), list[0]);
  const over = Array.from(title).length > strict.limits.title;
  hint.className = over ? 'warn' : '';
  hint.textContent = T('form.strict', { name: platformName(strict), limit: strict.limits.title }) + (over ? T('form.overText') : '');
}

function statusOf(platformId) {
  const tab = state.tabs.find((t) => t.id === platformId);
  if (tab && tab.status && tab.status !== 'idle') return tab.status;
  const map = state.statusMap[platformId];
  if (map && map.status) return map.status;
  return (tab && tab.status) || 'idle';
}

function messageOf(platformId) {
  const tab = state.tabs.find((t) => t.id === platformId);
  if (tab && tab.message) return tab.message;
  const map = state.statusMap[platformId];
  return (map && map.message) || '';
}

function renderTabs() {
  const nav = $('#tabs');
  nav.innerHTML = '';
  const activePlatform = state.tabs.find((t) => t.active);
  const formTab = document.createElement('button');
  formTab.className = `tab ${activePlatform ? '' : 'active'}`.trim();
  formTab.innerHTML = `<span class="tab-dot" style="background:var(--accent)"></span><span>${T('tab.form')}</span>`;
  formTab.addEventListener('click', async () => {
    try {
      await api.hideTabs();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  nav.appendChild(formTab);

  for (const tab of state.tabs) {
    const btn = document.createElement('button');
    btn.className = `tab ${tab.active ? 'active' : ''}`.trim();
    btn.title = tab.url || tab.name;
    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    dot.dataset.status = tab.status;
    const label = document.createElement('span');
    label.textContent = platformName(state.platforms.find((p) => p.id === tab.id)) || tab.name;
    btn.appendChild(dot);
    btn.appendChild(label);
    btn.addEventListener('click', async () => {
      try {
        await api.showTab(tab.id);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    nav.appendChild(btn);
  }
}

function renderPlatforms() {
  const wrap = $('#platform-list');
  wrap.innerHTML = '';
  for (const platform of state.platforms) {
    const card = document.createElement('div');
    card.className = 'platform-card';
    card.dataset.id = platform.id;

    const main = document.createElement('label');
    main.className = 'platform-main';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'platform-check';
    checkbox.checked = state.checked.has(platform.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.checked.add(platform.id);
      else state.checked.delete(platform.id);
      card.classList.toggle('checked', checkbox.checked);
      updateCounters();
      renderProgress();
      saveDraft();
    });

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.dataset.status = statusOf(platform.id);

    const name = document.createElement('span');
    name.className = 'platform-name';
    name.textContent = platformName(platform);

    const stateLabel = document.createElement('span');
    stateLabel.className = 'platform-state';
    stateLabel.dataset.status = statusOf(platform.id);
    stateLabel.textContent = statusLabel(statusOf(platform.id));

    main.appendChild(checkbox);
    main.appendChild(dot);
    main.appendChild(name);
    if (platform.engine === 'chrome') {
      const badge = document.createElement('span');
      badge.className = 'badge-chrome';
      badge.textContent = T('platform.chromeBadge');
      badge.title = T('platform.chromeBadgeTitle');
      main.appendChild(badge);
    }
    main.appendChild(stateLabel);

    const note = document.createElement('div');
    note.className = 'platform-note';
    note.textContent = platformNote(platform);
    note.title = platformNote(platform);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const makeAction = (text, title, handler) => {
      const b = document.createElement('button');
      b.className = 'link-btn';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await handler();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      return b;
    };

    actions.appendChild(
      makeAction(T('platform.open'), T('platform.openTitle'), async () => {
        await ensureChromeNotice(platform);
        await api.showTab(platform.id);
      })
    );
    actions.appendChild(
      makeAction(T('platform.check'), T('platform.checkTitle'), async () => {
        await ensureChromeNotice(platform);
        toast(T('toast.loginChecking', { name: platformName(platform) }));
        const res = await api.checkLogin(platform.id);
        if (res.loggedIn === true) toast(T('toast.loginOk', { name: platformName(platform) }), 'success');
        else if (res.loggedIn === false) toast(T('toast.loginNeed', { name: platformName(platform) }), 'error');
        else toast(T('toast.loginUnknown', { name: platformName(platform), msg: res.message || T('toast.loginUnknownMsg') }));
        syncDots();
      })
    );
    actions.appendChild(
      makeAction(T('platform.scan'), T('platform.scanTitle'), async () => {
        await ensureChromeNotice(platform);
        const res = await api.scanPage(platform.id);
        state.lastDiagnostic = res.file;
        toast(T('toast.scanDone', { fields: res.fields, buttons: res.buttons }));
        addLog('', T('log.diagPath', { file: res.file }));
      })
    );
    actions.appendChild(
      makeAction(T('platform.refresh'), T('platform.refreshTitle'), async () => {
        await api.reloadTab(platform.id);
        toast(T('toast.refreshDone', { name: platformName(platform) }));
      })
    );
    actions.appendChild(
      makeAction(T('platform.retry'), T('platform.retryTitle'), async () => {
        if (!state.currentTask) {
          toast(T('toast.retryNoTask'), 'error');
          return;
        }
        await ensureChromeNotice(platform);
        const res = await api.retryPlatform(state.currentTask, platform.id);
        if (res && res.queued) toast(T('toast.retryQueued', { name: platformName(platform) }));
        else toast(T('toast.retryRunning', { name: platformName(platform) }));
      })
    );

    card.appendChild(main);
    if (note.textContent) card.appendChild(note);
    card.appendChild(actions);
    card.classList.toggle('checked', checkbox.checked);
    wrap.appendChild(card);
  }
}

function renderProgress() {
  const wrap = $('#progress-list');
  if (!wrap) return;
  const list = checkedPlatforms();
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.innerHTML = `<div class="empty">${T('progress.noneSelected')}</div>`;
    return;
  }
  for (const platform of list) {
    const status = statusOf(platform.id);
    const message = messageOf(platform.id);
    const result = state.results[platform.id];
    const row = document.createElement('div');
    row.className = 'progress-row';
    row.dataset.id = platform.id;

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.dataset.status = status;

    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = platformName(platform);

    const msg = document.createElement('span');
    msg.className = 'p-msg';
    msg.textContent = message || statusLabel(status) || T('progress.waiting');
    msg.title = msg.textContent;

    const actions = document.createElement('div');
    actions.className = 'p-actions';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'link-btn';
    viewBtn.textContent = T('progress.view');
    viewBtn.addEventListener('click', async () => {
      try {
        await api.showTab(platform.id);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    actions.appendChild(viewBtn);

    if (result && (result.status === 'failed' || result.status === 'skipped')) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'link-btn';
      retryBtn.textContent = T('progress.retry');
      retryBtn.addEventListener('click', async () => {
        if (!state.currentTask) return;
        try {
          await api.retryPlatform(state.currentTask, platform.id);
          state.running = true;
          updateRunState();
          toast(T('toast.retryRunning', { name: platformName(platform) }));
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      actions.appendChild(retryBtn);
    }

    if (result && result.diagnosticFile) {
      const diagBtn = document.createElement('button');
      diagBtn.className = 'link-btn';
      diagBtn.textContent = T('progress.diagnose');
      diagBtn.title = result.diagnosticFile;
      diagBtn.addEventListener('click', async () => {
        try {
          await api.openPath(result.diagnosticFile);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      actions.appendChild(diagBtn);
    }

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(msg);
    row.appendChild(actions);
    wrap.appendChild(row);
  }
}

function syncDots() {
  for (const card of $$('.platform-card')) {
    const id = card.dataset.id;
    const status = statusOf(id);
    const dot = card.querySelector('.dot');
    if (dot) dot.dataset.status = status;
    const label = card.querySelector('.platform-state');
    if (label) {
      label.dataset.status = status;
      label.textContent = statusLabel(status);
    }
    card.classList.toggle('checked', state.checked.has(id));
  }
  const rows = $$('.progress-row');
  for (const row of rows) {
    const dot = row.querySelector('.dot');
    if (dot) dot.dataset.status = statusOf(row.dataset.id);
  }
}

function addLog(platformId, message) {
  if (!message) return;
  state.logs.push({ platformId, message });
  if (state.logs.length > 300) state.logs.shift();
  renderLogs();
}

function renderLogs() {
  const box = $('#log-box');
  box.innerHTML = '';
  const start = Math.max(0, state.logs.length - 200);
  for (let i = start; i < state.logs.length; i += 1) {
    const entry = state.logs[i];
    const line = document.createElement('div');
    line.className = 'log-line';
    if (entry.platformId) {
      const pid = document.createElement('span');
      pid.className = 'log-pid';
      const name = (state.platforms.find((p) => p.id === entry.platformId) || {}).name || entry.platformId;
      pid.textContent = `[${name}] `;
      line.appendChild(pid);
    }
    line.appendChild(document.createTextNode(entry.message));
    box.appendChild(line);
  }
  box.scrollTop = box.scrollHeight;
}

function clearLogs() {
  state.logs = [];
  renderLogs();
  $('#log-box').innerHTML = '';
}

function updateRunState() {
  const startBtn = $('#btn-start');
  const cancelBtn = $('#btn-cancel');
  startBtn.disabled = state.running;
  startBtn.textContent = state.running ? T('action.running') : T('action.start');
  cancelBtn.classList.toggle('hidden', !state.running);
  $('#run-hint').textContent = state.running ? T('action.hintRunning') : '';
}

function handleTaskEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'log') {
    addLog(ev.platformId, ev.message);
    return;
  }
  if (ev.type === 'status') {
    if (ev.platformId) {
      state.statusMap[ev.platformId] = { status: ev.status, message: ev.message };
      syncDots();
      const row = $(`.progress-row[data-id="${ev.platformId}"] .p-msg`);
      if (row) {
        row.textContent = ev.message || statusLabel(ev.status);
        row.title = row.textContent;
      }
    }
    return;
  }
  if (ev.type === 'platform-result') {
    if (ev.platformId) {
      state.results[ev.platformId] = ev.result || {};
      renderProgress();
      syncDots();
      if (ev.result && ev.result.status === 'failed') {
        addLog(ev.platformId, T('log.platformFailed', { msg: ev.result.message || '' }));
      }
    }
    return;
  }
  if (ev.type === 'task') {
    if (ev.state === 'running') {
      state.running = true;
      state.results = {};
      state.statusMap = {};
      state.taskId = ev.taskId || '';
      const logPanel = $('#log-panel');
      if (logPanel) logPanel.open = true;
      updateRunState();
      renderProgress();
      return;
    }
    if (ev.state === 'platform-start') {
      addLog(ev.platformId, T('log.platformStarted'));
      return;
    }
    if (ev.state === 'done' || ev.state === 'cancelled') {
      state.running = false;
      state.results = ev.results || {};
      updateRunState();
      renderProgress();
      syncDots();
      const results = Object.values(state.results);
      const filled = results.filter((r) => r.status === 'filled').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      if (ev.state === 'cancelled') toast(T('toast.cancelled'), 'error');
      else if (failed) toast(T('toast.partial', { filled, failed }), 'error');
      else toast(T('toast.allDone', { filled }), 'success');
      return;
    }
    return;
  }
  if (ev.type === 'fatal') {
    state.running = false;
    updateRunState();
    toast(ev.message || T('toast.cancelled'), 'error');
  }
}

async function startTask() {
  if (state.running) return;
  if (!state.video) return toast(T('toast.startNoVideo'), 'error');
  const title = $('#input-title').value.trim();
  if (!title) return toast(T('toast.startNoTitle'), 'error');
  const platforms = Array.from(state.checked);
  if (!platforms.length) return toast(T('toast.startNoPlatform'), 'error');

  // 勾选了 YouTube / TikTok 时，开始前先给出"为什么单独开 Chrome 窗口"的说明
  for (const id of platforms) {
    const platform = state.platforms.find((p) => p.id === id);
    if (platform) await ensureChromeNotice(platform);
  }

  const task = {
    videoPath: state.video.path,
    coverPath: state.cover ? state.cover.path : '',
    title,
    description: $('#input-desc').value.trim(),
    tags: state.tags.slice(),
    platforms,
  };
  state.currentTask = task;
  state.results = {};
  state.statusMap = {};
  clearLogs();
  try {
    const res = await api.startTask(task);
    state.taskId = res.taskId;
    state.running = true;
    updateRunState();
    renderProgress();
    addLog('', `任务已创建：${res.taskId}`);
    const logPanel = $('#log-panel');
    if (logPanel) logPanel.open = true;
    toast('任务已开始，正在依次打开各平台创作中心…');
  } catch (err) {
    state.running = false;
    updateRunState();
    toast(err.message, 'error');
  }
}

async function renderHistory() {
  const list = await api.history();
  const wrap = $('#history-list');
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.innerHTML = `<div class="empty">${T('history.empty')}</div>`;
    return;
  }
  for (const item of list) {
    const box = document.createElement('div');
    box.className = 'history-item';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = item.title || T('history.untitled');
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const locale = window.i18n && window.i18n.get() === 'en' ? 'en-US' : 'zh-CN';
    const time = item.time ? new Date(item.time).toLocaleString(locale) : '';
    meta.textContent = `${time} · ${(item.videoPath || '').split(/[\\/]/).pop() || T('history.unknownFile')}`;
    const platforms = document.createElement('div');
    platforms.className = 'history-platforms';
    for (const id of item.platforms || []) {
      const name = platformName(state.platforms.find((p) => p.id === id)) || id;
      const result = (item.results || {})[id] || {};
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset.status = result.status || 'idle';
      badge.textContent = T('history.badge', { name, status: statusLabel(result.status) });
      badge.title = result.message || '';
      platforms.appendChild(badge);
    }
    box.appendChild(title);
    box.appendChild(meta);
    box.appendChild(platforms);
    wrap.appendChild(box);
  }
}

function bindEvents() {
  $('#btn-pick-video').addEventListener('click', async () => {
    try {
      const picked = await api.pickVideo();
      if (!picked) return;
      await setVideoFile(picked);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-clear-video').addEventListener('click', async () => {
    state.video = null;
    $('#video-limits').textContent = '';
    await api.setMedia('video', '').catch(() => null);
    renderVideoInfo();
    saveDraft();
  });

  $('#btn-pick-cover').addEventListener('click', async () => {
    try {
      const picked = await api.pickCover();
      if (!picked) return;
      await setCoverFile(picked);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-clear-cover').addEventListener('click', async () => {
    state.cover = null;
    await api.setMedia('cover', '').catch(() => null);
    renderCoverInfo();
    saveDraft();
  });

  $('#btn-reset-form').addEventListener('click', () => resetForm());

  // 拖拽选择视频
  const drop = $('#video-drop');
  const setDragging = (on) => drop.classList.toggle('dragover', on);
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      setDragging(true);
    });
  }
  drop.addEventListener('dragleave', (event) => {
    event.preventDefault();
    setDragging(false);
  });
  drop.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    const filePath = api.pathForFile(file);
    if (!filePath) {
      toast(T('toast.videoBadPath'), 'error');
      return;
    }
    try {
      const stat = await api.fileStat(filePath);
      const videoExt = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.flv', '.wmv', '.webm'];
      if (!videoExt.includes(String(stat.ext || '').toLowerCase())) {
        toast(T('toast.videoBadFormat', { ext: stat.ext }), 'error');
        return;
      }
      await setVideoFile({ path: stat.path, name: stat.name, sizeMB: stat.sizeMB });
      toast(T('toast.videoSelected', { name: stat.name }));
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  // 防止把文件拖到窗口其它位置时浏览器直接打开文件
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  const titleInput = $('#input-title');
  const descInput = $('#input-desc');
  titleInput.addEventListener('input', () => {
    updateCounters();
    saveDraft();
  });
  descInput.addEventListener('input', () => {
    updateCounters();
    saveDraft();
  });

  const tagsInput = $('#input-tags');
  tagsInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault();
      addTag(tagsInput.value);
      tagsInput.value = '';
    } else if (event.key === 'Backspace' && !tagsInput.value && state.tags.length) {
      state.tags.pop();
      renderTags();
      saveDraft();
    }
  });
  tagsInput.addEventListener('blur', () => {
    if (tagsInput.value.trim()) {
      addTag(tagsInput.value);
      tagsInput.value = '';
    }
  });

  $('#btn-start').addEventListener('click', startTask);

  $('#btn-cancel').addEventListener('click', async () => {
    try {
      const res = await api.cancelTask();
      toast(res.cancelled ? T('toast.cancelRequested') : T('toast.cancelNone'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-select-all').addEventListener('click', () => {
    for (const platform of state.platforms) state.checked.add(platform.id);
    renderPlatforms();
    renderProgress();
    updateCounters();
    saveDraft();
  });

  $('#btn-select-none').addEventListener('click', () => {
    state.checked.clear();
    renderPlatforms();
    renderProgress();
    updateCounters();
    saveDraft();
  });

  $('#btn-open-logdir').addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await api.openPath(state.info.dirs.logs);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-history').addEventListener('click', async () => {
    try {
      await renderHistory();
      $('#history-dialog').showModal();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-clear-history').addEventListener('click', async () => {
    try {
      await api.clearHistory();
      await renderHistory();
      toast(T('toast.historyCleared'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-settings').addEventListener('click', async () => {
    try {
      state.settings = await api.getSettings();
      $('#opt-truncate').checked = state.settings.autoTruncate !== false;
      $('#opt-open-tabs').checked = state.settings.openTabsWhileRunning !== false;
      $('#opt-restore-draft').checked = state.settings.restoreDraft !== false;
      $('#settings-dir').textContent = state.info.dirs.base;
      $('#settings-version').textContent = T('settings.version', {
        v: state.info.version,
        e: state.info.electron,
        c: state.info.chrome,
      });
      syncThemeSegs();
      syncLanguageSegs();
      syncConcurrencySegs();
      syncNetworkSegs();
      $('#settings-dialog').showModal();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-open-dir').addEventListener('click', async () => {
    try {
      await api.openPath(state.info.dirs.base);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#opt-truncate').addEventListener('change', async () => {
    try {
      state.settings = await api.saveSettings({ autoTruncate: $('#opt-truncate').checked });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#opt-open-tabs').addEventListener('change', async () => {
    try {
      state.settings = await api.saveSettings({ openTabsWhileRunning: $('#opt-open-tabs').checked });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#opt-restore-draft').addEventListener('change', async () => {
    try {
      state.settings = await api.saveSettings({ restoreDraft: $('#opt-restore-draft').checked });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (!$('#opt-restore-draft').checked) {
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch (err) {
        /* ignore */
      }
    }
  });

  for (const seg of $$('#theme-seg .seg')) {
    seg.addEventListener('click', () => setThemePref(seg.dataset.themeValue));
  }

  for (const seg of $$('#language-seg .seg')) {
    seg.addEventListener('click', async () => {
      try {
        state.settings = await api.saveSettings({ language: seg.dataset.language });
        applyLanguage(state.settings.language);
        toast(T('toast.languageSaved'));
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  for (const seg of $$('[data-concurrency]')) {
    seg.addEventListener('click', async () => {
      const value = Number(seg.dataset.concurrency);
      try {
        state.settings = await api.saveSettings({ concurrency: value });
        syncConcurrencySegs();
        if (value === 0) toast(T('toast.concurrencyAll'));
        else if (value === 1) toast(T('toast.concurrencySerial'));
        else toast(T('toast.concurrencyN', { n: value }));
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  for (const seg of $$('#network-seg .seg')) {
    seg.addEventListener('click', async () => {
      try {
        state.settings = await api.saveSettings({ networkMode: seg.dataset.network });
        syncNetworkSegs();
        toast(T('toast.networkSaved'));
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  for (const btn of $$('[data-close]')) {
    btn.addEventListener('click', () => {
      const dialog = document.getElementById(btn.dataset.close);
      if (dialog) dialog.close();
    });
  }

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      startTask();
    }
  });
}

async function init() {
  if (!api) {
    document.body.innerHTML = `<div style="padding:40px;color:#ff9a9a">${T('toast.preloadError')}</div>`;
    return;
  }
  document.documentElement.style.setProperty('--tabbar-h', `${api.tabBarHeight || 52}px`);
  bindEvents();
  try {
    state.info = await api.appInfo();
    state.platforms = state.info.platforms || [];
    state.settings = await api.getSettings();
    applyLanguage(state.settings.language);
    applyTheme(state.settings.theme || 'system');
    syncConcurrencySegs();
    if (state.settings.restoreDraft === false) {
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch (err) {
        /* ignore */
      }
    }

    restoreDraft();
    if (state.video && state.video.path) {
      try {
        await api.fileStat(state.video.path);
        await api.setMedia('video', state.video.path);
      } catch (err) {
        state.video = null;
        addLog('', T('toast.videoMissing'));
      }
    }
    if (state.cover && state.cover.path) {
      try {
        await api.fileStat(state.cover.path);
        await api.setMedia('cover', state.cover.path);
      } catch (err) {
        state.cover = null;
      }
    }
    renderVideoInfo();
    renderCoverInfo();
    renderTags();
    renderPlatforms();
    updateCounters();
    renderProgress();
    updateRunState();

    state.tabs = await api.tabsList();
    renderTabs();
    syncDots();

    api.onTabs((list) => {
      state.tabs = Array.isArray(list) ? list : [];
      renderTabs();
      syncDots();
    });
    api.onTaskEvent(handleTaskEvent);

    addLog('', T('log.ready', { n: state.platforms.length }));
  } catch (err) {
    window.__initError = err && err.message ? err.message : String(err);
    toast(T('toast.initFailed', { msg: err.message }), 'error');
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
})();
