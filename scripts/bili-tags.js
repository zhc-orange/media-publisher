'use strict';

/**
 * B 站投稿页：把标签改成指定的集合。
 * 做法：逐个人工点掉不需要的标签（点右侧 × 的坐标），再在输入框里回车创建新标签。
 * 用法：node scripts/cdp-util.js run scripts/bili-tags.js [想要保留/新增的标签...]
 */

const WANTED = ['室内攀岩'];

module.exports = async ({ evalJs, clickAt, typeText, pressKey, sleep }) => {
  const queryChips = async () => {
    const res = await evalJs(`(function(){
      var input = document.querySelector("input[placeholder*='创建标签']");
      if (!input) return { ok: false, reason: 'tag input not found' };
      var scope = input.closest('div') ? input.closest('div').parentElement : input.parentElement;
      var els = scope ? scope.querySelectorAll('*') : [];
      var out = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el === input || el.contains(input)) continue;
        var t = (el.innerText || '').replace(/\\s+/g, '').trim();
        if (!t || t.length < 1 || t.length > 12) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 24 || r.width > 220 || r.height < 16 || r.height > 44) continue;
        out.push({ text: t, x: r.x, y: r.y, w: r.width, h: r.height });
      }
      // 同一个文字只保留最外层（最宽）的框
      var best = {};
      for (var j = 0; j < out.length; j++) {
        var c = out[j];
        if (!best[c.text] || c.w > best[c.text].w) best[c.text] = c;
      }
      return { ok: true, chips: Object.keys(best).map(function (k) { return best[k]; }) };
    })()`);
    return res;
  };

  const steps = [];
  let before = await queryChips();
  if (!before.ok) return { ok: false, reason: before.reason };

  const keep = new Set(WANTED);
  // 从最右边开始点，避免坐标漂移
  const toRemove = before.chips.filter((c) => !keep.has(c.text)).sort((a, b) => b.x - a.x);
  for (const chip of toRemove) {
    const fresh = await queryChips();
    const hit = (fresh.chips || []).find((c) => c.text === chip.text);
    if (!hit) continue;
    await clickAt(hit.x + hit.w - 9, hit.y + hit.h / 2);
    await sleep(450);
    steps.push(`移除了标签「${chip.text}」`);
  }

  // 新增缺失的标签
  const afterRemove = await queryChips();
  const existing = new Set((afterRemove.chips || []).map((c) => c.text));
  for (const tag of WANTED) {
    if (existing.has(tag)) continue;
    const mark = await evalJs(`window.__uMark("input[placeholder*='创建标签']")`);
    if (!mark || !mark.ok) return { ok: false, reason: 'tag input not clickable', steps };
    await clickAt(mark.rect.x + Math.min(mark.rect.w / 2, 40), mark.rect.y + mark.rect.h / 2);
    await sleep(200);
    await typeText(tag);
    await sleep(350);
    await pressKey('Enter');
    await sleep(700);
    steps.push(`新增了标签「${tag}」`);
  }

  const final = await queryChips();
  return {
    ok: true,
    steps,
    tags: (final.chips || []).map((c) => c.text),
  };
};
