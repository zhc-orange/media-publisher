'use strict';

/**
 * 运行期目录：全部落在 %APPDATA%/自媒体发布助手/ 下。
 * 包含：诊断报告、日志、历史、设置，以及各平台登录态（Electron 自动管理）。
 * 说明：程序不保存任何截图。
 */

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

function ensureDirs(base) {
  const dirs = {
    base,
    diagnostics: path.join(base, 'diagnostics'),
    logs: path.join(base, 'logs'),
    tasksFile: path.join(base, 'tasks.json'),
    settingsFile: path.join(base, 'settings.json'),
  };
  for (const key of ['diagnostics', 'logs']) {
    fs.mkdirSync(dirs[key], { recursive: true });
  }
  return dirs;
}

let cached = null;

function getDirs() {
  if (cached) return cached;
  const base = app.getPath('userData');
  cached = ensureDirs(base);
  return cached;
}

module.exports = { getDirs, ensureDirs };
