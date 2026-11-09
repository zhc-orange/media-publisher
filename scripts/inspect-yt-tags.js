'use strict';

/**
 * 检查 YouTube 上传弹窗里的话题区/「显示更多」按钮结构（不上传视频）。
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
  try {
    const platform = getPlatform('youtube');
    const tab = await channel.createTab('youtube');
    await tab.webContents.loadURL(platform.entry);
    await sleep(4000);
    const channelId = await tab.webContents.executeJavaScript(selectors.channelIdScript(), true);
    await tab.webContents.loadURL(platform.uploadEntry.replace('{channelId}', channelId));
    await sleep(6000);
    const info = await tab.webContents.executeJavaScript(
      `(function () {
        function deepAll(root, sel, out) {
          var nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
          for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
          var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) deepAll(all[j].shadowRoot, sel, out);
          return out;
        }
        var all = deepAll(document, '*', []);
        var more = all.filter(function (el) {
          var t = (el.innerText || '').trim();
          return t === '显示更多' && el.getBoundingClientRect().width > 0;
        }).slice(0, 5).map(function (el) {
          return { tag: el.tagName, id: el.id, cls: String(el.className || '').slice(0, 60), text: (el.innerText || '').trim() };
        });
        var toggle = document.querySelector('#toggle-button');
        var tagContainer = document.querySelector('#tags-container');
        var tagInputs = deepAll(document, '#tags-container input, input[aria-label*="标签"]', []).map(function (el) {
          return { tag: el.tagName, id: el.id, aria: el.getAttribute('aria-label'), visible: el.getBoundingClientRect().width > 0 };
        });
        return {
          moreButtons: more,
          toggleExists: !!toggle,
          toggleText: toggle ? (toggle.innerText || '').trim().slice(0, 30) : '',
          tagContainerExists: !!tagContainer,
          tagInputs: tagInputs,
          bodyHasMore: document.body.innerText.indexOf('显示更多') >= 0,
          bodyTail: document.body.innerText.slice(200, 700)
        };
      })()`,
      true
    );
    console.log(JSON.stringify(info, null, 2));
  } catch (err) {
    console.error(err);
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
