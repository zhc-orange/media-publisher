'use strict';

/**
 * 诊断工具：用现有的平台登录态副本打开真实页面，截图并导出结构，
 * 可选地注入一个视频文件，观察页面后续行为。
 *
 * 用法：
 *   MP_PROFILE=<data-dir> electron scripts/probe-page.js <url> [videoPath]
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const Cdp = require('../src/main/cdp');
const selectors = require('../src/main/selectors');
const diagnostics = require('../src/main/diagnostics');

const profileDir = process.env.MP_PROFILE || '';
if (profileDir) app.setPath('userData', profileDir);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const targetUrl = process.argv[2] || process.env.MP_URL || 'https://creator.douyin.com/creator-micro/content/upload';
const videoPath = process.env.MP_VIDEO || process.argv[3] || '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot(win, label, outDir, steps) {
  let shot = '';
  let page = {};
  try {
    const image = await win.webContents.capturePage();
    shot = path.join(outDir, `${label}.png`);
    fs.writeFileSync(shot, image.toPNG());
  } catch (err) {
    shot = `shot error: ${err.message}`;
  }
  try {
    page = await win.webContents.executeJavaScript(
      `(function () {
        const fileInputs = Array.from(document.querySelectorAll('input[type=file]')).map(function (el) {
          const r = el.getBoundingClientRect();
          return {
            accept: el.getAttribute('accept') || '',
            cls: el.className || '',
            id: el.id || '',
            name: el.getAttribute('name') || '',
            visible: r.width > 2 && r.height > 2,
            files: el.files ? el.files.length : 0,
            names: el.files ? Array.from(el.files).map(function (f) { return f.name; }) : []
          };
        });
        const uploadTexts = Array.from(document.querySelectorAll('button, [role=button], span, div'))
          .filter(function (el) { const t = (el.innerText || '').trim(); return t && t.length < 20 && /上传|发布|点击/.test(t); })
          .slice(0, 25)
          .map(function (el) { return el.tagName.toLowerCase() + ':' + (el.innerText || '').trim(); });
        const videos = Array.from(document.querySelectorAll('video')).map(function (v) {
          return { src: String(v.currentSrc || v.src || '').slice(0, 120), ready: v.readyState, duration: v.duration };
        });
        return {
          url: location.href,
          title: document.title,
          ready: document.readyState,
          fileInputs: fileInputs,
          uploadTexts: uploadTexts,
          videos: videos,
          hasPending: /上传中|正在上传|处理中|转码中/.test(document.body ? document.body.innerText : ''),
          bodyStart: String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 500)
        };
      })()`,
      true
    );
  } catch (err) {
    page = { error: err.message };
  }
  steps.push({ label, shot, page });
  try {
    const scan = await diagnostics.collect(win, { platformId: 'probe', step: label });
    if (scan && scan.page) {
      page.fields = (scan.page.fields || []).slice(0, 40);
      page.buttons = (scan.page.buttons || []).filter((b) => /发布|标题|作品|话题|保存/.test(b.text)).slice(0, 30);
      steps[steps.length - 1].scan = true;
    }
  } catch (err) {
    /* ignore */
  }
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(page, null, 2).slice(0, 2500));
  return page;
}

async function main() {
  const outDir = path.join(app.getPath('userData'), 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { url: targetUrl, videoPath, steps: [] };
  const steps = report.steps;

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
    await win.loadURL(targetUrl).catch((err) => console.log('loadURL 提示：', err.message));
    await sleep(6000);
    await snapshot(win, '01-entry', outDir, steps);

    if (videoPath) {
      const marked = await win.webContents.executeJavaScript(
        selectors.fileInputScript(['input[type=file]'], 'video'),
        true
      );
      report.marked = marked;
      console.log('markFileInput:', JSON.stringify(marked));
      if (marked && marked.found) {
        const cdp = new Cdp(win.webContents);
        try {
          await cdp.setFileInputFiles('input[data-dsh-file="1"]', [videoPath]);
          report.injected = true;
          console.log('已注入文件');
        } catch (err) {
          report.injectError = err.message;
          console.log('注入失败：', err.message);
        }
        await sleep(4000);
        await snapshot(win, '02-after-4s', outDir, steps);
        await sleep(6000);
        await snapshot(win, '03-after-10s', outDir, steps);
        await sleep(10000);
        await snapshot(win, '04-after-20s', outDir, steps);
      }
    }
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    const file = path.join(outDir, 'report.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
    console.log('PROBE_REPORT=' + file);
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(0);
  }
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
