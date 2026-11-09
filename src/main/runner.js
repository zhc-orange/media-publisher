'use strict';

/**
 * 任务执行器：按顺序逐平台执行，互不阻塞；单个平台失败不影响其他平台。
 */

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { getPlatform } = require('./config');
const { runPlatform, StepError } = require('./engine');
const { prepareForPlatform, checkVideo } = require('./limits');
const diagnostics = require('./diagnostics');
const TaskLogger = require('./logger');

class Runner extends EventEmitter {
  constructor({ tabs, dirs, getSettings }) {
    super();
    this.tabs = tabs;
    this.dirs = dirs;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.running = false;
    this.cancelled = false;
    this.currentTask = null;
    this.currentLogger = null;
    this.retryQueue = [];
    this.draining = false;
  }

  get isRunning() {
    return this.running;
  }

  emitStatus(platformId, status, message) {
    if (status) this.tabs.setStatus(platformId, status, message);
    if (this.currentLogger && status) {
      this.currentLogger.info(platformId, `状态：${status}${message ? ` · ${message}` : ''}`);
    }
    this.emit('event', { type: 'status', platformId, status, message });
  }

  cancel() {
    if (!this.running) return false;
    this.cancelled = true;
    this.retryQueue.length = 0;
    this.emit('event', { type: 'log', platformId: '', message: '收到取消请求，将在当前步骤结束后停止' });
    return true;
  }

