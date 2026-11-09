'use strict';

/**
 * YouTube 流程验证：
 *  默认只验证入口（studio → 取 channelId → ?d=ud 上传弹窗 → 有文件输入框）；
 *  设置 MP_FULL=1 时跑完整引擎（会上传视频、填写标题/简介/话题，停在发布前）。
 * 用法：MP_FULL=1 MP_VIDEO=<视频> electron scripts/test-youtube-flow.js
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { getPlatform } = require('../src/main/config');
const { runPlatform } = require('../src/main/engine');
const selectors = require('../src/main/selectors');
const ChromeChannel = require('../src/main/chrome-channel');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(tab, script) {
  return tab.webContents.executeJavaScript(script, true);
}

async function main() {
  const dataDir = path.join(process.env.APPDATA || app.getPath('appData'), '自媒体发布助手');
  const channel = new ChromeChannel({ userDataDir: dataDir, networkMode: 'system', log: (m) => console.log('[chrome]', m) });
  const platform = getPlatform('youtube');
  const report = { ok: false, steps: {} };
  const videoPath = process.env.MP_VIDEO || '';
  const full = process.env.MP_FULL === '1';

  try {
    const tab = await channel.createTab('youtube');
    await tab.webContents.loadURL(platform.entry);
    await sleep(4000);
    const channelId = await evaluate(tab, selectors.channelIdScript());
    report.steps.channelId = channelId || '';
    if (!channelId) throw new Error('未取到 channelId');
    await tab.webContents.loadURL(platform.uploadEntry.replace('{channelId}', channelId));
    await sleep(6000);
    report.steps.url = await evaluate(tab, 'location.href');
    report.steps.fileInputs = await evaluate(tab, 'document.querySelectorAll("input[type=file]").length');
    report.steps.uploadDialogText = await evaluate(tab, 'document.body.innerText.indexOf("选择文件") >= 0 || document.body.innerText.indexOf("拖放") >= 0');
    report.steps.entryOk = report.steps.fileInputs > 0 && report.steps.uploadDialogText;

    if (full) {
      if (!videoPath) throw new Error('缺少 MP_VIDEO');
      const res = await runPlatform({
        view: tab,
        platform,
        task: { videoPath, coverPath: '', title: '拉车拉车!', description: '拉车拉车!', tags: ['攀岩'] },
        onLog: (_pid, message) => console.log('[log]', message),
        onStatus: (_pid, status, message) => console.log(`[status] ${status} ${message || ''}`),
        isCancelled: () => false,
      });
      report.steps.status = res.status;
      await sleep(1500);
      report.steps.title = await evaluate(
        tab,
        `(function () {
          var el = document.querySelector('#textbox');
          return el ? (el.value != null ? el.value : el.innerText) : null;
        })()`
      );
      report.steps.description = await evaluate(
        tab,
        `(function () {
          var el = document.querySelector('#description-textarea #textbox');
          return el ? (el.innerText || '') : '';
        })()`
      );
      report.steps.tagsInput = await evaluate(tab, 'document.querySelectorAll("#tags-container input").length');
      report.steps.tagsVisible = await evaluate(
        tab,
        'Array.from(document.querySelectorAll("#tags-container input")).some(function (el) { return el.getBoundingClientRect().width > 0; })'
      );
      report.steps.bodyHead = await evaluate(tab, 'document.body.innerText.slice(0, 400)');
      report.ok = res.status === 'filled' && String(report.steps.title || '').indexOf('拉车拉车') >= 0;
    } else {
      report.ok = report.steps.entryOk;
    }
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    const outDir = path.join(app.getPath('temp'), 'mp-yt-flow');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('YOUTUBE_FLOW=' + (report.ok ? 'PASS' : 'FAIL'));
    console.log(JSON.stringify(report, null, 2));
    try {
      await channel.shutdown();
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
