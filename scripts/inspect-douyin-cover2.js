'use strict';

/**
 * 抖音封面弹窗探测（真实上传）：先完成上传+填写（不带封面），再点「设置封面」。
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
  const report = {};
  try {
    await runPlatform({
      view: win,
      platform: getPlatform('douyin'),
      task: { videoPath: process.env.MP_VIDEO, coverPath: '', title: '封面弹窗测试', description: '描述', tags: [] },
      onLog: (_p, m) => console.log('[log]', m),
      isCancelled: () => false,
    });
    await sleep(1500);
    report.clicked = await win.webContents.executeJavaScript(
      `(function () {
        document.body.click();
        var all = Array.from(document.querySelectorAll('*'));
        var targets = all.filter(function (el) {
          var t = (el.innerText || '').trim();
          var r = el.getBoundingClientRect();
          return (t === '设置封面' || t === '更换封面') && r.width > 0 && r.width < 400;
        });
        if (!targets.length) return 'not-found';
        targets[0].click();
        return 'clicked:' + targets[0].innerText.trim();
      })()`,
      true
    );
    await sleep(3000);
    report.dialog = await win.webContents.executeJavaScript(
      `(function () {
        function all(root, sel, out) {
          out = out || [];
          try { var l = root.querySelectorAll(sel); for (var i=0;i<l.length;i++) out.push(l[i]); } catch(e) {}
          var n = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j=0;j<n.length;j++) if (n[j].shadowRoot) all(n[j].shadowRoot, sel, out);
          return out;
        }
        var inputs = all(document, 'input[type=file]', []).map(function (el) {
          var r = el.getBoundingClientRect();
          return { accept: el.getAttribute('accept'), w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display };
        });
        var buttons = all(document, 'button, [role="button"], [class*="btn"]', []).map(function (el) {
          var t = (el.innerText || '').trim(); return t && t.length <= 10 ? t : '';
        }).filter(Boolean);
        return { inputs: inputs, buttons: Array.from(new Set(buttons)).slice(0, 40), bodyTail: document.body.innerText.slice(-600) };
      })()`,
      true
    );
    try {
      const shot = await win.webContents.capturePage();
      const out = path.join(app.getPath('temp'), 'douyin-cover-dialog2.png');
      fs.writeFileSync(out, shot.toPNG());
      report.shot = out;
    } catch (err) {
      /* ignore */
    }
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    console.log(JSON.stringify(report, null, 2));
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(0);
  }
});
