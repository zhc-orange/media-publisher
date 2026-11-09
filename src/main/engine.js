'use strict';

/**
 * 平台执行引擎：把「打开创作中心 → 检查登录 → 上传视频 → 填写标题/简介/话题/封面」
 * 这一串动作按平台配置跑完，结束后停在发布前，由用户手动点发布。
 */

const Cdp = require('./cdp');
const selectors = require('./selectors');
const { prepareForPlatform, inlineTags } = require('./limits');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SCRIPT_TIMEOUT_MS = 15000;

class StepError extends Error {
  constructor(step, message, detail = {}) {
    super(message);
    this.name = 'StepError';
    this.step = step;
    this.detail = detail;
  }
}

const normalize = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

async function evalScript(ctx, script) {
  if (!ctx.view || ctx.view.webContents.isDestroyed()) throw new StepError('page', '页面已被关闭');
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StepError('page', '页面脚本执行超时（页面可能卡死），请点「重试」')), SCRIPT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([ctx.view.webContents.executeJavaScript(script, true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function findTarget(ctx, candidates, opts = {}) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
  if (!list.length) throw new StepError('find', '该步骤没有配置选择器');
  return evalScript(ctx, selectors.findScript(list, opts));
}

async function waitForTarget(ctx, candidates, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = { found: false };
  while (Date.now() < deadline) {
    if (ctx.isCancelled()) throw new StepError('cancel', '任务已取消');
    try {
      last = await findTarget(ctx, candidates);
    } catch (err) {
      // 导航/重渲染瞬间求值会失败，继续等下一轮
      last = { found: false };
    }
    if (last.found) return last;
    await sleep(600);
  }
  throw new StepError(label, `等待「${label}」超时（${Math.round(timeoutMs / 1000)} 秒）`, { candidates });
}

async function clickMarked(ctx) {
  const scrolled = await evalScript(ctx, selectors.scrollHitIntoViewScript());
  const rect = scrolled && scrolled.ok ? scrolled.rect : null;
  if (rect && rect.width >= 2 && rect.height >= 2) {
    await ctx.cdp.clickAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
  } else {
    const res = await evalScript(ctx, selectors.clickHitScript());
    if (!res.ok) throw new StepError('click', '无法点击目标元素');
  }
  await sleep(350);
}

async function clickTarget(ctx, candidates, label, timeoutMs = 20000) {
  const hit = await waitForTarget(ctx, candidates, timeoutMs, label);
  ctx.log(`点击「${label}」：${hit.candidate}`);
  await clickMarked(ctx);
  return hit;
}

/**
 * 依次点击多级入口。steps 可以是候选选择器数组，
 * 也可以是二维数组（例如 YouTube 的「创建」→「上传视频」）。
 * 某一级找不到时记录日志并继续，不阻塞后续步骤。
 */
async function clickSequence(ctx, steps, label) {
  const groups = Array.isArray(steps) && Array.isArray(steps[0]) ? steps : [steps];
  for (let i = 0; i < groups.length; i += 1) {
    const group = (Array.isArray(groups[i]) ? groups[i] : [groups[i]]).filter(Boolean);
    if (!group.length) continue;
    const hit = await findTarget(ctx, group).catch(() => ({ found: false }));
    if (!hit.found) {
      ctx.log(`未找到「${label}」入口（第 ${i + 1} 步），继续尝试后续步骤`);
      continue;
    }
    ctx.log(`点击「${label}」：${hit.candidate}`);
    await clickMarked(ctx);
    await sleep(900);
  }
}

async function typeText(ctx, text) {
  await ctx.cdp.insertText(text);
}

async function fillField(ctx, candidates, value, label, clearFirst) {
  if (!value) return { skipped: true };
  const hit = await waitForTarget(ctx, candidates, 30000, label);
  ctx.log(`定位「${label}」：${hit.candidate}（${hit.tag}）`);
  const info = await evalScript(ctx, selectors.hitInfoScript());
  if (!info.found) throw new StepError(label, `「${label}」元素已失效`);

  let ok = false;
  if (!info.editable && (hit.tag === 'input' || hit.tag === 'textarea')) {
    const set = await evalScript(ctx, selectors.setInputValueScript(value, clearFirst !== false));
    if (set.ok && normalize(set.value) === normalize(value)) ok = true;
    else ctx.log(`直接赋值未生效（${set.reason || '值不一致'}），改用键盘输入`);
  }
  if (!ok) {
    await evalScript(ctx, selectors.focusHitScript());
    await evalScript(ctx, selectors.selectHitContentsScript());
    await typeText(ctx, value);
  }

  const after = await evalScript(ctx, selectors.hitInfoScript());
  const got = after.editable ? after.text : after.value;
  if (!normalize(got)) {
    // 最后兜底：execCommand
    await evalScript(ctx, selectors.execInsertTextScript(value));
    const retry = await evalScript(ctx, selectors.hitInfoScript());
    const retryText = retry.editable ? retry.text : retry.value;
    if (!normalize(retryText)) throw new StepError(label, `「${label}」填写失败，页面未接收文本`);
  } else if (normalize(got).indexOf(normalize(value).slice(0, 10)) < 0) {
    ctx.log(`警告：「${label}」回读内容与预期不一致（可能被平台截断/过滤）`);
  }
  ctx.log(`已填写「${label}」：${normalize(value).slice(0, 40)}${value.length > 40 ? '…' : ''}`);
  await sleep(300);
  return { ok: true };
}

async function navigate(ctx, url) {
  ctx.log(`打开：${url}`);
  const wc = ctx.view.webContents;
  try {
    await Promise.race([wc.loadURL(url), sleep(60000)]);
  } catch (err) {
    // 站点内部重定向时 loadURL 可能抛 ERR_ABORTED，页面其实已经在加载
    ctx.log(`页面加载提示：${err.message}`);
  }
  const deadline = Date.now() + 60000;
  let settled = 0;
  while (Date.now() < deadline) {
    if (ctx.isCancelled()) throw new StepError('cancel', '任务已取消');
    try {
      const st = await evalScript(ctx, '({ ready: document.readyState, len: (document.body ? document.body.innerText.length : 0), url: location.href })');
      // 连续两次 complete 即认为页面已稳定：SPA 会在 complete 之后继续渲染，
      // 后续的登录/上传等待会各自轮询元素，不需要在这里用正文长度猜。
      settled = st.ready === 'complete' ? settled + 1 : 0;
      if (settled >= 2) break;
    } catch (err) {
      /* 页面切换中，继续等 */
    }
    await sleep(400);
  }
  await sleep(1200);
}

async function ensureLogin(ctx) {
  const cfg = ctx.platform.loginCheck;
  if (!cfg.selectors.length && !cfg.rejectTexts.length) {
    ctx.log('该平台未配置登录检测，跳过');
    return;
  }
  const check = () => evalScript(ctx, selectors.loginStateScript(cfg.selectors, cfg.urlExcludes, cfg.rejectTexts));
  // 页面可能有重定向瞬间：必须连续两次判定为已登录才算数
  const evaluate = (st) => selectors.judgeLogin(st, cfg);
  let streak = 0;
  let lastState = null;
  for (let i = 0; i < 14; i += 1) {
    if (ctx.isCancelled()) throw new StepError('cancel', '任务已取消');
    lastState = await check();
    streak = evaluate(lastState) ? streak + 1 : 0;
    if (streak >= 2) {
      ctx.log(lastState.loggedIn ? '登录状态正常' : '检测到上传输入框，判定已登录');
      return;
    }
    await sleep(1200);
  }
  const loginHint = lastState && lastState.rejectHits.length
    ? `页面提示需要登录（${lastState.rejectHits[0]}）`
    : '未检测到登录状态，请在当前页面扫码或账号登录';
  ctx.setStatus('need_login', loginHint);
  const deadline = Date.now() + cfg.timeoutMs;
  streak = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (ctx.isCancelled()) throw new StepError('cancel', '任务已取消');
    const st = await check();
    streak = evaluate(st) ? streak + 1 : 0;
    if (streak >= 2) {
      ctx.log('已检测到登录，继续执行');
      ctx.setStatus('uploading', '登录成功，准备上传视频…');
      return;
    }
  }
  throw new StepError('login', '等待登录超时，请登录后点「重试」该平台');
}

async function waitFileInput(ctx, candidates, acceptHint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let marked = { found: false };
  while (Date.now() < deadline) {
    if (ctx.isCancelled()) throw new StepError('cancel', '任务已取消');
    marked = await evalScript(ctx, selectors.fileInputScript(candidates, acceptHint));
    if (marked.found) return marked;
    await sleep(400);
  }
  return marked;
}

async function waitPageTexts(ctx, texts, timeoutMs) {  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ctx.isCancelled()) throw new StepError('cancel', '任务已取消');
    try {
      const st = await evalScript(ctx, selectors.textScript(texts));
      if (st && st.hits && st.hits.length) return st.hits;
    } catch (err) {
      /* 页面切换中 */
    }
    await sleep(500);
  }
  return [];
}

