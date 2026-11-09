'use strict';

/**
 * 端到端自测：启动本地模拟平台 → 用真实引擎跑一遍「上传 + 填写」→ 断言页面确实收到了数据。
 * 运行：electron scripts/selftest.js
 * 结果写入 %APPDATA%/自媒体发布助手/selftest/report.json
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

const WIDTH = 1200;
const HEIGHT = 900;

async function main() {
  const outDir = path.join(app.getPath('userData'), 'selftest');
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();
  const result = { ok: false, checks: {}, logs: [] };

  const server = await createMockServer();
  const videoPath = path.join(os.tmpdir(), 'dsh-selftest-video.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(1024 * 512, 7));

  const rawPlatform = {
    id: 'mock',
    name: '模拟平台',
    order: 1,
    entry: server.url,
    note: '自测用',
    limits: { title: 30, description: 1000, tags: 5, maxFileMB: 100 },
    loginCheck: { selectors: ['.avatar'], urlExcludes: '/login', timeoutMs: 5000 },
    video: { openButton: ['text=上传视频'], input: ['input[type=file]'], accept: 'video', timeoutMs: 5000 },
    title: { selectors: ['input[placeholder*="标题"]'] },
    content: { selectors: ['div[contenteditable="true"]'] },
    tags: { mode: 'inline-hash', prefix: '#' },
    cover: { optional: true, input: ['input[type=file][accept*="image"]'] },
    upload: { doneSelectors: ['.video-preview'], pendingTexts: ['上传中'], timeoutMs: 30000 },
    publishButton: ['text=发布'],
  };

  const platform = validatePlatform(rawPlatform, 'selftest.json');
  const win = new BaseWindow({ width: WIDTH, height: HEIGHT, show: false });
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:selftest',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT });

  try {
    const res = await runPlatform({
      view,
      platform,
      task: {
        videoPath,
        coverPath: '',
        title: '测试标题',
        description: '测试简介',
        tags: ['话题一', '话题二'],
      },
      onLog: (_pid, message) => {
        result.logs.push(message);
        console.log('[log]', message);
      },
      onStatus: (_pid, status, message) => {
        result.logs.push(`[${status}] ${message}`);
        console.log('[status]', status, message);
      },
      isCancelled: () => false,
    });

    const state = await server.getState();
    const checks = {
      engineStatusFilled: res.status === 'filled',
      titleFilled: state.title === '测试标题',
      descriptionFilled: String(state.content || '').indexOf('测试简介') >= 0,
      tagsAppended: String(state.content || '').indexOf('#话题一') >= 0 && String(state.content || '').indexOf('#话题二') >= 0,
      videoInjected: state.fileName === path.basename(videoPath) && state.fileSize > 0,
    };
    result.checks = checks;
    result.state = state;
    result.engine = { status: res.status, warnings: res.warnings };
    result.ok = Object.values(checks).every(Boolean);
  } catch (err) {
    result.error = err && err.stack ? err.stack : String(err);
    result.checks.engineStatusFilled = false;
  } finally {
    result.elapsedMs = Date.now() - startedAt;
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(result, null, 2), 'utf8');
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
  }

  console.log('SELFTEST_RESULT=' + (result.ok ? 'PASS' : 'FAIL'));
  console.log(JSON.stringify(result.checks, null, 2));
  console.log(`报告：${path.join(outDir, 'report.json')}`);
  app.exit(result.ok ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error('selftest 启动失败', err);
  app.exit(1);
});
