'use strict';

/**
 * 抖音封面弹窗结构探测：上传视频后点「设置封面」，导出图片输入框与按钮。
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');
const profile = process.env.MP_PROFILE || '';
if (profile) app.setPath('userData', profile);

const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:platforms');
  await ses.setUserAgent(UA);
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { partition: 'persist:platforms', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const send = (m, p) => dbg.sendCommand(m, p || {});
  const report = {};
  try {
    await win.loadURL('https://creator.douyin.com/creator-micro/content/upload').catch(() => {});
    await sleep(7000);
    await send('DOM.enable');
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
    let nodeId = 0;
    const walk = (node) => {
      if (!node) return;
      const attrs = node.attributes || [];
      const map = {};
      for (let i = 0; i < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1];
      if (node.nodeName === 'INPUT' && String(map.type || '').toLowerCase() === 'file' && String(map.accept || '').indexOf('image') >= 0) {
        nodeId = nodeId || node.nodeId;
      }
      (node.children || []).forEach(walk);
      (node.shadowRoots || []).forEach(walk);
    };
    walk(root);
    if (nodeId) {
      if (!process.env.MP_VIDEO) throw new Error('请通过 MP_VIDEO 环境变量指定一个视频文件');
      await send('DOM.setFileInputFiles', {
        nodeId,
        files: [process.env.MP_VIDEO],
      });
    }
    await sleep(14000);
    report.urlBefore = win.webContents.getURL();
    // 关闭话题下拉，再点设置封面
    await win.webContents.executeJavaScript(`(function(){ document.body.click(); return true; })()`, true);
    await sleep(500);
    const clicked = await win.webContents.executeJavaScript(
      `(function () {
        var all = Array.from(document.querySelectorAll('*'));
        var target = all.filter(function (el) {
          var t = (el.innerText || '').trim();
          var r = el.getBoundingClientRect();
          return (t === '设置封面' || t === '更换封面') && r.width > 0 && r.width < 300;
        })[0];
        if (!target) return false;
        target.click();
        return true;
      })()`,
      true
    );
    report.clicked = clicked;
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
          var t = (el.innerText || '').trim(); return t && t.length <= 12 ? t : '';
        }).filter(Boolean);
        return {
          inputs: inputs,
          buttons: Array.from(new Set(buttons)).slice(0, 40),
          bodyTail: document.body.innerText.slice(-800)
        };
      })()`,
      true
    );
    try {
      const shot = await win.webContents.capturePage();
      const out = path.join(app.getPath('temp'), 'douyin-cover-dialog.png');
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