async function waitUploadAccepted(ctx, timeoutMs, before) {
  const cfg = ctx.platform.upload;
  const beforeUrl = (before && before.url) || '';
  const beforePending = ((before && before.pending) || []).join('|');
  const beforeEditor = !!(before && before.editorReady);
  const beforeProgress = (before && before.progress) || '';
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    if (ctx.isCancelled()) throw new StepError('cancel', '任务已取消');
    try {
      last = await evalScript(
        ctx,
        selectors.uploadStateScript(cfg.pendingTexts, cfg.doneSelectors, ctx.platform.title.selectors)
      );
    } catch (err) {
      await sleep(800);
      continue;
    }
    const pendingKey = (last.pending || []).join('|');
    let reason = '';
    // 注意：hasFile 只代表 input.files 被写入，并不代表页面已接收，不能单独作为"开始上传"依据
    if (last.progress && last.progress !== beforeProgress) reason = `进度 ${last.progress}%`;
    else if (pendingKey && pendingKey !== beforePending) reason = `上传提示 ${pendingKey}`;
    else if (last.editorReady && !beforeEditor) reason = '编辑区出现';
    else if (last.url && beforeUrl && last.url !== beforeUrl) reason = '页面跳转';
    else if (last.done) reason = `完成标志 ${last.done}`;
    else if (last.videoReady) reason = '视频预览生成';
    if (reason) return { ok: true, state: last, reason };
    await sleep(800);
  }
  return { ok: false, state: last };
}

