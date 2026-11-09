'use strict';

/**
 * 标签页管理自测：验证 WebContentsView 的创建、显示、层级尺寸、状态推送与关闭。
 * 运行：electron scripts/selftest-tabs.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { createMockServer } = require('../src/main/mock-server');
const { validatePlatform } = require('../src/main/config');
const TabManager = require('../src/main/tab-manager');
const { TAB_BAR_HEIGHT } = require('../src/main/constants');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

async function main() {
  const outDir = path.join(app.getPath('userData'), 'selftest');
  fs.mkdirSync(outDir, { recursive: true });
  const result = { ok: false, checks: {} };
  const server = await createMockServer();
  const platform = validatePlatform(
    {
      id: 'mocktabs',
      name: '模拟标签页',
      order: 1,
      entry: server.url,
      note: '标签页自测',
      limits: { title: 30, description: 1000, tags: 5, maxFileMB: 100 },
      loginCheck: { selectors: ['.avatar'] },
      video: { input: ['input[type=file]'], accept: 'video' },
      title: { selectors: ['input[placeholder*="标题"]'] },
    },
    'mocktabs.json'
  );

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.showInactive();

  let updates = [];
  const tabs = new TabManager(win, { onUpdate: (list) => updates.push(list) });

  try {
    await win.loadURL('data:text/html,<h1>form</h1>');
    const entry = tabs.ensure(platform);
    tabs.show(platform.id);
    await entry.view.webContents.loadURL(server.url);

    const bounds = entry.view.getBounds();
    const [width, height] = win.getContentSize();
    result.checks.created = tabs.list().length === 1;
    result.checks.boundsX = bounds.x === 0 && bounds.y === TAB_BAR_HEIGHT;
    result.checks.boundsSize = Math.abs(bounds.height - (height - TAB_BAR_HEIGHT)) <= 1 && Math.abs(bounds.width - width) <= 1;
    result.checks.loaded = String(entry.view.webContents.getURL()).indexOf('127.0.0.1') >= 0;
    result.checks.active = tabs.list()[0].active === true;

    tabs.setStatus(platform.id, 'filled', '信息已填好');
    const last = updates[updates.length - 1] || [];
    result.checks.statusPushed = last.some((t) => t.id === platform.id && t.status === 'filled');

    tabs.hide();
    result.checks.hidden = (updates[updates.length - 1] || []).every((t) => !t.active);

    tabs.show(platform.id);
    result.checks.reshow = (updates[updates.length - 1] || []).some((t) => t.id === platform.id && t.active);

    tabs.close(platform.id);
    result.checks.closed = tabs.list().length === 0;

    result.ok = Object.values(result.checks).every(Boolean);
  } catch (err) {
    result.error = err && err.stack ? err.stack : String(err);
  } finally {
    try {
      tabs.closeAll();
    } catch (err) {
      /* ignore */
    }
    fs.writeFileSync(path.join(outDir, 'tabs-report.json'), JSON.stringify(result, null, 2), 'utf8');
    try {
      await server.close();
    } catch (err) {
      /* ignore */
    }
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
  }

  console.log('TABS_SELFTEST=' + (result.ok ? 'PASS' : 'FAIL'));
  console.log(JSON.stringify(result.checks, null, 2));
  if (result.error) console.error(result.error);
  app.exit(result.ok ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error('tabs selftest 启动失败', err);
  app.exit(1);
});
