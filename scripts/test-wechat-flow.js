'use strict';

/**
 * 微信视频号完整流程验证（用现成登录态副本）：
 * 打开发表页 → 注入视频 → 等上传 → 填描述/话题 → 停在发表前。
 * 用法：MP_PROFILE=<copy> MP_VIDEO=<video> electron scripts/test-wechat-flow.js
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
  const platform = getPlatform('wechat');
  const videoPath = process.env.MP_VIDEO || '';
  const report = { ok: false };
  try {
    const res = await runPlatform({
      view: win,
      platform,
      task: { videoPath, coverPath: '', title: '视频号测试标题', description: '视频号测试描述', tags: ['测试'] },
      onLog: (_pid, message) => console.log('[log]', message),
      onStatus: (_pid, status, message) => console.log(`[status] ${status} ${message || ''}`),
      isCancelled: () => false,
    });
    report.status = res.status;
    await sleep(2000);
    report.page = await win.webContents.executeJavaScript(
      `(function () {
        var inputs = Array.from(document.querySelectorAll('input[type=file]'));
        var editables = Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).map(function (el) {
          return { tag: el.tagName, cls: String(el.className || '').slice(0, 40), text: (el.innerText || el.value || '').slice(0, 80) };
        });
        return {
          url: location.href,
          fileCount: inputs.length,
          filesSelected: inputs.some(function (el) { return el.files && el.files.length > 0; }),
          editables: editables,
          body: document.body.innerText.slice(0, 500)
        };
      })()`,
      true
    );
    report.ok = res.status === 'filled';
    const shot = await win.webContents.capturePage();
    const out = path.join(app.getPath('temp'), 'wechat-test-result.png');
    fs.writeFileSync(out, shot.toPNG());
    report.shot = out;
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    console.log('WECHAT_FLOW=' + (report.ok ? 'PASS' : 'FAIL'));
    console.log(JSON.stringify(report, null, 2));
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(report.ok ? 0 : 1);
  }
});
