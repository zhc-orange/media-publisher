'use strict';

/**
 * 标签页管理：
 * - 普通平台：每个平台一个 WebContentsView，叠在主窗口内容区，共用持久化 session。
 * - YouTube / TikTok：走 Chrome 通道（真实 Chrome 窗口 + CDP），避免 Google 判定内嵌浏览器不安全。
 */

const { session, WebContentsView } = require('electron');
const { TAB_BAR_HEIGHT } = require('./constants');

const UA = () =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

class TabManager {
  constructor(win, { onUpdate, chrome } = {}) {
    this.win = win;
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
    this.chrome = chrome || null;
    this.tabs = new Map();
    this.activeId = null;
    this.ses = session.fromPartition('persist:platforms');
    this.ses.setUserAgent(UA());
    this.ses.setPermissionRequestHandler((webContents, permission, callback) => {
      // 平台页面只需要剪贴板/全屏这类常规权限，摄像头、麦克风、定位一律拒绝
      const allow = permission === 'clipboard-read' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen';
      callback(allow);
    });
    const relayout = () => this.layout();
    this.win.on('resize', relayout);
    this.win.on('maximize', relayout);
    this.win.on('unmaximize', relayout);
    this.win.on('enter-full-screen', relayout);
    this.win.on('leave-full-screen', relayout);
  }

  bounds() {
    let width = 0;
    let height = 0;
    try {
      const size = this.win.getContentSize();
      width = size[0];
      height = size[1];
    } catch (err) {
      /* 窗口可能已销毁 */
    }
    return { x: 0, y: TAB_BAR_HEIGHT, width: Math.max(0, width), height: Math.max(0, height - TAB_BAR_HEIGHT) };
  }

  list() {
    return Array.from(this.tabs.values()).map((entry) => {
      const wc = entry.view.webContents;
      const destroyed = wc.isDestroyed();
      return {
        id: entry.platform.id,
        name: entry.platform.name,
        status: entry.status,
        message: entry.message,
        engine: entry.engine || 'electron',
        url: destroyed ? '' : wc.getURL(),
        title: destroyed ? '' : wc.getTitle(),
        active: entry.platform.id === this.activeId,
      };
    });
  }

  emitUpdate() {
    this.onUpdate(this.list());
  }

  _trackChromeTab(entry) {
    const wc = entry.view.webContents;
    wc.on('did-navigate', () => this.emitUpdate());
    wc.on('did-finish-load', () => this.emitUpdate());
    wc.on('page-title-updated', () => this.emitUpdate());
  }

  async ensureChrome(platform) {
    const existing = this.tabs.get(platform.id);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    this.tabs.delete(platform.id);
    if (!this.chrome) throw new Error('Chrome 通道未初始化，无法打开该平台');
    const tab = await this.chrome.createTab(platform.id);
    const entry = { platform, view: tab, status: 'idle', message: '', engine: 'chrome' };
    this._trackChromeTab(entry);
    this.tabs.set(platform.id, entry);
    this.emitUpdate();
    return entry;
  }

  ensure(platform) {
    if (platform.engine === 'chrome') return this.ensureChrome(platform);
    return this.ensureElectron(platform);
  }

  ensureElectron(platform) {
    const existing = this.tabs.get(platform.id);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;

    if (existing) {
      try {
        this.win.contentView.removeChildView(existing.view);
      } catch (err) {
        /* ignore */
      }
      this.tabs.delete(platform.id);
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:platforms',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    this.win.contentView.addChildView(view);
    view.setBounds(this.bounds());
    try {
      view.setVisible(false);
    } catch (err) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }

    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      // 登录/作者主页等弹窗，直接在同一个标签页里打开，避免丢失自动化上下文
      try {
        wc.loadURL(url);
      } catch (err) {
        /* ignore */
      }
      return { action: 'deny' };
    });
    wc.on('did-navigate', () => this.emitUpdate());
    wc.on('did-navigate-in-page', () => this.emitUpdate());
    wc.on('did-finish-load', () => this.emitUpdate());
    wc.on('page-title-updated', () => this.emitUpdate());
    wc.on('render-process-gone', (_event, details) => {
      const entry = this.tabs.get(platform.id);
      if (entry) {
        entry.status = 'failed';
        entry.message = `页面崩溃：${details.reason}`;
      }
      this.emitUpdate();
    });

    const entry = { platform, view, status: 'idle', message: '', engine: 'electron' };
    this.tabs.set(platform.id, entry);
    this.emitUpdate();
    return entry;
  }

  hideView(entry) {
    if (entry.engine === 'chrome') return;
    try {
      entry.view.setVisible(false);
    } catch (err) {
      try {
        entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      } catch (err2) {
        /* ignore */
      }
    }
  }

  async show(platformId) {
    const entry = this.tabs.get(platformId);
    if (!entry) throw new Error(`标签页不存在：${platformId}`);
    if (entry.engine === 'chrome') {
      // 切到 Chrome 窗口时，把内置浏览器标签页收起来，避免它继续盖住主窗口
      for (const [id, other] of this.tabs) {
        if (id !== platformId) this.hideView(other);
      }
      await entry.view.activate();
      this.activeId = platformId;
      this.emitUpdate();
      return entry;
    }
    for (const [id, other] of this.tabs) {
      if (id !== platformId) this.hideView(other);
    }
    entry.view.setBounds(this.bounds());
    try {
      entry.view.setVisible(true);
    } catch (err) {
      entry.view.setBounds(this.bounds());
    }
    this.activeId = platformId;
    try {
      entry.view.webContents.focus();
    } catch (err) {
      /* ignore */
    }
    this.emitUpdate();
    return entry;
  }

  hide() {
    for (const entry of this.tabs.values()) this.hideView(entry);
    this.activeId = null;
    this.emitUpdate();
  }

  async close(platformId) {
    const entry = this.tabs.get(platformId);
    if (!entry) return;
    if (this.activeId === platformId) this.activeId = null;
    if (entry.engine === 'chrome') {
      this.tabs.delete(platformId);
      try {
        await this.chrome.closeTab(platformId);
      } catch (err) {
        /* ignore */
      }
      this.emitUpdate();
      return;
    }
    try {
      this.win.contentView.removeChildView(entry.view);
    } catch (err) {
      /* ignore */
    }
    try {
      entry.view.webContents.close();
    } catch (err) {
      /* ignore */
    }
    this.tabs.delete(platformId);
    this.emitUpdate();
  }

  closeAll() {
    for (const id of Array.from(this.tabs.keys())) {
      this.close(id).catch(() => {});
    }
  }

  setStatus(platformId, status, message) {
    const entry = this.tabs.get(platformId);
    if (!entry) return;
    if (status) entry.status = status;
    if (message !== undefined) entry.message = message;
    this.emitUpdate();
  }

  layout() {
    const bounds = this.bounds();
    for (const entry of this.tabs.values()) {
      if (entry.engine === 'chrome') continue;
      try {
        entry.view.setBounds(bounds);
      } catch (err) {
        /* ignore */
      }
    }
  }
}

module.exports = TabManager;