async function uploadVideo(ctx) {
  const cfg = ctx.platform.video;
  // 先拦截系统文件选择框，避免点击平台「上传」按钮时弹出原生对话框卡住流程
  await ctx.cdp.enableFileChooserIntercept();

  if (cfg.readyTexts && cfg.readyTexts.length) {
    const ready = await waitPageTexts(ctx, cfg.readyTexts, 20000);
    if (ready.length) ctx.log(`上传页已就绪：${ready.join('、')}`);
    else ctx.log('未检测到上传页就绪提示，继续尝试注入');
  }

  let marked = await waitFileInput(ctx, cfg.input, cfg.accept, cfg.initialWaitMs || 2500);
  if (!marked.found && cfg.openButton.length) {
    ctx.log('页面上暂时没有上传输入框，尝试点击上传入口');
    await clickSequence(ctx, cfg.openButton, '上传入口');
    marked = await waitFileInput(ctx, cfg.input, cfg.accept, 30000);
  }
  if (!marked.found) {
    throw new StepError('upload', '页面上找不到视频上传输入框，请点「扫描页面」查看诊断', { fileInputCount: 0 });
  }

  // 记录注入前的页面状态，用来判断注入后页面是否真的开始上传
  const probeState = () =>
    evalScript(
      ctx,
      selectors.uploadStateScript(ctx.platform.upload.pendingTexts, ctx.platform.upload.doneSelectors, ctx.platform.title.selectors)
    ).catch(() => ({}));
  let before = await probeState();
  ctx.log(
    `注入前：url=${before.url || '未知'} · 提示=${(before.pending || []).join('|') || '无'} · 编辑区=${
      before.editorReady ? '有' : '无'
    } · 进度=${before.progress || '无'}`
  );

  ctx.log(`找到文件输入框（共 ${marked.count} 个），正在注入视频文件`);
  await ctx.cdp.setFileInputFiles('input[data-dsh-file="1"]', [ctx.videoPath]);

  let accepted = await waitUploadAccepted(ctx, 12000, before);
  if (!accepted.ok) {
    ctx.log('注入后页面没有开始上传，先尝试手动触发一次 change');
    await evalScript(ctx, selectors.triggerFileChangeScript()).catch(() => null);
    accepted = await waitUploadAccepted(ctx, 10000, before);
  }
  if (!accepted.ok) {
    ctx.log('仍无响应，清空输入框后重新注入');
    const again = await evalScript(ctx, selectors.fileInputScript(cfg.input, cfg.accept));
    if (again.found) {
      await evalScript(ctx, selectors.clearFileInputScript()).catch(() => null);
      await sleep(250);
      before = await probeState();
      await ctx.cdp.setFileInputFiles('input[data-dsh-file="1"]', [ctx.videoPath]);
      ctx.log('已重新注入文件，等待页面响应');
      accepted = await waitUploadAccepted(ctx, 15000, before);
    } else {
      ctx.log('重试时找不到上传输入框');
    }
  }
  if (!accepted.ok) {
    const last = accepted.state || {};
    ctx.log(
      `页面仍无反应（提示=${(last.pending || []).join('|') || '无'}，进度=${last.progress || '无'}，编辑区=${
        last.editorReady ? '有' : '无'
      }，url=${last.url || '未知'}）`
    );
    throw new StepError('upload', '注入视频后页面没有开始上传（可能页面尚未就绪），请点「重试」该平台');
  }

  const st = accepted.state || {};
  ctx.log(`已确认开始上传：${accepted.reason || '页面有反应'}`);
  if (st.hasFile) ctx.log(`页面已接收文件：${st.fileNames.join(', ')}`);
  if (st.url) ctx.log(`当前页面：${st.url}`);
}

