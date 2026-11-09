'use strict';

/**
 * 抖音封面注入验证：上传视频 → 设置标题/正文/话题 → 封面。
 * 用法：MP_PROFILE=<copy> MP_VIDEO=<video> MP_COVER=<image> electron scripts/test-douyin-cover.js
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { getPlatform } = require('../src/main/config');
const { runPlatform } = require('../src/main/engine');

const profile = process.env.MP_PROFILE || '';
if (profile) app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:platforms');
  await ses.setUserAgent(
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
  );
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { partition: 'persist:platforms', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const platform = getPlatform('douyin');
  const report = { ok: false };
  try {
    const res = await runPlatform({
      view: win,
      platform,
      task: {
        videoPath: process.env.MP_VIDEO,
        coverPath: process.env.MP_COVER,
        title: '封面测试标题',
        description: '封面测试描述',
        tags: ['封面'],
      },
      onLog: (_pid, message) => console.log('[log]', message),
      onStatus: (_pid, status, message) => console.log(`[status] ${status} ${message || ''}`),
      isCancelled: () => false,
    });
    report.status = res.status;
    await sleep(1500);
    report.page = await win.webContents.executeJavaScript(
      `(function () {
        function all(root, sel, out) {
          out = out || [];
          try { var l = root.querySelectorAll(sel); for (var i=0;i<l.length;i++) out.push(l[i]); } catch(e) {}
          var n = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j=0;j<n.length;j++) if (n[j].shadowRoot) all(n[j].shadowRoot, sel, out);
          return out;
        }
        var files = all(document, 'input[type=file]', []).map(function (el) {
          return { accept: el.getAttribute('accept'), count: el.files ? el.files.length : 0, marked: el.getAttribute('data-dsh-file') };
        });
        return {
          url: location.href,
          fileInputs: files,
          body: document.body.innerText.slice(0, 220),
          hasCoverDialog: document.body.innerText.indexOf('设置封面') >= 0 || document.body.innerText.indexOf('选择封面') >= 0
        };
      })()`,
      true
    );
    const shot = await win.webContents.capturePage();
    const out = path.join(app.getPath('temp'), 'douyin-cover-result.png');
    fs.writeFileSync(out, shot.toPNG());
    report.shot = out;
    report.ok = res.status === 'filled';
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    console.log('DOUYIN_COVER=' + (report.ok ? 'PASS' : 'FAIL'));
    console.log(JSON.stringify(report, null, 2));
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(report.ok ? 0 : 1);
  }
});
