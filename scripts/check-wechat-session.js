'use strict';

/**
 * 用应用 profile 检查视频号登录态：列出所有 weixin Cookie，用 Chrome UA 打开上传页。
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const profile = process.env.MP_PROFILE || '';
if (profile) app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:platforms');
  await ses.setUserAgent(UA);
  const all = await ses.cookies.get({});
  const weixin = all.filter((c) => String(c.domain || '').indexOf('weixin') >= 0 || String(c.domain || '').indexOf('qq.com') >= 0);
  console.log('WEIXIN_COOKIES', JSON.stringify(weixin.map((c) => ({ n: c.name, d: c.domain, p: c.path, exp: c.expirationDate })), null, 2));

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    webPreferences: { partition: 'persist:platforms', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await win.loadURL('https://channels.weixin.qq.com/platform/post/create').catch((e) => console.log('LOAD_ERROR', e.message));
    await sleep(9000);
    console.log('FINAL_URL', win.webContents.getURL());
    console.log('BODY', (await win.webContents.executeJavaScript('document.body.innerText.slice(0,300)', true).catch(() => 'ERR')));
    try {
      const shot = await win.webContents.capturePage();
      require('node:fs').writeFileSync(path.join(app.getPath('temp'), 'wechat-login-check.png'), shot.toPNG());
      console.log('SHOT_OK');
    } catch (err) {
      console.log('SHOT_FAIL', err.message);
    }
  } finally {
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(0);
  }
});