async function waitUploadComplete(ctx) {
  const cfg = ctx.platform.upload;
  const started = Date.now();
  const deadline = started + cfg.timeoutMs;
  const stallMs = cfg.stallTimeoutMs || 180000;
  let calm = 0;
  let warnedCalm = false;
  let lastLog = 0;
  let lastProgress = '';
  let lastChange = started;
  let lastUrl = '';

  while (Date.now() < deadline) {
    if (ctx.isCancelled()) throw new StepError('cancel', '任务已取消');
    let st;
    try {
      st = await evalScript(
        ctx,
        selectors.uploadStateScript(cfg.pendingTexts, cfg.doneSelectors, ctx.platform.title.selectors)
      );
    } catch (err) {
      await sleep(1000);
      continue;
    }
    const elapsed = Date.now() - started;

    if (st.url && st.url !== lastUrl) {
      if (lastUrl) ctx.log(`页面已切换：${st.url}`);
      lastUrl = st.url;
      lastChange = Date.now();
    }
    if (st.progress && st.progress !== lastProgress) {
      lastProgress = st.progress;
      lastChange = Date.now();
      ctx.log(`上传进度：${st.progress}%`);
    }
    if (st.done) {
      ctx.log(`检测到上传完成标志：${st.done}`);
      await sleep(1000);
      return st;
    }
    if (st.videoReady && !st.pending.length) {
      ctx.log('检测到视频预览已生成，判定上传完成');
      await sleep(800);
      return st;
    }
    if (!st.pending.length && elapsed > 8000) calm += 1;
    else calm = 0;
    if (calm >= 4) {
      if (!warnedCalm && !st.hasFile && !st.done) {
        warnedCalm = true;
        ctx.log('页面持续没有上传提示，但也没检测到文件接收迹象，按完成处理；请核对视频是否真的上传成功');
      } else {
        ctx.log('页面已无「上传中」提示，判定上传完成（如仍在转码请稍等）');
      }
      await sleep(800);
      return st;
    }
    // 转码/处理提示可能长时间存在，但编辑区已经可用时不应继续死等
    if (st.pending.length && st.editorReady && elapsed > 15000 && Date.now() - lastChange > 30000) {
      ctx.log(`页面仍提示「${st.pending.join('、')}」，但编辑区已可用，继续填写（转码可在发布时继续）`);
      return st;
    }
    if (Date.now() - lastChange > stallMs) {
      throw new StepError(
        'upload',
        `上传 ${Math.round(stallMs / 1000)} 秒没有进展，已停止等待（页面提示：${st.pending.join('、') || '无'}）`
      );
    }
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      const progressText = st.progress ? `（${st.progress}%）` : '';
      ctx.setStatus('uploading', `视频上传中…已等待 ${Math.round(elapsed / 1000)} 秒${progressText}`);
      ctx.log(
        `等待上传：${Math.round(elapsed / 1000)} 秒${progressText}` +
          (st.pending.length ? `，页面提示「${st.pending[0]}」` : '，页面无上传中提示')
      );
    }
    await sleep(1500);
  }
  throw new StepError('upload', `视频上传超时（${Math.round(cfg.timeoutMs / 60000)} 分钟未完成）`);
}

