'use strict';

/**
 * Chrome 通道端到端自测：用真实 Chrome 跑完整的 runPlatform 流程（本地模拟平台）。
 * 验证导航、JS 执行、文件注入、点击、输入在 CDP 下都正常。
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { createMockServer } = require('../src/main/mock-server');
const { validatePlatform } = require('../src/main/config');
const { runPlatform } = require('../src/main/engine');
const ChromeChannel = require('../src/main/chrome-channel');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

async function main() {
  const outDir = path.join(app.getPath('temp'), 'mp-chrome-selftest');
  fs.mkdirSync(outDir, { recursive: true });
  const videoPath = path.join(os.tmpdir(), 'dsh-chrome-video.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(1024 * 512, 9));
  const server = await createMockServer();
  const channel = new ChromeChannel({
    userDataDir: outDir,
    networkMode: 'system',
    log: (m) => console.log('[chrome]', m),
  });

  const platform = validatePlatform(
    {
      id: 'mock-chrome',
      name: 'Chrome 模拟平台',
      order: 1,
      entry: server.url,
      note: '',
      limits: { title: 30, description: 1000, tags: 5, maxFileMB: 100 },
      loginCheck: { selectors: ['.avatar'], urlExcludes: '/login', timeoutMs: 5000 },
      video: { openButton: ['text=上传视频'], input: ['input[type=file]'], accept: 'video', timeoutMs: 5000 },
      title: { selectors: ['input[placeholder*="标题"]'] },
      content: { selectors: ['div[contenteditable="true"]'] },
      tags: { mode: 'inline-hash', prefix: '#' },
      cover: { optional: true, input: ['input[type=file][accept*="image"]'] },
      upload: { doneSelectors: ['.video-preview'], pendingTexts: ['上传中'], timeoutMs: 30000 },
      publishButton: ['text=发布'],
    },
    'mock-chrome.json'
  );

  const report = { ok: false, checks: {} };
  try {
    const tab = await channel.createTab('mock-chrome');
    const res = await runPlatform({
      view: tab,
      platform,
      task: { videoPath, coverPath: '', title: 'Chrome标题', description: 'Chrome简介', tags: ['通道'] },
      onLog: (_pid, message) => console.log('[log]', message),
      isCancelled: () => false,
    });
    const state = await server.getState();
    report.checks = {
      filled: res.status === 'filled',
      title: state.title === 'Chrome标题',
      description: String(state.content || '').indexOf('Chrome简介') >= 0,
      tags: String(state.content || '').indexOf('#通道') >= 0,
      fileInjected: state.fileName === path.basename(videoPath) && state.fileSize > 0,
    };
    report.ok = Object.values(report.checks).every(Boolean);
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('CHROME_ENGINE_SELFTEST=' + (report.ok ? 'PASS' : 'FAIL'));
    console.log(JSON.stringify(report.checks, null, 2));
    if (report.error) console.log(report.error);
    try {
      await channel.shutdown();
    } catch (err) {
      /* ignore */
    }
    try {
      await server.close();
    } catch (err) {
      /* ignore */
    }
    try {
      fs.unlinkSync(videoPath);
    } catch (err) {
      /* ignore */
    }
    app.exit(report.ok ? 0 : 1);
  }
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
