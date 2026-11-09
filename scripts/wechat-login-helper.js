'use strict';

/**
 * 视频号扫码登录窗口：使用程序真实数据目录，登录成功后自动退出并打印 WECHAT_LOGIN_OK。
 * 用法：electron scripts/wechat-login-helper.js
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');
app.setPath('userData', path.join(app.getPath('appData'), '自媒体发布助手'));

const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:platforms');
  await ses.setUserAgent(UA);
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    show: true,
    title: '微信视频号登录 - 扫码后自动关闭',
    webPreferences: { partition: 'persist:platforms', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadURL('https://channels.weixin.qq.com/platform/post/create').catch((e) => console.log('LOAD', e.message));
  console.log('WINDOW_READY 请用手机微信扫码登录');

  let closed = false;
  win.on('closed', () => {
    closed = true;
  });

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline && !closed) {
    await sleep(2000);
    let url = '';
    try {
      url = win.webContents.getURL();
    } catch (err) {
      break;
    }
    if (url.indexOf('/platform/') >= 0 && url.indexOf('/login') < 0) {
      const cookies = await ses.cookies.get({ domain: 'channels.weixin.qq.com' });
      console.log('WECHAT_LOGIN_OK', url, 'cookies=' + cookies.length);
      await sleep(2500);
      app.exit(0);
      return;
    }
    if (url.indexOf('/login') >= 0) {
      // 停留在登录页，继续等扫码
    }
  }
  console.log('WECHAT_LOGIN_TIMEOUT');
  app.exit(1);
});
