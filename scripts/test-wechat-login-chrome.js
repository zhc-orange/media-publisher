'use strict';

/**
 * 用真实 Chrome 打开视频号登录页，看二维码能否正常加载（判断是否内嵌浏览器被拦）。
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const ChromeChannel = require('../src/main/chrome-channel');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const dataDir = path.join(app.getPath('temp'), 'mp-wechat-chrome-test');
  fs.mkdirSync(dataDir, { recursive: true });
  const channel = new ChromeChannel({ userDataDir: dataDir, networkMode: 'system', log: (m) => console.log('[chrome]', m) });
  try {
    const tab = await channel.createTab('wechat');
    await tab.webContents.loadURL('https://channels.weixin.qq.com/login.html');
    await sleep(9000);
    const info = await tab.webContents.executeJavaScript(
      `(function () {
        var iframes = Array.from(document.querySelectorAll('iframe')).map(function (f) { return f.src.slice(0, 120); });
        var imgs = Array.from(document.querySelectorAll('img')).filter(function (i) { return i.getBoundingClientRect().width > 40; }).length;
        var canvas = Array.from(document.querySelectorAll('canvas')).filter(function (c) { return c.getBoundingClientRect().width > 40; }).length;
        return {
          url: location.href,
          title: document.title,
          hasLoadFail: document.body.innerText.indexOf('加载失败') >= 0,
          iframes: iframes,
          imgs: imgs,
          canvas: canvas,
          body: document.body.innerText.slice(0, 260)
        };
      })()`,
      true
    );
    console.log(JSON.stringify(info, null, 2));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  } finally {
    try {
      await channel.shutdown();
    } catch (err) {
      /* ignore */
    }
    app.exit(0);
  }
});
