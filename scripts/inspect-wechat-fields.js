'use strict';

/**
 * 注入视频后导出视频号字段：短标题输入框、描述编辑器、长度限制。
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');
app.setPath('userData', path.join(app.getPath('appData'), '自媒体发布助手'));

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

  const deepExpr = (sel) => `(function () {
    function all(root, sel, out) {
      out = out || [];
      try { var l = root.querySelectorAll(sel); for (var i=0;i<l.length;i++) out.push(l[i]); } catch(e) {}
      var n = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var j=0;j<n.length;j++) if (n[j].shadowRoot) all(n[j].shadowRoot, sel, out);
      return out;
    }
    return all(document, ${JSON.stringify(sel)}, []);
  })()`;

  try {
    await win.loadURL('https://channels.weixin.qq.com/platform/post/create').catch(() => {});
    await sleep(9000);
    await send('DOM.enable');
    // 找文件输入节点并注入真实视频
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
    let nodeId = 0;
    const walk = (node) => {
      if (!node) return;
      const attrs = node.attributes || [];
      const map = {};
      for (let i = 0; i < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1];
      if (node.nodeName === 'INPUT' && String(map.type || '').toLowerCase() === 'file') nodeId = nodeId || node.nodeId;
      (node.children || []).forEach(walk);
      (node.shadowRoots || []).forEach(walk);
    };
    walk(root);
    report.fileNode = nodeId;
    if (nodeId) {
      if (!process.env.MP_VIDEO) throw new Error('请通过 MP_VIDEO 环境变量指定一个视频文件');
      await send('DOM.setFileInputFiles', {
        nodeId,
        files: [process.env.MP_VIDEO],
      });
    }
    await sleep(12000);
    report.fields = await win.webContents.executeJavaScript(
      `(function () {
        function all(root, sel, out) {
          out = out || [];
          try { var l = root.querySelectorAll(sel); for (var i=0;i<l.length;i++) out.push(l[i]); } catch(e) {}
          var n = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j=0;j<n.length;j++) if (n[j].shadowRoot) all(n[j].shadowRoot, sel, out);
          return out;
        }
        function desc(el) {
          var r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 40),
            placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
            maxlength: el.getAttribute('maxlength') || '',
            value: el.value != null ? String(el.value).slice(0, 30) : '',
            text: String(el.innerText || '').slice(0, 30),
            w: Math.round(r.width), h: Math.round(r.height),
            visible: r.width > 2 && r.height > 2
          };
        }
        return {
          inputs: all(document, 'input', []).filter(function (el) { return el.type !== 'file'; }).map(desc),
          textareas: all(document, 'textarea', []).map(desc),
          editables: all(document, '[contenteditable="true"]', []).map(desc),
          body: document.body.innerText.slice(0, 300)
        };
      })()`,
      true
    );
    try {
      const shot = await win.webContents.capturePage();
      const out = path.join(app.getPath('temp'), 'wechat-fields.png');
      fs.writeFileSync(out, shot.toPNG());
      report.shot = out;
    } catch (err) {
      /* ignore */
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
