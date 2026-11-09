'use strict';

/**
 * 真实平台并发验证：用现有登录态副本，同时在两个平台跑完整上传+填写流程。
 * 用法：MP_PROFILE=<data-dir> MP_VIDEO=<video> MP_PLATFORMS=douyin,xiaohongshu \
 *       MP_TITLE=... MP_DESC=... MP_TAGS=... electron scripts/probe-parallel-real.js
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

const videoPath = process.env.MP_VIDEO || '';
const title = process.env.MP_TITLE || '测试标题';
const description = process.env.MP_DESC || '';
const tags = String(process.env.MP_TAGS || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
const ids = String(process.env.MP_PLATFORMS || 'douyin,xiaohongshu')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWindow() {
  return new BrowserWindow({
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
}

async function main() {
  const outDir = path.join(app.getPath('userData'), 'probe-parallel-real');
  fs.mkdirSync(outDir, { recursive: true });
  const platforms = loadPlatforms().filter((p) => ids.includes(p.id));
  const report = { startedAt: new Date().toISOString(), platforms: ids, results: {}, dom: {} };
  const started = Date.now();

  const jobs = platforms.map(async (platform) => {
    const prepared = prepareForPlatform({ title, description, tags }, platform, { autoTruncate: true });
    const win = makeWindow();
    const logs = [];
    try {
      const res = await runPlatform({
        view: win,
        platform,
        task: { videoPath, coverPath: '', title, description, tags },
        prepared,
        onLog: (_pid, message) => {
          logs.push(message);
          console.log(`[${platform.id}] ${message}`);
        },
        isCancelled: () => false,
      });
      await sleep(1200);
      const dom = await win.webContents.executeJavaScript(
        `(function () {
          const titleSelector = ${JSON.stringify(platform.title.selectors)};
          let titleValue = null;
          for (const s of titleSelector) {
            try { const el = document.querySelector(s); if (el) { titleValue = el.value != null ? el.value : (el.innerText || ''); break; } } catch (e) {}
          }
          const editors = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
            .filter(function (el) { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; })
            .map(function (el) { return (el.innerText || '').slice(0, 120); });
          return { url: location.href, titleValue: titleValue, editors: editors };
        })()`,
        true
      );
      report.results[platform.id] = { status: res.status, warnings: res.warnings, elapsedMs: Date.now() };
      report.dom[platform.id] = dom;
      return { id: platform.id, ok: res.status === 'filled', dom };
    } catch (err) {
      report.results[platform.id] = { status: 'failed', error: err.message };
      return { id: platform.id, ok: false, error: err.message };
    } finally {
      try {
        win.destroy();
      } catch (err) {
        /* ignore */
      }
    }
  });

  const outcomes = await Promise.all(jobs);
  report.elapsedMs = Date.now() - started;
  report.ok = outcomes.every((o) => o.ok);

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('PARALLEL_REAL=' + (report.ok ? 'PASS' : 'FAIL'));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
