'use strict';

/**
 * 调试：视频号 Shadow DOM 里的 file input 能否通过 Runtime.evaluate + DOM.requestNode 定位。
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

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
  try {
    await win.loadURL('https://channels.weixin.qq.com/platform/post/create').catch(() => {});
    await sleep(10000);
    await send('DOM.enable');
    const expr = `(function () {
      function all(root, sel, out) {
        out = out || [];
        try { var l = root.querySelectorAll(sel); for (var i=0;i<l.length;i++) out.push(l[i]); } catch(e) {}
        var n = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (var j=0;j<n.length;j++) if (n[j].shadowRoot) all(n[j].shadowRoot, sel, out);
        return out;
      }
      var el = all(document, 'input[type="file"]', [])[0];
      if (el) el.setAttribute('data-dsh-file', '1');
      return el || null;
    })()`;
    const ev = await send('Runtime.evaluate', { expression: expr, returnByValue: false, userGesture: true });
    console.log('EVAL', JSON.stringify(ev.result && { type: ev.result.type, objectId: ev.result.objectId, sub: ev.result.subtype }));
    const objectId = ev.result && ev.result.objectId;
    if (objectId) {
      try {
        const req = await send('DOM.requestNode', { objectId });
        console.log('REQUEST_NODE', JSON.stringify(req));
      } catch (err) {
        console.log('REQUEST_NODE_ERR', err.message);
      }
      try {
        const desc = await send('DOM.describeNode', { objectId });
        console.log('DESCRIBE', JSON.stringify(desc.node && { nodeName: desc.node.nodeName, nodeId: desc.node.nodeId, backendNodeId: desc.node.backendNodeId }));
      } catch (err) {
        console.log('DESCRIBE_ERR', err.message);
      }
    }
    // 尝试从完整 DOM 树里按属性找
    try {
      const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
      let found = 0;
      const walk = (node) => {
        if (!node) return;
        const attrs = node.attributes || [];
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === 'data-dsh-file' && attrs[i + 1] === '1') found = node.nodeId;
        }
        for (const child of node.children || []) walk(child);
        for (const sr of node.shadowRoots || []) walk(sr);
      };
      walk(root);
      console.log('TREE_NODE_ID', found);
    } catch (err) {
      console.log('TREE_ERR', err.message);
    }
  } catch (err) {
    console.log('ERR', err.message);
  } finally {
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(0);
  }
});
