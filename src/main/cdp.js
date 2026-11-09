'use strict';

/**
 * 基于 Chrome DevTools Protocol 的底层操作。
 * 主要用途：给 <input type=file> 直接塞本地文件（绕开系统文件选择框）、
 * 派发可信鼠标事件与键盘输入。
 */

class Cdp {
  constructor(webContents) {
    if (!webContents) throw new Error('Cdp 需要 webContents');
    this.wc = webContents;
    this._attached = false;
  }

  ensureAttached() {
    if (this.wc.isDestroyed()) throw new Error('页面已关闭');
    const dbg = this.wc.debugger;
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      this._attached = true;
    }
    if (!this._listening) {
      this._listening = true;
      this._chooserWaiters = [];
      dbg.on('message', (_event, method, params) => {
        if (method !== 'Page.fileChooserOpened') return;
        const backendNodeId = params && params.backendNodeId;
        const waiters = this._chooserWaiters.splice(0);
        for (const waiter of waiters) waiter(backendNodeId || 0);
      });
    }
    return dbg;
  }

  /** 等待平台弹出文件选择框，返回被点击的 input 的 backendNodeId（拿不到返回 0） */
  waitFileChooser(timeoutMs = 8000) {
    this.ensureAttached();
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(0);
      }, timeoutMs);
      this._chooserWaiters.push((backendNodeId) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(backendNodeId);
      });
    });
  }

  /** 通过 backendNodeId 给文件输入框塞文件（不依赖选择器，最适合动态弹窗） */
  async setFileInputFilesByBackend(backendNodeId, files) {
    await this.send('DOM.enable');
    await this.send('DOM.setFileInputFiles', { backendNodeId, files });
    return backendNodeId;
  }

  async send(method, params = {}) {
    const dbg = this.ensureAttached();
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CDP 调用超时：${method}`)), 30000);
    });
    try {
      return await Promise.race([dbg.sendCommand(method, params), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async detach() {
    try {
      if (!this.wc.isDestroyed() && this.wc.debugger.isAttached()) this.wc.debugger.detach();
    } catch (err) {
      /* 页面可能已经销毁，忽略 */
    }
    this._attached = false;
  }

  /**
   * 拦截页面弹出的系统文件选择框。
   * 平台页面上的「上传」按钮通常会触发原生选择框，会卡住自动化流程；
   * 打开拦截后，文件统一由 DOM.setFileInputFiles 注入。
   */
  async enableFileChooserIntercept() {
    if (this._fileChooserIntercepted) return;
    try {
      await this.send('Page.enable');
      await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
      this._fileChooserIntercepted = true;
    } catch (err) {
      /* 老版本协议不支持时忽略，仍继续用 DOM 注入 */
    }
  }

  /**
   * 给页面上匹配 selector 的文件输入框设置本地文件。
   * 支持 Shadow DOM：先在完整 DOM 树（含 shadowRoots）里找标记过的 input，
   * 找不到再回退到普通 querySelector。
   * @param {string} selector CSS 选择器
   * @param {string[]} files 绝对路径数组
   */
  async setFileInputFiles(selector, files) {
    await this.send('DOM.enable');

    // 1) 普通 DOM（含 iframe 之外的 light DOM）
    try {
      const { root } = await this.send('DOM.getDocument', { depth: 0, pierce: true });
      if (root && root.nodeId) {
        const found = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (found && found.nodeId) {
          await this.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files });
          return found.nodeId;
        }
      }
    } catch (err) {
      /* 继续深度查找 */
    }

    // 2) 深度遍历：穿透 shadowRoots，只接受标记过的文件输入，避免把视频塞进头像/封面框
    const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
    let marked = 0;
    const walk = (node) => {
      if (!node) return;
      const attrs = node.attributes || [];
      const map = {};
      for (let i = 0; i < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1];
      if (node.nodeName === 'INPUT' && String(map.type || '').toLowerCase() === 'file' && map['data-dsh-file'] === '1') {
        if (!marked) marked = node.nodeId;
      }
      const children = node.children || [];
      for (let i = 0; i < children.length; i += 1) walk(children[i]);
      const shadows = node.shadowRoots || [];
      for (let i = 0; i < shadows.length; i += 1) walk(shadows[i]);
    };
    walk(root);
    if (!marked) throw new Error(`页面上找不到标记过的文件输入框：${selector}（可能还未渲染）`);
    await this.send('DOM.setFileInputFiles', { nodeId: marked, files });
    return marked;
  }

  /** 在视口坐标处派发一次可信点击 */
  async clickAt(x, y) {
    const px = Math.round(x);
    const py = Math.round(y);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', clickCount: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
  }

  /** 向当前焦点元素插入文本（走 DevTools 输入通道，不依赖系统输入法） */
  async insertText(text) {
    await this.send('Input.insertText', { text: String(text) });
  }

  async pressEnter() {    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }

  async pressBackspace(times = 1) {
    for (let i = 0; i < times; i += 1) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
    }
  }

  async pressEscape() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
}

module.exports = Cdp;