async function fillTags(ctx) {
  const { tags } = ctx.platform;
  const list = ctx.effective.tags || [];
  if (!list.length || tags.mode === 'none') {
    if (list.length) ctx.log('该平台不处理话题，已跳过');
    return;
  }
  if (tags.mode === 'inline-hash') {
    const contentCandidates = ctx.platform.content.selectors.length
      ? ctx.platform.content.selectors
      : ctx.platform.title.selectors;
    await waitForTarget(ctx, contentCandidates, 15000, '正文（追加话题）');
    await evalScript(ctx, selectors.caretToEndScript());
    const text = ` ${inlineTags(list, tags.prefix)}`;
    await typeText(ctx, text);
    await sleep(600);
    ctx.log(`已在正文末尾追加话题：${text.trim()}`);
    return;
  }
  const candidates = tags.selectors.length ? tags.selectors : ctx.platform.content.selectors;
  if (tags.openButton && tags.openButton.length) {
    // 例如 YouTube 的话题输入框藏在「显示更多」折叠区里，先展开
    await clickSequence(ctx, tags.openButton, '话题展开');
    await sleep(900);
  }
  const hit = await waitForTarget(ctx, candidates, 20000, '话题输入框');
  ctx.log(`定位话题输入框：${hit.candidate}`);
  await evalScript(ctx, selectors.focusHitScript());
  if (tags.mode === 'enter-input' || tags.confirm) {
    for (const tag of list) {
      if (ctx.isCancelled()) throw new StepError('cancel', '任务已取消');
      await typeText(ctx, tag);
      await sleep(150);
      await ctx.cdp.pressEnter();
      await sleep(300);
    }
    ctx.log(`已逐个添加话题：${list.join('、')}`);
  } else {
    await typeText(ctx, list.join(', '));
    await sleep(300);
    ctx.log(`已填写话题：${list.join(', ')}`);
  }
}

