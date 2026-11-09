'use strict';

/**
 * 集成分测试：TabManager 走 Chrome 通道打开 YouTube 页面。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { getPlatform } = require('../src/main/config');
const TabManager = require('../src/main/tab-manager');
const ChromeChannel = require('../src/main/chrome-channel');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = path.join(app.getPath('temp'), 'mp-tabs-chrome-test');
  fs.mkdirSync(dataDir, { recursive: true });
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  const chrome = new ChromeChannel({ userDataDir: dataDir, networkMode: 'system', log: (m) => console.log('[chrome]', m) });
  const tabs = new TabManager(win, { chrome, onUpdate: () => {} });
  const report = { ok: false, checks: {} };

  try {
    const platform = getPlatform('youtube');
    const entry = await tabs.ensure(platform);
    report.checks.chromeEngine = entry.engine === 'chrome';
    await tabs.show('youtube');
    await entry.view.webContents.loadURL(platform.entry);
    await sleep(5000);
    const url = entry.view.webContents.getURL();
    const title = entry.view.webContents.getTitle();
    report.url = url;
    report.title = title;
    report.checks.loaded = /google\.com|youtube\.com/.test(url);
    report.checks.listed = tabs.list().some((t) => t.id === 'youtube' && t.engine === 'chrome');
    report.ok = Object.values(report.checks).every(Boolean);
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    fs.writeFileSync(path.join(dataDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('TABS_CHROME_SELFTEST=' + (report.ok ? 'PASS' : 'FAIL'));
    console.log(JSON.stringify(report, null, 2));
    try {
      await chrome.shutdown();
    } catch (err) {
      /* ignore */
    }
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(report.ok ? 0 : 1);
  }
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
