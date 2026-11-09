'use strict';

/**
 * 观察视频号发表页就绪时间：URL、文件输入框、描述编辑器出现的时间线。
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
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { partition: 'persist:platforms', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await win.loadURL('https://channels.weixin.qq.com/platform/post/create').catch(() => {});
  } catch (err) {
    /* ignore */
  }
  for (let i = 0; i <= 30; i += 1) {
    const info = await win.webContents
      .executeJavaScript(
        `(function(){
          return {
            url: location.href,
            files: document.querySelectorAll('input[type=file]').length,
            textarea: document.querySelectorAll('textarea').length,
            editable: document.querySelectorAll('[contenteditable="true"]').length,
            bodyLen: document.body ? document.body.innerText.length : 0,
            body: document.body ? document.body.innerText.slice(0, 60).replace(/\\n/g, ' / ') : ''
          };
        })()`,
        true
      )
      .catch((e) => ({ err: e.message }));
    console.log(i + 's', JSON.stringify(info));
    await sleep(1000);
  }
  try {
    const shot = await win.webContents.capturePage();
    require('node:fs').writeFileSync(path.join(app.getPath('temp'), 'wechat-watch.png'), shot.toPNG());
  } catch (err) {
    /* ignore */
  }
  try {
    win.destroy();
  } catch (err) {
    /* ignore */
  }
  app.exit(0);
});
