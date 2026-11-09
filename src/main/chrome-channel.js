'use strict';

/**
 * Chrome 通道：启动本机 Chrome（独立用户目录）并通过 CDP 驱动。
 * 用途：YouTube / TikTok 等 Google 系登录在 Electron 内嵌浏览器里会被判定"不安全"，
 * 换成真实 Chrome 后可以正常登录；功能与 WebContentsView 版引擎对接（提供 webContents 兼容层）。
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (err) {
      /* ignore */
    }
  }
  return '';
}

function getJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error('invalid json'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

class ChromeTab {
  constructor(channel, platformId, targetId, sessionId) {
    this.channel = channel;
    this.platformId = platformId;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.currentUrl = '';
    this.currentTitle = '';
    this.loadWaiter = null;
    this.destroyed = false;
    this.listeners = { 'did-navigate': [], 'did-finish-load': [], 'page-title-updated': [] };

    this.webContents = {
      executeJavaScript: (script) => this.evaluate(script),
      loadURL: (url) => this.navigate(url),
      getURL: () => this.currentUrl,
      getTitle: () => this.currentTitle,
      isDestroyed: () => this.destroyed,
      reload: () => this.reload(),
      focus: () => this.activate(),
      insertText: (text) => this.channel.send('Input.insertText', { text: String(text) }, this.sessionId),
      debugger: {
        isAttached: () => true,
        attach: () => {},
        detach: () => {},
        sendCommand: (method, params) => this.channel.send(method, params || {}, this.sessionId),
      },
      on: (event, cb) => {
        if (this.listeners[event]) this.listeners[event].push(cb);
      },
      setWindowOpenHandler: () => {},
    };
  }

  emit(event, payload) {
    for (const cb of this.listeners[event] || []) {
      try {
        cb(payload, payload);
      } catch (err) {
        /* ignore */
      }
    }
  }

  onEvent(msg) {
    const method = msg.method;
    const params = msg.params || {};
    if (method === 'Page.frameNavigated' && (!params.frame || !params.frame.parentId)) {
      this.currentUrl = (params.frame && params.frame.url) || this.currentUrl;
      this.emit('did-navigate', { url: this.currentUrl });
    } else if (method === 'Page.loadEventFired') {
      this.refreshTitle().catch(() => {});
      const waiter = this.loadWaiter;
      this.loadWaiter = null;
      if (waiter) waiter();
      this.emit('did-finish-load', { url: this.currentUrl });
    }
  }

  async refreshTitle() {
    try {
      const title = await this.evaluate('document.title');
      if (title) {
        this.currentTitle = String(title);
        this.emit('page-title-updated', { title: this.currentTitle });
      }
    } catch (err) {
      /* ignore */
    }
  }

  async evaluate(script) {
    if (this.destroyed) throw new Error('Chrome 标签页已关闭');
    const res = await this.channel.send(
      'Runtime.evaluate',
      { expression: script, returnByValue: true, awaitPromise: true, userGesture: true },
      this.sessionId
    );
    if (res && res.exceptionDetails) {
      const detail = res.exceptionDetails;
      throw new Error((detail.exception && detail.exception.description) || detail.text || '页面脚本执行失败');
    }
    return res && res.result ? res.result.value : undefined;
  }

  async navigate(url) {
    if (this.destroyed) throw new Error('Chrome 标签页已关闭');
    await this.channel.send('Page.enable', {}, this.sessionId).catch(() => {});
    const waiter = new Promise((resolve) => {
      this.loadWaiter = resolve;
      setTimeout(() => {
        if (this.loadWaiter === resolve) this.loadWaiter = null;
        resolve();
      }, 30000);
    });
    try {
      await this.channel.send('Page.navigate', { url }, this.sessionId);
    } catch (err) {
      /* 站点内部重定向可能报错，继续等 load */
    }
    this.currentUrl = url;
    await waiter;
    await this.refreshTitle().catch(() => {});
    return { url: this.currentUrl };
  }

  async reload() {
    await this.channel.send('Page.reload', {}, this.sessionId).catch(() => {});
    return true;
  }

  async activate() {
    await this.channel.send('Target.activateTarget', { targetId: this.targetId }).catch(() => {});
  }

  async close() {
    this.destroyed = true;
    await this.channel.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

class ChromeChannel {
  constructor({ userDataDir, networkMode, log } = {}) {
    this.userDataDir = userDataDir;
    this.networkMode = networkMode || 'system';
    this.log = typeof log === 'function' ? log : () => {};
    this.profileDir = path.join(userDataDir, 'chrome-profile');
    this.proc = null;
    this.ws = null;
    this.started = false;
    this.starting = null;
    this.seq = 0;
    this.pending = new Map();
    this.tabs = new Map();
    this.bySession = new Map();
    this.browserUrl = '';
  }

  async ensureStarted() {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async startInternal() {
    const browser = findBrowser();
    if (!browser) throw new Error('未找到 Chrome/Edge，请先安装 Chrome 或 Edge');
    fs.mkdirSync(this.profileDir, { recursive: true });

    // 如果之前有 Chrome 用同一 profile 在跑（崩溃残留），尝试复用它
    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    if (fs.existsSync(portFile)) {
      try {
        const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
        const port = Number(lines[0]);
        if (port) {
          const version = await getJson(`http://127.0.0.1:${port}/json/version`, 1500);
          if (version && version.webSocketDebuggerUrl) {
            await this.connect(version.webSocketDebuggerUrl);
            this.log('已复用运行中的 Chrome 实例');
            return;
          }
        }
      } catch (err) {
        /* 旧实例已退出，继续新开 */
      }
    }

    const port = await getFreePort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--start-maximized',
    ];
    if (this.networkMode === 'direct') args.push('--no-proxy-server');
    args.push('about:blank');

    this.log(`启动 Chrome：${browser}`);
    this.proc = spawn(browser, args, { stdio: 'ignore', windowsHide: false });
    this.proc.on('error', (err) => this.log(`Chrome 启动失败：${err.message}`));
    this.proc.on('exit', (code, signal) => this.log(`Chrome 进程退出：code=${code} signal=${signal}`));

    let version = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(500);
      try {
        version = await getJson(`http://127.0.0.1:${port}/json/version`, 1500);
        if (version && version.webSocketDebuggerUrl) break;
      } catch (err) {
        /* retry */
      }
    }
    if (!version || !version.webSocketDebuggerUrl) throw new Error('Chrome 远程调试端口未就绪');
    await this.connect(version.webSocketDebuggerUrl);
  }

  async connect(wsUrl) {
    this.browserUrl = wsUrl;
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 Chrome 超时')), 15000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (err) {
        return;
      }
      this.onMessage(msg);
    });
    this.ws.on('error', (err) => this.log(`CDP 连接错误：${err.message}`));
    this.ws.on('close', (code, reason) => {
      this.log(`CDP 连接关闭：code=${code} reason=${String(reason || '')}`);
      this.started = false;
      this.ws = null;
      for (const tab of this.tabs.values()) tab.destroyed = true;
      this.tabs.clear();
      this.bySession.clear();
    });
    this.started = true;
  }

  send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('Chrome 尚未连接'));
        return;
      }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      const payload = { id, method, params: params || {} };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'Target.detachedFromTarget') {
      const sid = msg.params && msg.params.sessionId;
      const tab = sid && this.bySession.get(sid);
      if (tab) {
        tab.destroyed = true;
        this.bySession.delete(sid);
        if (this.tabs.get(tab.platformId) === tab) this.tabs.delete(tab.platformId);
      }
      return;
    }
    if (msg.method === 'Target.targetDestroyed') {
      const tid = msg.params && msg.params.targetId;
      for (const [pid, tab] of this.tabs) {
        if (tab.targetId === tid) {
          tab.destroyed = true;
          this.bySession.delete(tab.sessionId);
          this.tabs.delete(pid);
          break;
        }
      }
      return;
    }
    if (msg.sessionId) {
      const tab = this.bySession.get(msg.sessionId);
      if (tab) tab.onEvent(msg);
    }
  }

  async createTab(platformId) {
    await this.ensureStarted();
    const existing = this.tabs.get(platformId);
    if (existing && !existing.destroyed) return existing;
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new ChromeTab(this, platformId, targetId, sessionId);
    this.bySession.set(sessionId, tab);
    this.tabs.set(platformId, tab);
    return tab;
  }

  async closeTab(platformId) {
    const tab = this.tabs.get(platformId);
    if (!tab) return;
    this.tabs.delete(platformId);
    this.bySession.delete(tab.sessionId);
    await tab.close();
  }

  async shutdown() {
    // 先同步杀掉 Chrome 进程，保证程序退出后不会残留独立窗口
    if (this.proc) {
      try {
        this.proc.kill();
      } catch (err) {
        /* ignore */
      }
      this.proc = null;
    }
    for (const tab of Array.from(this.tabs.values())) {
      try {
        await tab.close();
      } catch (err) {
        /* ignore */
      }
    }
    this.tabs.clear();
    try {
      if (this.ws) this.ws.close();
    } catch (err) {
      /* ignore */
    }
    this.ws = null;
    this.started = false;
  }
}

module.exports = ChromeChannel;
