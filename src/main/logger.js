'use strict';

/**
 * 任务日志：内存 + JSONL 文件，便于出问题时回溯。
 */

const fs = require('node:fs');
const path = require('node:path');

class TaskLogger {
  constructor(taskId, logsDir) {
    this.taskId = taskId;
    this.file = path.join(logsDir, `${taskId}.jsonl`);
    fs.mkdirSync(logsDir, { recursive: true });
    this.buffer = [];
  }

  write(level, platformId, message, extra) {
    const line = {
      ts: new Date().toISOString(),
      level,
      platformId: platformId || '',
      message: String(message),
      ...(extra || {}),
    };
    this.buffer.push(line);
    if (this.buffer.length > 5000) this.buffer.shift();
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (err) {
      /* 日志写失败不影响主流程 */
    }
    const prefix = platformId ? `[${platformId}] ` : '';
    const fn = level === 'error' ? console.error : console.log;
    fn(`[${this.taskId}] ${prefix}${message}`);
    return line;
  }

  info(platformId, message) {
    return this.write('info', platformId, message);
  }

  warn(platformId, message) {
    return this.write('warn', platformId, message);
  }

  error(platformId, message) {
    return this.write('error', platformId, message);
  }
}

module.exports = TaskLogger;
