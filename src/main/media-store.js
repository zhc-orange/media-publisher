'use strict';

/**
 * 当前选中的本地媒体文件（视频/封面），供自定义协议 app-media:// 读取。
 * 只允许读取这里登记过的路径，渲染层无法借此访问任意文件。
 */

const state = {
  video: '',
  cover: '',
};

function set(kind, filePath) {
  if (kind !== 'video' && kind !== 'cover') throw new Error(`未知媒体类型：${kind}`);
  state[kind] = filePath || '';
  return { ...state };
}

function get(kind) {
  return state[kind] || '';
}

module.exports = { set, get, state };
