'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const selectors = require('../src/main/selectors');

test('生成的注入脚本是可直接求值的一元表达式', () => {
  const script = selectors.findScript(['input[placeholder*="标题"]', 'text=上传视频'], { visibleOnly: true });
  assert.ok(script.startsWith('('), '脚本应以 ( 开头');
  // 选择器里的双引号必须被正确转义，保证 JSON 合法
  assert.ok(script.includes('input[placeholder*=\\"标题\\"]') || script.includes('input[placeholder*="标题"]'));
  // eslint-disable-next-line no-new-func
  assert.equal(typeof new Function(`return ${script}`), 'function');
});

test('文件输入脚本包含全部候选与 accept 提示', () => {
  const script = selectors.fileInputScript(['input[type=file]'], 'video');
  assert.ok(script.includes('input[type=file]'));
  assert.ok(script.includes('video'));
});

test('各操作脚本语法合法', () => {
  const fns = [
    selectors.hitInfoScript(),
    selectors.focusHitScript(),
    selectors.setInputValueScript('测试 <>&"', true),
    selectors.selectHitContentsScript(),
    selectors.hitTextScript(),
    selectors.clickHitScript(),
    selectors.scrollHitIntoViewScript(),
    selectors.caretToEndScript(),
    selectors.execInsertTextScript('abc'),
    selectors.uploadStateScript(['上传中'], ['.done']),
    selectors.loginStateScript(['.avatar'], '/login'),
  ];
  for (const script of fns) {
    assert.ok(script.startsWith('('));
    // eslint-disable-next-line no-new-func
    assert.equal(typeof new Function(`return ${script}`), 'function');
  }
});

test('含中文与换行的文本能被安全序列化', () => {
  const text = '第一行\n第二行 "引号" \\反斜杠';
  const script = selectors.setInputValueScript(text, true);
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return ${script}`);
  assert.equal(typeof fn, 'function');
  assert.ok(script.includes('第一行'));
});
