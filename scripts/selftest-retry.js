'use strict';

/**
 * 重试注入自测：模拟「页面监听尚未挂上就收到文件」的情况（?late=4000），
 * 验证引擎会在没有反应时重新注入并最终完成上传与填写。
 */

const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { createMockServer } = require('../src/main/mock-server');
const { validatePlatform } = require('../src/main/config');
const { runPlatform } = require('../src/main/engine');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const WIDTH = 1100;
const HEIGHT = 820;

async function main() {
  const outDir = path.join(app.getPath('userData'), 'selftest-retry');
  fs.mkdirSync(outDir, { recursive: true });
  const server = await createMockServer();
  const videoPath = path.join(os.tmpdir(), 'dsh-retry-video.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(1024 * 256, 5));

  const platform = validatePlatform(
    {
      id: 'mock-retry',
      name: '模拟慢页面',
      order: 1,
      entry: `${server.url}?late=8000`,
      note: '',
      limits: { title: 30, description: 1000, tags: 5, maxFileMB: 100 },
      loginCheck: { selectors: ['.avatar'], urlExcludes: '/login', timeoutMs: 5000 },
      video: {
        openButton: ['text=上传视频'],
        readyTexts: ['上传视频'],
        input: ['input[type=file]'],
        accept: 'video',
        timeoutMs: 5000,
      },
      title: { selectors: ['input[placeholder*="标题"]'] },
      content: { selectors: ['div[contenteditable="true"]'] },
      tags: { mode: 'inline-hash', prefix: '#' },
      cover: { optional: true, input: ['input[type=file][accept*="image"]'] },
      upload: { doneSelectors: ['.video-preview'], pendingTexts: ['上传中'], timeoutMs: 30000 },
      publishButton: ['text=发布'],
    },
    'mock-retry.json'
  );

  const win = new BaseWindow({ width: WIDTH, height: HEIGHT, show: false });
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:selftest-retry',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT });

  const report = { ok: false, checks: {}, logs: [] };
  try {
    const res = await runPlatform({
      view,
      platform,
      task: { videoPath, coverPath: '', title: '慢页面标题', description: '慢页面简介', tags: ['重试'] },
      onLog: (_pid, message) => {
        report.logs.push(message);
        console.log('[log]', message);
      },
      isCancelled: () => false,
    });
    const state = await server.getState();
    report.checks = {
      filled: res.status === 'filled',
      retried: report.logs.some((l) => /重试|重新注入|change/.test(l)),
      title: state.title === '慢页面标题',
      fileInjected: state.fileName === path.basename(videoPath),
      tags: String(state.content || '').indexOf('#重试') >= 0,
    };
    report.ok = Object.values(report.checks).every(Boolean);
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    try {
      await server.close();
    } catch (err) {
      /* ignore */
    }
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    try {
      fs.unlinkSync(videoPath);
    } catch (err) {
      /* ignore */
    }
    console.log('RETRY_SELFTEST=' + (report.ok ? 'PASS' : 'FAIL'));
    console.log(JSON.stringify(report.checks, null, 2));
    if (report.error) console.log(report.error);
    app.exit(report.ok ? 0 : 1);
  }
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
