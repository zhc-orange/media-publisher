'use strict';

/**
 * 验证 app-media:// 预览协议：视频能否被 <video> 正常加载（含 Range）。
 * 用法：electron scripts/debug-media.js <videoPath>
 */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { registerMediaProtocol, PRIVILEGES } = require('../src/main/media-protocol');
const mediaStore = require('../src/main/media-store');

const userData = path.join(app.getPath('temp'), 'mp-media-test');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');
protocol.registerSchemesAsPrivileged(PRIVILEGES);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const videoPath = process.argv[2];
  if (!videoPath || !fs.existsSync(videoPath)) {
    console.log('MEDIA_TEST=FAIL 文件不存在:', videoPath);
    app.exit(1);
    return;
  }
  registerMediaProtocol();
  mediaStore.set('video', videoPath);
  const win = new BrowserWindow({ width: 900, height: 600, show: false });
  win.webContents.on('console-message', (_e, level, message) => console.log('[renderer]', message));
  await win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<video id="v" controls preload="metadata" style="width:640px"></video><script>' +
          'const v=document.getElementById("v");' +
          'window.__err="";' +
          'v.onerror=()=>{window.__err="code:"+(v.error?v.error.code:"?")+" "+v.error.message};' +
          'v.src="app-media://video?v=1";' +
          '</script>'
      )
  );
  await sleep(4000);
  const result = await win.webContents.executeJavaScript(
    `({ ready: document.getElementById('v').readyState, err: window.__err, duration: document.getElementById('v').duration, w: document.getElementById('v').videoWidth })`,
    true
  );
  console.log('MEDIA_TEST_RESULT', JSON.stringify(result));
  console.log('MEDIA_TEST=' + (result.ready >= 1 && !result.err ? 'PASS' : 'FAIL'));
  win.destroy();
  app.exit(result.ready >= 1 && !result.err ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
