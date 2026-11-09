'use strict';

/**
 * 快手完整流程验证：上传视频 → 作品描述（标题+正文）→ 话题。
 * 用法：MP_PROFILE=<copy> MP_VIDEO=<video> electron scripts/test-kuaishou-flow.js
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
  const platform = getPlatform('kuaishou');
  const videoPath = process.env.MP_VIDEO || '';
  const report = { ok: false };
  try {
    const res = await runPlatform({
      view: win,
      platform,
      task: { videoPath, coverPath: '', title: '快手测试标题', description: '快手测试描述', tags: ['测试'] },
      onLog: (_pid, message) => console.log('[log]', message),
      onStatus: (_pid, status, message) => console.log(`[status] ${status} ${message || ''}`),
      isCancelled: () => false,
    });
    report.status = res.status;
    await sleep(1500);
    report.page = await win.webContents.executeJavaScript(
      `(function () {
        var el = document.querySelector('#work-description-edit');
        return {
          url: location.href,
          editorText: el ? (el.innerText || el.textContent || '') : '',
          editorFound: !!el,
          body: document.body.innerText.slice(0, 300)
        };
      })()`,
      true
    );
    report.ok = res.status === 'filled' && String(report.page.editorText || '').indexOf('快手测试标题') >= 0 && String(report.page.editorText || '').indexOf('快手测试描述') >= 0;
    const shot = await win.webContents.capturePage();
    const out = path.join(app.getPath('temp'), 'kuaishou-test-result.png');
    fs.writeFileSync(out, shot.toPNG());
    report.shot = out;
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    console.log('KUAISHOU_FLOW=' + (report.ok ? 'PASS' : 'FAIL'));
    console.log(JSON.stringify(report, null, 2));
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(report.ok ? 0 : 1);
  }
});
