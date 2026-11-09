'use strict';

/**
 * 读取 B 站投稿表单当前状态（只读，不修改页面）。
 * 用法：node scripts/cdp-util.js run scripts/bili-read.js
 */

module.exports = async ({ evalJs }) =>
  evalJs(`(function () {
    var val = function (sel) {
      var el = document.querySelector(sel);
      return el ? el.value : null;
    };
    var chips = [];
    var tagBox = document.querySelector("input[placeholder*='创建标签']");
    if (tagBox) {
      var scope = tagBox.closest('div') ? tagBox.closest('div').parentElement : null;
      if (scope) {
        scope.querySelectorAll('*').forEach(function (el) {
          if (el === tagBox || el.contains(tagBox)) return;
          var t = (el.innerText || '').replace(/\\s+/g, '').trim();
          if (!t || t.length > 12) return;
          var r = el.getBoundingClientRect();
          if (r.width < 24 || r.width > 220 || r.height < 16 || r.height > 44) return;
          if (chips.indexOf(t) < 0) chips.push(t);
        });
      }
    }
    var selects = [];
    document.querySelectorAll('input.bcc-select-input-inner').forEach(function (el) {
      selects.push(el.value);
    });
    var coverImg = document.querySelector('[class*=cover] img');
    return {
      url: location.href,
      title: val("input[placeholder='请输入稿件标题']"),
      selects: selects,
      description: (document.querySelector('div.ql-editor') || {}).innerText,
      tags: chips,
      coverSet: !!(coverImg && coverImg.src && coverImg.src.length > 20),
      hasDraftBtn: !!(document.body.innerText || '').match(/存草稿/),
      hasSubmitBtn: !!(document.body.innerText || '').match(/立即投稿/)
    };
  })()`);
