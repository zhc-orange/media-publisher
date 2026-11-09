'use strict';

/**
 * 检查微信视频号登录态：加载上传页，看最终 URL、Cookie、localStorage。
 * 用法：MP_PROFILE=<data-dir> [MP_DIRECT=1] electron scripts/inspect-wechat.js
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const profile = process.env.MP_PROFILE || '';
if (profile) app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');
if (process.env.MP_DIRECT === '1') app.commandLine.appendSwitch('no-proxy-server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:platforms');
  try {
    await ses.setProxy({ mode: process.env.MP_DIRECT === '1' ? 'direct' : 'system' });
  } catch (err) {
    /* ignore */
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    webPreferences: { partition: 'persist:platforms', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const report = {};
  try {
    try {
      await win.loadURL('https://channels.weixin.qq.com/platform/post/create');
    } catch (err) {
      report.loadError = err.message;
    }
    await sleep(12000);
    report.url = win.webContents.getURL();
    report.title = win.webContents.getTitle();
    report.body = await win.webContents
      .executeJavaScript('document.body ? document.body.innerText.slice(0, 500) : ""', true)
      .catch((e) => 'ERR ' + e.message);
    report.cookies = (await ses.cookies.get({ domain: 'channels.weixin.qq.com' })).map((c) => c.name + '=' + String(c.value).slice(0, 8));
    report.localStorage = await win.webContents
      .executeJavaScript('(function(){try{return Object.keys(localStorage).slice(0,15)}catch(e){return ["ERR"]}})()', true)
      .catch(() => []);
    report.fileInputs = await win.webContents
      .executeJavaScript('document.querySelectorAll("input[type=file]").length', true)
      .catch(() => -1);
  } catch (err) {
    report.error = err.message;
  } finally {
    console.log(JSON.stringify(report, null, 2));
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(0);
  }
});
