'use strict';

const fs = require('node:fs');

const DEFAULT_SETTINGS = {
  autoTruncate: true,
  lastVideoDir: '',
  lastCoverDir: '',
  openTabsWhileRunning: true,
  concurrency: 2,
  theme: 'system',
  language: 'system',
  networkMode: 'system',
  restoreDraft: true,
};

function loadSettings(dirs) {
  try {
    const raw = JSON.parse(fs.readFileSync(dirs.settingsFile, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch (err) {
    // 文件损坏时备份一份，避免静默覆盖后用户设置永久丢失
    try {
      if (err && err.code !== 'ENOENT' && fs.existsSync(dirs.settingsFile)) {
        fs.renameSync(dirs.settingsFile, `${dirs.settingsFile}.bad-${Date.now()}`);
      }
    } catch (backupErr) {
      /* ignore */
    }
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(dirs, settings) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  fs.mkdirSync(dirs.base, { recursive: true });
  const tmp = `${dirs.settingsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, dirs.settingsFile);
  return merged;
}

module.exports = { DEFAULT_SETTINGS, loadSettings, saveSettings };