  async runTask(task) {
    if (this.running) throw new Error('已有任务正在执行，请等待完成或先取消');
    const settings = this.getSettings();
    const taskId = task.id || `t${Date.now()}`;
    const uniqueIds = [...new Set((task.platforms || []).filter(Boolean))];
    const platforms = uniqueIds.map((id) => getPlatform(id));
    if (!platforms.length) throw new Error('请至少选择一个平台');

    const rawConcurrency = Number(settings.concurrency);
    const concurrency = rawConcurrency === 0
      ? platforms.length
      : Math.max(1, Math.min(platforms.length, Number.isFinite(rawConcurrency) && rawConcurrency > 0 ? rawConcurrency : 2));

    this.running = true;
    this.cancelled = false;
    this.currentTask = { ...task, id: taskId, platforms: uniqueIds };
    const logger = new TaskLogger(taskId, this.dirs.logs);
    this.currentLogger = logger;
    const results = {};
    let state = 'done';

    try {
      // 先把所有选中平台的标签页建出来；单个平台建页失败只记该平台失败，不能卡死整个任务
      for (const platform of platforms) {
        try {
          await this.tabs.ensure(platform);
        } catch (err) {
          const message = `无法创建标签页：${err.message}`;
          results[platform.id] = { status: 'failed', step: 'open', message };
          this.emitStatus(platform.id, 'failed', message);
          logger.error(platform.id, message);
          this.emit('event', {
            type: 'platform-result',
            taskId,
            platformId: platform.id,
            result: results[platform.id],
          });
        }
      }
      // 并发模式不自动切到某个平台，让用户留在表单看总进度；串行模式仍逐个展示
      if (concurrency > 1) this.tabs.hide();
      else if (settings.openTabsWhileRunning !== false && platforms[0] && !results[platforms[0].id]) {
        try {
          await this.tabs.show(platforms[0].id);
        } catch (err) {
          /* 展示失败不影响任务 */
        }
      }

      this.emit('event', { type: 'task', state: 'running', taskId, platforms: uniqueIds });
      logger.info('', `任务开始，共 ${platforms.length} 个平台，同时处理 ${concurrency} 个`);

      const queue = platforms.filter((p) => !results[p.id]);
      const worker = async () => {
        while (queue.length) {
          const platform = queue.shift();
          if (!platform) break;
          if (this.cancelled) {
            results[platform.id] = { status: 'skipped', message: '任务已取消' };
            this.emitStatus(platform.id, 'idle', '任务已取消');
            continue;
          }
          this.emit('event', { type: 'task', state: 'platform-start', taskId, platformId: platform.id });
          try {
            results[platform.id] = await this.runOne(this.currentTask, platform, taskId, logger, { ...settings, concurrency });
          } catch (err) {
            const message = err && err.message ? err.message : String(err);
            results[platform.id] = { status: 'failed', step: 'unknown', message };
            this.emitStatus(platform.id, 'failed', message);
            logger.error(platform.id, `未捕获异常：${message}`);
          }
          this.emit('event', {
            type: 'platform-result',
            taskId,
            platformId: platform.id,
            result: results[platform.id],
          });
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      state = this.cancelled ? 'cancelled' : 'done';
    } catch (err) {
      state = 'failed';
      const message = err && err.message ? err.message : String(err);
      logger.error('', `任务异常结束：${message}`);
      this.emit('event', { type: 'fatal', message });
    } finally {
      // 任何路径都要补齐结果并复位 running，避免"只能重启程序"
      for (const platform of platforms) {
        if (!results[platform.id]) {
          results[platform.id] = state === 'cancelled'
            ? { status: 'skipped', message: '任务已取消' }
            : { status: 'failed', step: 'unknown', message: '任务未执行' };
        }
      }
      try {
        logger.info('', `任务结束：${state}`);
        this.appendHistory(this.currentTask, results, state);
        this.emit('event', { type: 'task', state, taskId, results });
      } catch (err) {
        /* 收尾失败不能影响 running 复位 */
      }
      this.running = false;
      this.cancelled = false;
      this.currentTask = null;
      this.currentLogger = null;
      this.scheduleDrain();
    }
    return { taskId, state, results };
  }

  /** 任务进行中点击「重试」时先入队，当前任务结束后逐个执行 */
  enqueueRetry(task, platformId) {
    this.retryQueue.push({ task: { ...task }, platformId });
    this.emit('event', {
      type: 'log',
      platformId,
      message: '已加入重试队列，当前任务结束后自动执行',
    });
    return { queued: true, pending: this.retryQueue.length };
  }

  scheduleDrain() {
    if (this.draining || !this.retryQueue.length) return;
    this.draining = true;
    setTimeout(() => {
      this.drainQueue()
        .catch(() => {})
        .finally(() => {
          this.draining = false;
        });
    }, 300);
  }

  async drainQueue() {
    while (this.retryQueue.length && !this.running) {
      const item = this.retryQueue.shift();
      try {
        await this.runTask({ ...item.task, id: `t${Date.now()}`, platforms: [item.platformId] });
      } catch (err) {
        this.emit('event', { type: 'log', platformId: item.platformId, message: `重试未执行：${err.message}` });
      }
    }
  }

  async runOne(task, platform, taskId, logger, settings) {
    // 开跑前先校验视频文件，避免登录/跳转几分钟后才发现文件被移动或超限
    const videoCheck = checkVideo(task.videoPath, platform);
    if (!videoCheck.ok) {
      const message = videoCheck.errors.join('；');
      this.emitStatus(platform.id, 'failed', message);
      logger.error(platform.id, `视频预检未通过：${message}`);
      return { status: 'failed', step: 'preflight', message };
    }

    const prepared = prepareForPlatform(task, platform, { autoTruncate: settings.autoTruncate !== false });
    if (prepared.errors.length) {
      const message = prepared.errors.join('；');
      this.emitStatus(platform.id, 'failed', message);
      logger.error(platform.id, `预检未通过：${message}`);
      return { status: 'failed', step: 'preflight', message };
    }
    if (prepared.warnings.length) logger.warn(platform.id, prepared.warnings.join('；'));

    let entry = null;
    const startedAt = Date.now();
    try {
      entry = await this.tabs.ensure(platform);
      if (settings.concurrency === 1 && settings.openTabsWhileRunning !== false) await this.tabs.show(platform.id);
      this.emitStatus(platform.id, 'opening', '正在打开创作中心…');

      const res = await runPlatform({
        view: entry.view,
        platform,
        task,
        prepared,
        onLog: (pid, message) => {
          logger.info(pid, message);
          this.emit('event', { type: 'log', taskId, platformId: pid, message });
        },
        onStatus: (pid, status, message) => this.emitStatus(pid, status, message),
        isCancelled: () => this.cancelled,
      });
      logger.info(platform.id, `完成，用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
      return {
        status: 'filled',
        message: '信息已填好，请确认后手动发布',
        warnings: res.warnings,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const step = err instanceof StepError ? err.step : 'unknown';
      if (step === 'cancel') {
        this.emitStatus(platform.id, 'idle', '已取消');
        return { status: 'skipped', step, message: '任务已取消' };
      }
      const message = err.message || String(err);
      logger.error(platform.id, `失败（${step}）：${message}`);
      this.emitStatus(platform.id, 'failed', message);
      let diagnosticFile = '';
      if (entry) {
        try {
          const data = await diagnostics.collect(entry.view, {
            platformId: platform.id,
            platformName: platform.name,
            step,
            error: message,
          });
          diagnosticFile = diagnostics.save(this.dirs.diagnostics, `${taskId}-${platform.id}-${Date.now()}`, data);
          logger.info(platform.id, `诊断文件：${diagnosticFile}`);
        } catch (diagErr) {
          logger.warn(platform.id, `诊断生成失败：${diagErr.message}`);
        }
      }
      return { status: 'failed', step, message, diagnosticFile, elapsedMs: Date.now() - startedAt };
    }
  }

  appendHistory(task, results, state) {
    try {
      let list = [];
      try {
        const raw = JSON.parse(fs.readFileSync(this.dirs.tasksFile, 'utf8'));
        if (Array.isArray(raw)) list = raw;
      } catch (err) {
        list = [];
      }
      list.unshift({
        id: task.id,
        time: new Date().toISOString(),
        videoPath: task.videoPath || '',
        title: task.title || '',
        description: String(task.description || '').slice(0, 200),
        tags: task.tags || [],
        platforms: task.platforms || [],
        results,
        state,
      });
      fs.mkdirSync(this.dirs.base, { recursive: true });
      const tmp = `${this.dirs.tasksFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list.slice(0, 200), null, 2), 'utf8');
      fs.renameSync(tmp, this.dirs.tasksFile);
    } catch (err) {
      /* 历史记录失败不影响发布流程 */
    }
  }
}

module.exports = Runner;
