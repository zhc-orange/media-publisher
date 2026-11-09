'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Runner = require('../src/main/runner');

function setup(ensureImpl, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-runner-resilience-'));
  const video = path.join(dir, 'v.mp4');
  fs.writeFileSync(video, Buffer.alloc(4096));
  const tabs = {
    ensure: ensureImpl,
    show: () => {},
    hide: () => {},
    setStatus: () => {},
  };
  const runner = new Runner({
    tabs,
    dirs: {
      base: dir,
      logs: path.join(dir, 'logs'),
      diagnostics: path.join(dir, 'diagnostics'),
      tasksFile: path.join(dir, 'tasks.json'),
    },
    getSettings: () => settings,
  });
  return { runner, dir, video };
}

test('建标签页失败后 running 必须复位，任务记为失败', async () => {
  const { runner, dir, video } = setup(async () => {
    throw new Error('未找到 Chrome/Edge');
  }, { concurrency: 2 });

  const res = await runner.runTask({ platforms: ['youtube'], videoPath: video, title: 't' });
  assert.equal(runner.isRunning, false);
  assert.equal(res.state, 'done');
  assert.equal(res.results.youtube.status, 'failed');
  assert.match(res.results.youtube.message, /无法创建标签页/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('worker 内建页抛错不会中断整个任务', async () => {
  let calls = 0;
  const { runner, dir, video } = setup(async () => {
    calls += 1;
    if (calls > 1) throw new Error('Chrome 启动超时');
    return { view: {} };
  }, { concurrency: 1 });

  const res = await runner.runTask({ platforms: ['douyin'], videoPath: video, title: 't' });
  assert.equal(runner.isRunning, false);
  assert.equal(res.results.douyin.status, 'failed');
  assert.equal(res.state, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('视频预检失败不进入页面流程', async () => {
  let ensured = 0;
  const { runner, dir } = setup(async () => {
    ensured += 1;
    return { view: {} };
  }, { concurrency: 1 });

  const res = await runner.runTask({ platforms: ['douyin'], videoPath: path.join(dir, 'missing.mp4'), title: 't' });
  assert.equal(res.results.douyin.status, 'failed');
  assert.equal(res.results.douyin.step, 'preflight');
  assert.equal(ensured, 1); // 只建了标签页，没有进入上传
  fs.rmSync(dir, { recursive: true, force: true });
});
