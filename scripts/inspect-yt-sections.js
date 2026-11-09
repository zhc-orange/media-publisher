'use strict';

/**
 * 上传真实视频后，检查 YouTube 详情区里「显示更多 / 标签」的真实 DOM 层。
 */

const { app } = require('electron');
const path = require('node:path');
const { getPlatform } = require('../src/main/config');
const selectors = require('../src/main/selectors');
const ChromeChannel = require('../src/main/chrome-channel');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = path.join(process.env.APPDATA || app.getPath('appData'), '自媒体发布助手');
  const channel = new ChromeChannel({ userDataDir: dataDir, networkMode: 'system', log: () => {} });
  const video = process.env.MP_VIDEO;
  try {
    const platform = getPlatform('youtube');
    const tab = await channel.createTab('youtube');
    await tab.webContents.loadURL(platform.entry);
    await sleep(4000);
    const channelId = await tab.webContents.executeJavaScript(selectors.channelIdScript(), true);
    await tab.webContents.loadURL(platform.uploadEntry.replace('{channelId}', channelId));
    await sleep(6000);
    const dbg = tab.webContents.debugger;
    await dbg.sendCommand('DOM.enable');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 0, pierce: true });
    const found = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [video] });
    await sleep(12000);
    const info = await tab.webContents.executeJavaScript(
      `(function () {
        function deepAll(root, sel, out) {
          var nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
          for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
          var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) deepAll(all[j].shadowRoot, sel, out);
          return out;
        }
        var more = deepAll(document, '*', []).filter(function (el) {
          var txt = String(el.innerText || '').trim();
          var aria = String(el.getAttribute('aria-label') || '');
          return (txt.indexOf('显示更多') >= 0 || aria.indexOf('显示更多') >= 0) && el.getBoundingClientRect().width > 0;
        }).slice(0, 8).map(function (el) {
          return { tag: el.tagName, id: el.id, cls: String(el.className || '').slice(0, 40), txt: String(el.innerText || '').trim().slice(0, 30), aria: String(el.getAttribute('aria-label') || ''), shadow: !!el.shadowRoot };
        });
        var tagInputs = deepAll(document, '#tags-container input, input[aria-label*="标签"], input[name*="tag"]', []);
        return {
          moreCandidates: more,
          tagContainers: deepAll(document, '#tags-container', []).length,
          tagInputs: tagInputs.length,
          bodyTail: document.body.innerText.slice(-1000)
        };
      })()`,
      true
    );
    console.log(JSON.stringify(info, null, 2));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  } finally {
    try {
      await channel.shutdown();
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
