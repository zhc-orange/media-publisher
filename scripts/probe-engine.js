'use strict';

/**
 * 联调工具：用真实登录态跑一遍完整引擎流程（打开→登录→上传→填写），
 * 结束后截图并回读页面上的标题/正文/发布按钮，用于验证选择器与上传等待逻辑。
 *
 * 用法：
 *   MP_PROFILE=<data-dir> MP_VIDEO=<video> MP_PLATFORM=douyin MP_TITLE=... MP_DESC=... MP_TAGS=旅行,美食
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadPlatforms } = require('../src/main/config');
const { prepareForPlatform } = require('../src/main/limits');
const { runPlatform } = require('../src/main/engine');

const profile = process.env.MP_PROFILE || '';
if (profile) app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const platformId = process.env.MP_PLATFORM || 'douyin';
const videoPath = process.env.MP_VIDEO || '';
const title = process.env.MP_TITLE || '测试标题';
const description = process.env.MP_DESC || '';
const tags = String(process.env.MP_TAGS || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

async function main() {
  const platform = loadPlatforms().find((p) => p.id === platformId);
  if (!platform) throw new Error(`未知平台：${platformId}`);
  const prepared = prepareForPlatform({ title, description, tags }, platform, { autoTruncate: true });
  const outDir = path.join(app.getPath('userData'), 'probe-engine');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { platform: platformId, videoPath, title, description, tags, logs: [] };

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      partition: 'persist:platforms',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  try {
    report.result = await runPlatform({
      view: win,
      platform,
      task: { videoPath, coverPath: '', title, description, tags },
      prepared,
      screenshotsDir: outDir,
      onLog: (_pid, message) => {
        report.logs.push(message);
        console.log('[log]', message);
      },
      onStatus: (_pid, status, message) => console.log('[status]', status, message),
      isCancelled: () => false,
    });
    report.dom = await win.webContents.executeJavaScript(
      `(function () {
        const titleInput = document.querySelector('input[placeholder*="标题"]');
        const editors = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
          .filter(function (el) { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; })
          .map(function (el) { return (el.innerText || '').slice(0, 200); });
        const pub = Array.from(document.querySelectorAll('button')).find(function (b) { return (b.innerText || '').trim() === '发布'; });
        return {
          url: location.href,
          titleValue: titleInput ? titleInput.value : null,
          editorTexts: editors,
          publishFound: !!pub
        };
      })()`,
      true
    );
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'final.png'), img.toPNG());
  } catch (err) {
    report.error = `${err.name}: ${err.message}\n${err.stack || ''}`;
  } finally {
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('PROBE_ENGINE=' + (report.error ? 'FAIL' : 'PASS'));
    console.log(JSON.stringify(report.dom || {}, null, 2));
    if (report.error) console.log(report.error);
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(report.error ? 1 : 0);
  }
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
