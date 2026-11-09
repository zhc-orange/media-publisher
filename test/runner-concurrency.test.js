'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Runner = require('../src/main/runner');

function makeRunner(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-runner-'));
  const tabs = {
    ensure: () => ({ view: {} }),
    show: () => {},
    hide: () => {},
    setStatus: () => {},
  };
  const runner = new Runner({
    tabs,
    dirs: { base: dir, logs: path.join(dir, 'logs') },
    getSettings: () => settings,
  });
  runner.appendHistory = () => {};
  return { runner, dir };
}

test('runTask 按并发数调度平台', async () => {
  const { runner, dir } = makeRunner({ concurrency: 2 });
  let active = 0;
  let maxActive = 0;
  runner.runOne = async (task, platform) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return { status: 'filled', message: 'ok' };
  };
  const res = await runner.runTask({ id: 't1', platforms: ['douyin', 'kuaishou', 'bilibili'], videoPath: 'x', title: 't' });
  assert.equal(maxActive, 2);
  assert.deepEqual(Object.keys(res.results).sort(), ['bilibili', 'douyin', 'kuaishou']);
  assert.equal(res.state, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrency=0 表示全部并行', async () => {
  const { runner, dir } = makeRunner({ concurrency: 0 });
  let active = 0;
  let maxActive = 0;
  runner.runOne = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { status: 'filled' };
  };
  await runner.runTask({ id: 't2', platforms: ['douyin', 'kuaishou', 'bilibili'], videoPath: 'x', title: 't' });
  assert.equal(maxActive, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('取消后不再启动新平台', async () => {
  const { runner, dir } = makeRunner({ concurrency: 1 });
  const started = [];
  runner.runOne = async (task, platform) => {
    started.push(platform.id);
    runner.cancel();
    return { status: 'filled' };
  };
  const res = await runner.runTask({ id: 't3', platforms: ['douyin', 'kuaishou'], videoPath: 'x', title: 't' });
  assert.deepEqual(started, ['douyin']);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.results.kuaishou.status, 'skipped');
  fs.rmSync(dir, { recursive: true, force: true });
});