async function setCover(ctx) {
  if (!ctx.coverPath) return;
  // 封面各平台 UI 差异太大，暂不自动设置；保留视频/标题/正文/话题的自动填写
  ctx.log('封面暂未支持自动设置，请在平台上手动选择封面（不影响其它填写）');
}

/**
 * 执行单个平台。
 * @param {object} opts
 * @param {object} opts.view WebContentsView
 * @param {object} opts.platform 平台配置
 * @param {object} opts.task { videoPath, coverPath, title, description, tags }
 * @param {object} [opts.prepared] 已按平台截断好的文案
 * @param {(platformId:string, msg:string)=>void} [opts.onLog]
 * @param {(platformId:string, status:string, message:string)=>void} [opts.onStatus]
 * @param {()=>boolean} [opts.isCancelled]
 */
async function runPlatform(opts) {
  const { view, platform, task } = opts;
  const prepared = opts.prepared || prepareForPlatform(task, platform, { autoTruncate: true });
  const cdp = new Cdp(view.webContents);
  const ctx = {
    view,
    cdp,
    platform,
    task,
    videoPath: task.videoPath,
    coverPath: task.coverPath || '',
    effective: prepared,
    isCancelled: opts.isCancelled || (() => false),
    log: (msg) => opts.onLog && opts.onLog(platform.id, msg),
    setStatus: (status, message) => opts.onStatus && opts.onStatus(platform.id, status, message),
  };

  try {
    ctx.setStatus('opening', '正在打开创作中心…');
    await navigate(ctx, platform.entry);

    ctx.setStatus('opening', '检查登录状态…');
    await ensureLogin(ctx);

    // YouTube 的「创建」菜单在 Shadow DOM 里点不到，改为拿到 channelId 后直达上传弹窗
    if (platform.uploadEntry) {
      const channelId = await evalScript(ctx, selectors.channelIdScript()).catch(() => '');
      if (channelId) {
        await navigate(ctx, platform.uploadEntry.replace('{channelId}', channelId));
      } else {
        ctx.log('未找到频道 ID，继续使用普通入口');
      }
    }

    ctx.setStatus('uploading', '正在上传视频…');
    await uploadVideo(ctx);
    await waitUploadComplete(ctx);

    if (platform.combineTitleDesc) {
      // 快手这类平台没有独立标题框，标题和正文共用「作品描述」，按 标题\n正文 写入
      const combined = [prepared.title, prepared.description].filter(Boolean).join('\n');
      ctx.setStatus('filling', '正在填写作品描述…');
      await fillField(ctx, platform.title.selectors, combined, '作品描述', platform.title.clearFirst);
    } else {
      ctx.setStatus('filling', '正在填写标题…');
      await fillField(ctx, platform.title.selectors, prepared.title, '标题', platform.title.clearFirst);

      if (prepared.description) {
        if (platform.content.selectors.length) {
          ctx.setStatus('filling', '正在填写简介…');
          await fillField(ctx, platform.content.selectors, prepared.description, '简介', platform.content.clearFirst);
        } else {
          ctx.log('该平台没有独立的简介输入框，简介内容已忽略');
        }
      }
    }

    if (prepared.tags.length && platform.tags.mode !== 'none') {
      ctx.setStatus('filling', '正在填写话题…');
      try {
        await fillTags(ctx);
      } catch (tagErr) {
        ctx.log(`话题填写未完成（不影响发布）：${tagErr.message}`);
      }
    }

    if (ctx.coverPath) {
      ctx.setStatus('filling', '正在设置封面…');
      try {
        await setCover(ctx);
      } catch (coverErr) {
        ctx.log(`封面设置未完成（不影响发布）：${coverErr.message}`);
      }
    }

    ctx.setStatus('filled', '信息已填好，请切到该平台确认并手动发布');
    return { status: 'filled', warnings: prepared.warnings };
  } catch (err) {
    if (err instanceof StepError) throw err;
    throw new StepError('unknown', err.message || String(err));
  }
}

module.exports = { runPlatform, StepError, normalize, sleep };
