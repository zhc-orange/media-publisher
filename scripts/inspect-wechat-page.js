'use strict';

/**
 * 导出视频号发表页结构：文件输入框、编辑器、按钮、iframe、shadow root。
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const profile = process.env.MP_PROFILE || '';
if (profile) app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:platforms');
  await ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36');
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { partition: 'persist:platforms', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const report = {};
  const logs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (logs.length < 40) logs.push(level + ': ' + message);
  });
  try {
    await win.loadURL('https://channels.weixin.qq.com/platform/post/create').catch((e) => (report.loadError = e.message));
    await sleep(12000);
    report.url = win.webContents.getURL();
    report.title = win.webContents.getTitle();
    report.cookies = (await ses.cookies.get({ domain: 'channels.weixin.qq.com' })).map((c) => c.name);
    report.page = await win.webContents.executeJavaScript(
      `(function () {
        function deepAll(root, sel, out) {
          var nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
          for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
          var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) deepAll(all[j].shadowRoot, sel, out);
          return out;
        }
        var fileInputs = deepAll(document, 'input[type=file]', []).map(function (el) {
          return { accept: el.accept, hidden: el.getBoundingClientRect().width < 2, outer: el.outerHTML.slice(0, 160) };
        });
        var editables = deepAll(document, '[contenteditable="true"], textarea', []).map(function (el) {
          var r = el.getBoundingClientRect();
          return { tag: el.tagName, cls: String(el.className || '').slice(0, 50), placeholder: el.getAttribute('data-placeholder') || el.placeholder || '', w: Math.round(r.width), h: Math.round(r.height) };
        });
        var buttons = deepAll(document, 'button, [role="button"], .weui-desktop-btn, [class*="btn"]', []).map(function (el) {
          var t = String(el.innerText || '').trim().slice(0, 20);
          return t ? t : '';
        }).filter(Boolean).slice(0, 30);
        var iframes = Array.from(document.querySelectorAll('iframe')).map(function (f) { return String(f.src || '').slice(0, 100); });
        return {
          body: document.body.innerText.slice(0, 900),
          fileInputs: fileInputs,
          editables: editables,
          buttons: buttons,
          iframes: iframes,
          uploadText: document.body.innerText.indexOf('添加视频') >= 0 || document.body.innerText.indexOf('上传') >= 0
        };
      })()`,
      true
    );
    report.logs = logs;
    try {
      const shot = await win.webContents.capturePage();
      const out = path.join(app.getPath('temp'), 'wechat-post-page.png');
      fs.writeFileSync(out, shot.toPNG());
      report.shot = out;
    } catch (err) {
      report.shotError = err.message;
    }
  } catch (err) {
    report.error = err.message;
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
