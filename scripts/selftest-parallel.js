'use strict';

/**
 * 并行引擎自测：两个独立页面同时跑完整的 runPlatform 流程，
 * 验证并发时 CDP 注入、填写、状态判定互不干扰。
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

function makePlatform(id, url) {
  return validatePlatform(
    {
      id,
      name: `模拟-${id}`,
      order: 1,
      entry: url,
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
    `${id}.json`
  );
}

function makeView() {
  const win = new BaseWindow({ width: WIDTH, height: HEIGHT, show: false });
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:selftest-parallel',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  return { win, view };
}

async function main() {
  const outDir = path.join(app.getPath('userData'), 'selftest-parallel');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { ok: false, checks: {} };
  const s1 = await createMockServer();
  const s2 = await createMockServer();
  const videoPath = path.join(os.tmpdir(), 'dsh-parallel-video.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(1024 * 300, 3));

  const a = makeView();
  const b = makeView();
  const started = Date.now();

  try {
    const [ra, rb] = await Promise.all([
      runPlatform({
        view: a.view,
        platform: makePlatform('mock-a', s1.url),
        task: { videoPath, coverPath: '', title: '并行标题A', description: '并行简介A', tags: ['甲'] },
        onLog: (pid, msg) => console.log(`[A] ${msg}`),
        isCancelled: () => false,
      }),
      runPlatform({
        view: b.view,
        platform: makePlatform('mock-b', s2.url),
        task: { videoPath, coverPath: '', title: '并行标题B', description: '并行简介B', tags: ['乙'] },
        onLog: (pid, msg) => console.log(`[B] ${msg}`),
        isCancelled: () => false,
      }),
    ]);
    const sa = await s1.getState();
    const sb = await s2.getState();
    report.elapsedMs = Date.now() - started;
    report.checks = {
      bothFilled: ra.status === 'filled' && rb.status === 'filled',
      titleA: sa.title === '并行标题A',
      titleB: sb.title === '并行标题B',
      tagsA: String(sa.content || '').indexOf('#甲') >= 0,
      tagsB: String(sb.content || '').indexOf('#乙') >= 0,
      noCrossTalk: String(sa.content || '').indexOf('并行标题B') < 0 && String(sb.content || '').indexOf('并行标题A') < 0,
      filesInjected: sa.fileName === path.basename(videoPath) && sb.fileName === path.basename(videoPath),
    };
    report.ok = Object.values(report.checks).every(Boolean);
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    for (const s of [s1, s2]) {
      try {
        await s.close();
      } catch (err) {
        /* ignore */
      }
    }
    for (const w of [a, b]) {
      try {
        w.win.destroy();
      } catch (err) {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(videoPath);
    } catch (err) {
      /* ignore */
    }
    console.log('PARALLEL_SELFTEST=' + (report.ok ? 'PASS' : 'FAIL'));
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
