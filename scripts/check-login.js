'use strict';

/**
 * 登录检测自检：用现有登录态打开各平台入口，跑一遍真实的登录判定逻辑。
 * 用法：MP_PROFILE=<data-dir> electron scripts/check-login.js [platformId...]
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadPlatforms } = require('../src/main/config');
const selectors = require('../src/main/selectors');

const profile = process.env.MP_PROFILE || '';
if (profile) app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');
// 逐个开关窗口，避免「所有窗口关闭」时 Electron 默认退出
app.on('window-all-closed', () => {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const platforms = loadPlatforms().filter((p) => !wanted.length || wanted.includes(p.id));
  const outDir = path.join(app.getPath('userData'), 'check-login');
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];

  for (const platform of platforms) {
    const win = new BrowserWindow({
      width: 1200,
      height: 860,
      show: false,
      webPreferences: {
        partition: 'persist:platforms',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const item = { id: platform.id, name: platform.name };
    try {
      await win.loadURL(platform.entry).catch(() => {});
      await sleep(6000);
      const st = await win.webContents.executeJavaScript(
        selectors.loginStateScript(platform.loginCheck.selectors, platform.loginCheck.urlExcludes, platform.loginCheck.rejectTexts),
        true
      );
      item.state = st;
      item.loggedInByRule = st.loggedIn || (st.hasFileInput && !(st.rejectHits || []).length);
    } catch (err) {
      item.error = err.message;
    } finally {
      try {
        win.destroy();
      } catch (err) {
        /* ignore */
      }
    }
    console.log(JSON.stringify(item, null, 2));
    results.push(item);
  }

  fs.writeFileSync(path.join(outDir, 'login-report.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('LOGIN_REPORT=' + path.join(outDir, 'login-report.json'));
  app.exit(0);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
