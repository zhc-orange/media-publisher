'use strict';

/**
 * 主进程入口：窗口、标签页、任务执行器、IPC。
 */

const { app, BrowserWindow, Menu, dialog, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 数据目录固定在 %APPDATA%，打包前后一致，登录态可长期保留
app.setName('自媒体发布助手');
try {
  app.setPath('userData', path.join(app.getPath('appData'), '自媒体发布助手'));
} catch (err) {
  /* 极端情况下保留默认目录 */
}

app.commandLine.appendSwitch('lang', 'zh-CN');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// 网络模式必须在 app ready 之前决定：direct = 忽略系统代理（代理软件异常时用）
function readEarlySettings() {
  try {
    const file = path.join(app.getPath('userData'), 'settings.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return {};
  }
}
try {
  const early = readEarlySettings();
  if (early.networkMode === 'direct') app.commandLine.appendSwitch('no-proxy-server');
} catch (err) {
  /* ignore */
}

const { getDirs } = require('./paths');
const { loadSettings } = require('./settings');
const TabManager = require('./tab-manager');
const Runner = require('./runner');
const registerIpc = require('./ipc');
const { TAB_BAR_HEIGHT } = require('./constants');
const { registerMediaProtocol, PRIVILEGES } = require('./media-protocol');
const ChromeChannel = require('./chrome-channel');

// 本地媒体预览协议：只读取 media-store 里登记过的视频/封面
protocol.registerSchemesAsPrivileged(PRIVILEGES);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let tabs = null;
let runner = null;
let chrome = null;
let dirs = null;
let settings = null;

function isCaptureUi() {
  // 仅限开发期 UI 自检使用；打包后的程序不具备任何截图能力
  return !app.isPackaged && process.argv.includes('--capture-ui');
}

async function captureUiAndQuit() {
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const viewArg = process.argv.find((arg) => arg.startsWith('--capture-view='));
    const view = viewArg ? viewArg.slice('--capture-view='.length) : '';
    let uiChecks = null;
    if (process.argv.includes('--ui-check')) {
      uiChecks = await mainWindow.webContents.executeJavaScript(
        `(async function () {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const checked = () => document.querySelectorAll('.platform-check:checked').length;
          const out = {};
          out.initial = checked();
          q('#btn-select-none').click(); await sleep(150);
          out.afterNone = checked();
          out.emptyText = (q('#progress-list').textContent || '').trim();
          q('#btn-select-all').click(); await sleep(150);
          out.afterAll = checked();
          q('#theme-seg .seg[data-theme-value="light"]').click(); await sleep(350);
          out.lightTheme = document.documentElement.dataset.theme;
          q('#theme-seg .seg[data-theme-value="dark"]').click(); await sleep(350);
          out.darkTheme = document.documentElement.dataset.theme;
          q('#btn-history').click(); await sleep(500);
          out.historyOpen = !!q('#history-dialog[open]');
          const closeBtn = q('#history-dialog .dialog-close');
          if (closeBtn) closeBtn.click();
          await sleep(150);
          out.historyClosed = !q('#history-dialog[open]');
          return out;
        })()`,
        true
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const dialogId = view === 'settings' ? 'settings-dialog' : view === 'history' ? 'history-dialog' : '';
    if (dialogId) {
      for (let i = 0; i < 4; i += 1) {
        await mainWindow.webContents.executeJavaScript(
          `(function(){var d=document.getElementById('${dialogId}');if(d&&!d.open){var b=document.getElementById('${dialogId === 'settings-dialog' ? 'btn-settings' : 'btn-history'}');if(b)b.click();}return !!(d&&d.open);})()`,
          true
        );
        await new Promise((resolve) => setTimeout(resolve, 600));
        const opened = await mainWindow.webContents.executeJavaScript(
          `!!(document.getElementById('${dialogId}') || {}).open`,
          true
        );
        if (opened) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const image = await mainWindow.webContents.capturePage();
    const outDir = path.join(app.getPath('userData'), 'selftest');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, view ? `ui-${view}.png` : 'ui.png');
    fs.writeFileSync(file, image.toPNG());
    const diag = await mainWindow.webContents.executeJavaScript(
      `({
        cards: document.querySelectorAll('.platform-card').length,
        tabs: document.querySelectorAll('.tab').length,
        progressRows: document.querySelectorAll('.progress-row').length,
        openDialogs: Array.from(document.querySelectorAll('dialog[open]')).map(function (d) { return d.id; }),
        videoPreview: (function () {
          var v = document.getElementById('video-preview');
          return v ? { src: v.getAttribute('src'), ready: v.readyState, error: v.error ? v.error.code : 0, currentSrc: v.currentSrc } : null;
        })(),
        concurrencySegs: document.querySelectorAll('[data-concurrency]').length,
        toast: (document.getElementById('toast') || {}).textContent || '',
        initError: window.__initError || '',
        bodyText: (document.body.innerText || '').slice(0, 600)
      })`,
      true
    );
    fs.writeFileSync(path.join(outDir, 'ui-diag.json'), JSON.stringify({ ...diag, uiChecks }, null, 2), 'utf8');
    console.log(`UI_SCREENSHOT=${file}`);
    console.log(`UI_DIAG=${JSON.stringify(diag)}`);
    if (uiChecks) console.log(`UI_CHECKS=${JSON.stringify(uiChecks)}`);
  } catch (err) {
    console.error('capture ui failed:', err);
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: '自媒体发布助手',
    backgroundColor: '#101319',
    autoHideMenuBar: true,
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error(`[renderer] ${message}`);
    else console.log(`[renderer] ${message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] 崩溃', details);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error(`[renderer] 加载失败 ${code} ${desc}`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isCaptureUi()) captureUiAndQuit();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('close', (event) => {
    if (runner && runner.isRunning()) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['取消', '停止任务并退出'],
        defaultId: 0,
        cancelId: 0,
        title: '任务进行中',
        message: '还有平台正在填写，确定要中止并退出吗？',
      });
      if (choice === 0) {
        event.preventDefault();
        return;
      }
      runner.cancel();
    }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerMediaProtocol();
  dirs = getDirs();
  settings = loadSettings(dirs);

  // 运行时再设置一次代理模式，确保所有 session（含平台分区）行为一致
  try {
    const { session } = require('electron');
    const proxyMode = settings.networkMode === 'direct' ? 'direct' : 'system';
    for (const ses of [session.defaultSession, session.fromPartition('persist:platforms')]) {
      ses.setProxy({ mode: proxyMode }).catch(() => {});
    }
  } catch (err) {
    /* ignore */
  }

  createWindow();

  // 清理历史诊断/日志，避免长期使用无限增长
  try {
    const diagnostics = require('./diagnostics');
    diagnostics.prune(dirs.diagnostics, 50, '.json');
    diagnostics.prune(dirs.logs, 100, '.jsonl');
  } catch (err) {
    /* ignore */
  }

  chrome = new ChromeChannel({
    userDataDir: dirs.base,
    networkMode: settings.networkMode,
    log: (message) => console.log('[chrome]', message),
  });

  tabs = new TabManager(mainWindow, {
    onUpdate: (list) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tabs:update', list);
    },
    chrome,
  });
  runner = new Runner({
    tabs,
    dirs,
    getSettings: () => settings,
  });
  runner.on('event', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:event', payload);
  });

  registerIpc({
    app,
    dirs,
    tabs,
    runner,
    getSettings: () => settings,
    setSettings: (next) => {
      settings = next;
    },
    getWindow: () => mainWindow,
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (tabs) tabs.closeAll();
  app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  if (runner && runner.isRunning()) runner.cancel();
  if (chrome) {
    // 等 Chrome 真正退出再结束程序，避免留下独立浏览器窗口
    event.preventDefault();
    quitting = true;
    Promise.resolve(chrome.shutdown())
      .catch(() => {})
      .finally(() => app.exit(0));
  }
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  try {
    if (chrome) chrome.shutdown().catch(() => {});
  } catch (shutdownErr) {
    /* ignore */
  }
  // 主进程已处于不一致状态，继续运行只会让任务/窗口行为不可预期
  app.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
