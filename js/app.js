/* ============================================================
   Sleep Ritual — 主逻辑 v2（第二阶段）
   范围：Night / Morning 完整交互；History / Settings 保持骨架。
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 小工具 ---------- */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // 统一的日期工具（cutoff / 本地日期 / 安全格式化均来自 DateUtils，避免重复实现）
  const DateUtils = (typeof window !== "undefined" && window.DateUtils) || null;

  function nowHHMM(d = new Date()) {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function todayStr(d = new Date()) {
    if (DateUtils && DateUtils.todayStr) return DateUtils.todayStr(d);
    const date = d instanceof Date ? d : new Date(d);
    return (
      date.getFullYear() + "-" +
      String(date.getMonth() + 1).padStart(2, "0") + "-" +
      String(date.getDate()).padStart(2, "0")
    );
  }
  /* 安全时间格式化：对 undefined/null/""/NaN/Invalid Date 返回 fallback，永不出现 NaN:NaN。 */
  function fmtTime(iso, fallback = "--:--") {
    if (DateUtils && DateUtils.formatTime) return DateUtils.formatTime(iso, fallback);
    if (iso == null || iso === "") return fallback;
    const date = iso instanceof Date ? iso : new Date(iso);
    if (isNaN(date.getTime())) return fallback;
    return nowHHMM(date);
  }
  function fmtCNDate(d = new Date()) {
    const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
  }

  /* ---------- 视图切换（hash 路由） ---------- */

  const VIEWS = ["night", "morning", "history", "settings"];
  const THEME_COLORS = { night: "#000000", morning: "#f6f2e9" };

  function defaultViewByHour() {
    const h = new Date().getHours();
    // 05:00 – 11:59 视为早晨，其余时间进入夜间干预
    return h >= 5 && h < 12 ? "morning" : "night";
  }

  async function showView(name, opts = {}) {
    if (!VIEWS.includes(name)) name = defaultViewByHour();
    $$(".view").forEach((v) => v.classList.remove("is-active"));
    $("#view-" + name).classList.add("is-active");
    $$(".tab").forEach((t) =>
      t.classList.toggle("is-active", t.dataset.view === name)
    );
    const mode = name === "morning" ? "morning" : "night";
    document.body.dataset.mode = mode;
    // 联动系统级 theme-color（状态栏/标题栏底色）
    $("#meta-theme-color").setAttribute(
      "content",
      THEME_COLORS[mode] || THEME_COLORS.night
    );
    if (!opts.silent) {
      const target = "#/" + name;
      if (location.hash !== target) history.replaceState(null, "", target);
    }
    if (name === "night") await renderTonightMorningEcho();
    if (name === "morning") await renderMorning();
    if (name === "history") await renderHistory();
    if (name === "settings") await renderSettings();
  }

  function bindTabs() {
    $$(".tab").forEach((t) =>
      t.addEventListener("click", () => showView(t.dataset.view))
    );
    window.addEventListener("hashchange", () =>
      showView(location.hash.replace("#/", ""), { silent: true })
    );
  }

  /* ---------- NIGHT ---------- */

  let selectedReasons = [];
  let currentNightId = null;     // 当前晚 active 会话 id（打开即建，completed 时复用）
  let currentSource = "unknown"; // 入口来源（Phase 4 AnchorProvider 填充）
  let nightShownAt = null;   // 本次打开夜间页的时间（写入 session）
  let shownContentId = null; // 本次展示的内容 id（写入 session）

  /* 行为提示表：默认用 content.js 内置 BEHAVIOR_TIPS，
     启动时尝试用 data/seed-actions.json 覆盖（内容管线的一部分）。
     ACTION_IDS：reasonId → 微行为 id（act_xxx），写入 NightSession.selectedActionId。 */
  let ACTION_TIPS = BEHAVIOR_TIPS;
  let ACTION_IDS = {};

  async function loadActionTips() {
    try {
      const resp = await fetch("data/seed-actions.json");
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && Array.isArray(data.items)) {
        const map = {};
        const ids = {};
        data.items.forEach((it) => {
          if (it.reasonId && it.action) map[it.reasonId] = it.action;
          if (it.reasonId && it.id) ids[it.reasonId] = it.id;
        });
        if (Object.keys(map).length) ACTION_TIPS = map;
        if (Object.keys(ids).length) ACTION_IDS = ids;
      }
    } catch (e) {
      /* 无 fetch 或文件缺失：保留内置表 */
    }
  }

  function startClock() {
    const clock = $("#night-clock");
    const date = $("#night-date");
    const tick = () => {
      const d = new Date();
      clock.textContent = nowHHMM(d);
      date.textContent = fmtCNDate(d);
    };
    tick();
    setInterval(tick, 15000);
  }

  async function renderNightMeta() {
    const target = await DB.getSetting("bedtime", "23:30").catch(() => "23:30");
    $("#night-target").textContent = target;
  }

  let shownTonight = new Set(); // 本次会话已展示过的内容 id（避免同晚内重复）

  function showContentItem(box, item) {
    shownContentId = item.id ?? null;
    if (item.id) shownTonight.add(item.id);
    // 只显示内容本体。source 是数据层的溯源元数据（管理者可查），
    // 不渲染到夜间页面——低刺激原则，夜间不出现任何非干预信息。
    box.textContent = item.text;
    if (item.id) {
      // 真实更新使用计数（usagePenalty 才可能生效）
      DB.incrementContentUsage(item.id).catch(() => {});
    }
    if (currentNightId && item.id) {
      DB.addEvent({
        sessionId: currentNightId,
        type: "content_shown",
        payload: { contentId: item.id, type: item.type },
      }).catch(() => {});
    }
  }

  async function contentTypeById(id) {
    try {
      const all = await DB.getAllContent();
      const c = all.find((x) => x.id === id);
      return c ? c.type : null;
    } catch (e) {
      return null;
    }
  }

  /* 从内容池中按规则选取一条：委托 ContentSelector（规则评分版本）。
     1. enabled 为 true（默认 true）且 modes 含 "night"
     2. 原因命中 / 标签命中 / 基础权重 / 使用降权 / 探索噪声 加权
     3. 排除 excludeIds（本次会话 + 近 7 晚已展示），池空回退不过滤
     见 js/content-selector.js。 */
  function pickContent(all, reasonIds, excludeIds = null) {
    if (window.ContentSelector) {
      return window.ContentSelector.selectForNight({ all, reasonIds, excludeIds });
    }
    return null;
  }

  /* 最近 7 晚展示过的内容 id 集合（含本次会话），用于避免连续重复 */
  async function recentlyShownIds() {
    const ids = new Set(shownTonight);
    try {
      const recent = await DB.getRecentNightSessions(7);
      recent.forEach((s) =>
        (s.shownContentIds || (s.contentId ? [s.contentId] : [])).forEach((id) =>
          ids.add(id)
        )
      );
    } catch (e) {
      /* 存储不可用：仅用会话内集合 */
    }
    return ids;
  }

  async function renderNightContent() {
    const box = $("#night-content");
    try {
      const all = await DB.getAllContent();
      if (!all.length) {
        box.textContent = "今晚，就到此为止吧。";
        return;
      }
      const exclude = await recentlyShownIds();
      const item = pickContent(all, null, exclude);
      if (item) showContentItem(box, item);
      else box.textContent = "今晚，就到此为止吧。";
    } catch (e) {
      box.textContent = "今晚，就到此为止吧。";
    }
  }

  /* 选完原因后：从命中的内容池中换一条展示 */
  async function renderContentForReasons() {
    const box = $("#night-content");
    try {
      const all = await DB.getAllContent();
      if (!all.length) return;
      const exclude = await recentlyShownIds();
      const item = pickContent(all, selectedReasons, exclude);
      if (item) showContentItem(box, item);
    } catch (e) {
      /* 静默失败，保留上一条内容 */
    }
  }

  /* 点击「每日一句」手动换一条——复用原因联动 + 会话去重 */
  async function shuffleNightContent() {
    const box = $("#night-content");
    if (!box || box.dataset.shuffling === "1") return;
    box.dataset.shuffling = "1";
    try {
      const all = await DB.getAllContent();
      if (!all.length) return;
      const exclude = await recentlyShownIds();
      let item = pickContent(all, selectedReasons, exclude);
      if (!item) item = pickContent(all, selectedReasons, null); // 池子转空，回退不过滤
      if (!item) return;
      box.style.opacity = "0";
      setTimeout(() => {
        showContentItem(box, item); // 计入 shownTonight，最终落库为这晚展示句
        requestAnimationFrame(() => { box.style.opacity = "1"; });
        delete box.dataset.shuffling;
      }, 160);
    } catch (e) {
      box.style.opacity = "1";
      delete box.dataset.shuffling;
    }
  }

  function bindNightContentShuffle() {
    const box = $("#night-content");
    if (!box) return;
    box.addEventListener("click", shuffleNightContent);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        shuffleNightContent();
      }
    });
  }

  /* 夜间页「每日一句」下方回显：今天早晨写给自己那句话。
     仅当今天（日历日）确有早晨记录且含 morningMessage 时才显示；否则隐藏。 */
  async function renderTonightMorningEcho() {
    const box = $("#morning-echo");
    if (!box) return;
    const txt = box.querySelector(".morning-echo-text");
    try {
      const mornings = await DB.getRecentMorningSessions(30).catch(() => []);
      const today = todayStr();
      const m = mornings.find((x) => x.date === today && x.morningMessage);
      if (m && txt) {
        txt.textContent = m.morningMessage;
        box.hidden = false;
      } else {
        box.hidden = true;
      }
    } catch (e) {
      box.hidden = true;
    }
  }

  function renderReasonChips() {
    const wrap = $("#reason-list");
    wrap.innerHTML = "";
    REASONS.forEach((r) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = r.label;
      btn.addEventListener("click", () => toggleReason(r, btn));
      wrap.appendChild(btn);
    });
  }

  function toggleReason(reason, btn) {
    const i = selectedReasons.indexOf(reason.id);
    if (i >= 0) {
      selectedReasons.splice(i, 1);
      btn.classList.remove("is-on");
    } else {
      if (selectedReasons.length >= 2) return; // 最多 2 个
      selectedReasons.push(reason.id);
      btn.classList.add("is-on");
      if (currentNightId) {
        DB.addEvent({
          sessionId: currentNightId,
          type: "reason_selected",
          payload: { reasonId: reason.id },
        }).catch(() => {});
      }
    }
    renderBehaviorTip();
    renderContentForReasons();
  }

  function renderBehaviorTip() {
    const box = $("#behavior-tip");
    const text = $("#behavior-tip-text");
    if (!selectedReasons.length) {
      box.hidden = true;
      return;
    }
    text.textContent = ACTION_TIPS[selectedReasons[0]] || "";
    box.hidden = false;
    if (currentNightId && text.textContent) {
      DB.addEvent({
        sessionId: currentNightId,
        type: "behavior_shown",
        payload: { actionId: ACTION_IDS[selectedReasons[0]] || null },
      }).catch(() => {});
    }
  }

  let brainDumpUsed = false; // 本次夜间流程是否用过「丢掉」（只记标志，不存内容）

  function bindBrainDump() {
    const input = $("#braindump-input");
    $("#braindump-clear").addEventListener("click", () => {
      if (!input.value.trim()) return;
      // 不保存，只做轻微淡出反馈
      brainDumpUsed = true;
      if (currentNightId) {
        DB.addEvent({
          sessionId: currentNightId,
          type: "brain_dump_started",
        }).catch(() => {});
      }
      input.classList.add("fade-out");
      setTimeout(() => {
        input.value = "";
        input.classList.remove("fade-out");
      }, 820);
    });
  }

  /* 终态切换：流程区 ↔ 晚安页 */
  function showGoodnight() {
    $("#night-flow").hidden = true;
    $(".sleep-bar").hidden = true;
    $("#night-goodnight").hidden = false;
    window.scrollTo(0, 0);
  }
  function showNightFlow() {
    $("#night-flow").hidden = false;
    $(".sleep-bar").hidden = false;
    $("#night-goodnight").hidden = true;
  }

  async function bindSleepButton() {
    $("#btn-sleep").addEventListener("click", async () => {
      const firstReason = selectedReasons.length ? selectedReasons[0] : null;
      // 安全护栏：若当前会话不存在，或它已经是 completed（例如「返回流程」后再次就寝），
      // 则新建一条 active 会话 —— 绝不覆盖已完成的睡眠事实（状态机约束）。
      let prev = currentNightId
        ? await DB.getNightSessionById(currentNightId).catch(() => null)
        : null;
      if (!currentNightId || (prev && prev.status === "completed")) {
        await createNightSession();
        prev = null;
      }
      const sd = sleepDate();
      const nowIso = new Date().toISOString();
      const session = {
        id: currentNightId,
        date: sd,
        status: "completed",
        sessionStartedAt: (prev && prev.sessionStartedAt) || nightShownAt,
        completedAt: nowIso,
        phoneDownAt: nowIso, // 新字段（放下手机时间）；actualSleepAt 保留兼容旧数据
        actualSleepAt: nowIso,
        bedTimeTarget: await DB.getSetting("bedtime", "23:30").catch(() => "23:30"),
        contentId: shownContentId,
        contentType: shownContentId ? await contentTypeById(shownContentId) : null,
        shownContentIds: shownContentId ? [shownContentId] : [],
        reasons: [...selectedReasons],
        selectedActionId: firstReason ? ACTION_IDS[firstReason] || null : null,
        behaviorTip: firstReason ? ACTION_TIPS[firstReason] : null,
        brainDumpUsed,
        tonightMessage: $("#tonight-message").value.trim() || null,
        sleepTownAttempted: true,
        sleepTownResult: "attempted",
        source: currentSource,
        updatedAt: nowIso,
        dateSource: "auto",
      };
      try {
        await DB.updateNightSession(session);
        await DB.addEvent({
          sessionId: currentNightId,
          type: "night_completed",
          date: sd,
          payload: { date: sd },
        }).catch(() => {});
        await DB.addEvent({
          sessionId: currentNightId,
          type: "sleep_decision",
          date: sd,
          payload: { source: currentSource },
        }).catch(() => {});
      } catch (e) {
        console.error("保存失败", e);
      }
      showGoodnight();
      tryOpenSleepTown();
    });

    // 备用按钮：无论 scheme 是否可用，用户始终可以再点一次
    $("#btn-sleeptown").addEventListener("click", tryOpenSleepTown);
  }

  /* 尝试打开 SleepTown。
     - sleeptown:// 见于社区 App URL 清单，但无官方文档，不能当作已验证事实；
     - iOS PWA 对自定义 scheme 没有成功回调，唯一可用信号是
       「页面是否进入后台」（visibilitychange）；
     - 因此：自动尝试 + 常驻手动按钮双轨，失败给出明确提示，
       scheme 失效不影响任何功能。 */
  function tryOpenSleepTown() {
    if (currentNightId) {
      DB.addEvent({
        sessionId: currentNightId,
        type: "sleeptown_attempted",
      }).catch(() => {});
    }
    const attemptAt = Date.now();
    window.location.href = "sleeptown://";
    setTimeout(() => {
      // 2.2 秒后页面仍可见 → 大概率没有唤起，显示手动提示
      if (!document.hidden && Date.now() - attemptAt < 2600) {
        const hint = $("#sleeptown-hint");
        if (hint) hint.hidden = false;
        if (currentNightId) {
          DB.addEvent({
            sessionId: currentNightId,
            type: "sleeptown_fallback_opened",
          }).catch(() => {});
        }
      }
    }, 2200);
  }

  /* 睡眠日：把 00:00–04:00 的入睡归入前一天。
     规则统一在 DateUtils.sleepDate 中定义（cutoff=4），这里直接委托，
     避免重复实现日期规则；仅在 DateUtils 不可用时回退到本地实现。 */
  function sleepDate(d = new Date()) {
    if (DateUtils && DateUtils.sleepDate) return DateUtils.sleepDate(d);
    const date = d instanceof Date ? new Date(d) : new Date(d);
    if (date.getHours() < 4) date.setDate(date.getDate() - 1);
    return todayStr(date);
  }

  // 测试钩子：暴露纯函数供单元测试断言日期边界（对生产逻辑无副作用）
  window.sleepDate = sleepDate;
  // 测试钩子：暴露夜/晨配对纯函数供单元测试（对生产逻辑无副作用）
  window.__pairMorningToNight = pairMorningToNight;
  // 测试钩子：暴露深链进入睡前流程的入口，便于验证「已完成 Night 重复进入不重复建」
  window.__enterNightViaDeepLink = enterNightViaDeepLink;
  // 测试钩子：暴露会话状态机判定（对生产逻辑无副作用）
  window.canTransitionSessionStatus = canTransitionSessionStatus;

  /* 会话状态机：集中定义允许的状态转换，避免在多处散落判断。
     active    → completed / abandoned   允许
     active    → active（同态/读取）     允许
     completed → active                  普通流程禁止（已完成是不可覆盖的历史事实）
     completed → abandoned               禁止
     其它转换默认禁止。 */
  function canTransitionSessionStatus(from, to) {
    if (!from || !to) return false;
    if (from === to) return true;
    if (from === "active" && (to === "completed" || to === "abandoned")) return true;
    return false; // completed 禁止转回 active / abandoned
  }

  /* 新建/复用一条「今晚」的 active 会话。
     先复查本晚是否已有 active（防 race / 重复触发导致多条 active），有则复用；
     已 completed/abandoned 的会话绝不被转回 active（状态机约束）。 */
  async function createNightSession() {
    const sd = sleepDate();
    const existing = await DB.getActiveNightSession(sd).catch(() => null);
    if (existing) {
      currentNightId = existing.id;
      return existing;
    }
    const session = {
      date: sd,
      status: "active",
      sessionStartedAt: new Date().toISOString(),
      source: currentSource,
      bedTimeTarget: await DB.getSetting("bedtime", "23:30").catch(() => "23:30"),
      reasons: [],
      selectedActionId: null,
      behaviorTip: null,
      contentId: null,
      shownContentIds: [],
      tonightMessage: null,
      sleepTownAttempted: false,
      brainDumpUsed: false,
      phoneDownAt: null,
      updatedAt: new Date().toISOString(),
      dateSource: "auto",
    };
    try {
      currentNightId = await DB.addNightSession(session);
      await DB.addEvent({
        sessionId: currentNightId,
        type: "night_started",
        date: sd,
        payload: { date: sd, source: currentSource },
      }).catch(() => {});
    } catch (e) {
      console.error("创建夜间会话失败", e);
    }
    return session;
  }

  /* 确保本晚有一条 active 会话供「睡前流程」使用：
     - 已有 active → 复用（同晚不重复）
     - 已有 completed → 保持 completed 不变，返回 null（调用方进入终态，不创建、不修改）
     - 其它 → 新建 active 会话
     注意：已完成会话绝不被普通流程重新激活（状态机约束）。 */
  async function ensureNightSession() {
    const sd = sleepDate();
    const active = await DB.getActiveNightSession(sd).catch(() => null);
    if (active) {
      currentNightId = active.id;
      return active;
    }
    const last = await DB.getLatestNightSession().catch(() => null);
    // 已完成 / abandoned 会话不可转回 active —— 保持原样，返回 null（不创建、不修改）
    if (last && last.date === sd && !canTransitionSessionStatus(last.status, "active")) {
      currentNightId = null;
      return null;
    }
    return await createNightSession();
  }

  /* 深链 #/night 进入：进入睡前流程。
     若今晚已完成，则保持 completed 不变，进入「今晚已完成」终态，不创建新会话、不修改完成数据。 */
  async function enterNightViaDeepLink() {
    nightShownAt = new Date().toISOString();
    currentNightId =  null;
    const session = await ensureNightSession();
    if (session) {
      showNightFlow();
    } else {
      // 已完成（或异常）：保持 completed 不变，进入终态
      showGoodnight();
    }
    if (window.AnchorProvider) window.AnchorProvider.clearHash();
  }

  /* 判断"今晚是否已经睡过"：基于 active/completed 状态，而非仅日期相等。 */
  async function resumeNightState() {
    nightShownAt = new Date().toISOString();
    try {
      const session = await ensureNightSession();
      if (session) showNightFlow();
      else showGoodnight(); // 已完成 → 终态
    } catch (e) {
      showNightFlow();
    }
  }

  /* 晚安页手动返回待睡流程（兜底）。
     注意：必须清空 currentNightId —— 否则「返回流程」后再点睡觉会复用已 completed
     的会话 id，从而覆盖历史事实。清空后，下一次就寝会新建一条 active 会话。 */
  function bindBackToNightFlow() {
    const btn = $("#btn-back-to-night");
    if (!btn) return;
    btn.addEventListener("click", () => {
      // 重置当前会话状态，让用户重新走一遍睡前流程（不影响已完成的记录）
      currentNightId = null;
      selectedReasons = [];
      brainDumpUsed = false;
      shownTonight.clear();
      $$("#reason-list .chip").forEach((b) => b.classList.remove("is-on"));
      $("#tonight-message").value = "";
      $("#braindump-input").value = "";
      $("#sleeptown-hint").hidden = true;
      renderNightContent();
      renderBehaviorTip();
      showNightFlow();
      renderTonightMorningEcho();
    });
  }

  /* ---------- MORNING ---------- */

  let selectedMood = null;
  let currentMorningId = null;

  function bindMood() {
    $$(".mood").forEach((btn) =>
      btn.addEventListener("click", () => {
        $$(".mood").forEach((b) => b.classList.remove("is-on"));
        btn.classList.add("is-on");
        selectedMood = btn.dataset.mood;
      })
    );
  }

  function showMorningFlow() {
    $("#morning-flow").hidden = false;
    $("#morning-done").hidden = true;
  }
  function showMorningDone() {
    $("#morning-flow").hidden = true;
    $("#morning-done").hidden = false;
    window.scrollTo(0, 0);
  }

  async function renderMorning() {
    DB.addEvent({ type: "morning_opened", date: todayStr(), payload: { date: todayStr() } }).catch(() => {});
    const last = await DB.getLatestNightSession().catch(() => null);
    const pd = last && (last.phoneDownAt || last.actualSleepAt);
    // 只在「最近 18 小时内」的夜间记录才算"昨晚"，避免展示几天前的旧数据
    const fresh = last && pd && Date.now() - new Date(pd).getTime() < 18 * 3600 * 1000;
    if (fresh) {
      const d = new Date(pd);
      $("#morning-bedtime").textContent = nowHHMM(d);
      $("#morning-tonight-message").textContent =
        last.tonightMessage || "（没有记录）";
    } else {
      $("#morning-bedtime").textContent = "--:--";
      $("#morning-tonight-message").textContent = "（没有记录）";
    }
    showMorningFlow();
  }

  function bindMorningSave() {
    $("#btn-morning-save").addEventListener("click", async () => {
      const session = {
        date: todayStr(),
        mood: selectedMood,
        morningMessage: $("#morning-message").value.trim() || null,
        wakeAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      try {
        // 按「早晨日历日」upsert：同一天重复保存只更新，不新增多条 MorningSession
        await DB.upsertMorningSessionByDate(todayStr(), session);
        await DB.addEvent({
          sessionId: null,
          type: "morning_completed",
          date: todayStr(),
          payload: { date: todayStr() },
        }).catch(() => {});
      } catch (e) {
        console.error("保存失败", e);
      }
      // 无论存储是否成功，都进入终态——不让技术问题打断早晨
      $("#morning-message").value = "";
      $$(".mood").forEach((b) => b.classList.remove("is-on"));
      selectedMood = null;
      showMorningDone();
    });
  }

  /* ---------- HISTORY（骨架，本阶段不开发） ---------- */

  function delayMinutes(session) {
    const pd = session.phoneDownAt || session.actualSleepAt;
    if (!session.bedTimeTarget || !pd) return null;
    const [th, tm] = session.bedTimeTarget.split(":").map(Number);
    const target = th * 60 + tm;
    const d = new Date(pd);
    if (isNaN(d.getTime())) return null;
    let actual = d.getHours() * 60 + d.getMinutes();
    if (actual < 360 && target >= 720) actual += 1440; // 凌晨入睡视作跨天
    const diff = actual - target;
    return diff > 0 ? diff : 0;
  }

  /* 最近 7 天极简趋势：一行文字概括，不做图表、不评价 */
  function renderHistoryTrend(nights) {
    const el = $("#history-trend");
    const recent = nights.slice(0, 7);
    const delays = recent
      .map(delayMinutes)
      .filter((d) => d !== null && d !== undefined);
    const reasonCount = {};
    recent.forEach((n) =>
      (n.reasons || []).forEach((id) => {
        const label = (REASONS.find((r) => r.id === id) || {}).label;
        if (label) reasonCount[label] = (reasonCount[label] || 0) + 1;
      })
    );
    const topReason = Object.entries(reasonCount).sort((a, b) => b[1] - a[1])[0];

    if (!recent.length) {
      el.hidden = true;
      return;
    }
    const parts = [];
    if (delays.length) {
      const avg = Math.round(delays.reduce((a, b) => a + b, 0) / delays.length);
      parts.push(avg === 0 ? "最近 7 天都按时入睡" : `最近 7 天平均晚了 ${avg} 分钟`);
    }
    if (topReason) {
      parts.push(`最常见原因：${topReason[0]}`);
    }
    el.textContent = parts.join("，") + "。";
    el.hidden = false;
  }

  /* 夜间/早晨配对（纯函数，便于单测）。
     夜记录用 sleepDate（睡眠日），晨记录用醒来日历日，二者日期锚点不同，
     不能靠日期字符串相等配对。改为：每条早晨挂到「actualSleepAt ≤ wakeAt
     且间隔 ≤ 18h」的最近一条夜间记录。返回 { [nightId]: morning }。 */
  function pairMorningToNight(nights, mornings) {
    const map = {};
    mornings.forEach((m) => {
      const wake = new Date(m.wakeAt).getTime();
      let best = null;
      let bestSleep = -Infinity;
      nights.forEach((n) => {
        const sleep = new Date(n.actualSleepAt).getTime();
        if (sleep <= wake && wake - sleep <= 18 * 3600 * 1000 && sleep > bestSleep) {
          best = n;
          bestSleep = sleep;
        }
      });
      if (best) map[best.id] = m;
    });
    return map;
  }

  let historyRange = 7; // History 时间范围（7 / 30 天），由切换按钮控制

  /* 四问摘要：用 Analytics 聚合，只呈现事实、不做评价。 */
  async function renderHistorySummary(nights, mornings, rangeDays) {
    const el = $("#history-summary");
    if (!el) return;
    const inRange = nights.filter(
      (n) => window.Analytics && Analytics.withinDays(n, rangeDays)
    );
    if (!inRange.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const bedtime = await DB.getSetting("bedtime", "23:30").catch(() => "23:30");
    const reasons = Analytics.aggregateReasons(inRange);
    const trend = Analytics.bedtimeTrend(inRange);
    const median = Analytics.medianMinute(
      trend.map((t) => t.minutes + (t.crossedMidnight ? 1440 : 0))
    );
    const nightsById = {};
    inRange.forEach((n) => (nightsById[n.id] = n));
    const morningByNightId = pairMorningToNight(inRange, mornings);
    const eff = Analytics.behaviorEffectiveness(nightsById, morningByNightId);
    const actions = Analytics.aggregateActions(inRange);
    const delays = inRange
      .map((n) => Analytics.targetDelay(n, bedtime))
      .filter((d) => d != null);
    const avgDelay = delays.length
      ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
      : null;

    const reasonLabel = (id) => (REASONS.find((r) => r.id === id) || {}).label || id;
    const actionLabel = (id) => {
      const rid = Object.keys(ACTION_IDS).find((k) => ACTION_IDS[k] === id);
      return rid ? reasonLabel(rid) : id;
    };

    const blocks = [];
    if (reasons.length) {
      blocks.push(
        summaryBlock("最常见的熬夜原因", `${reasonLabel(reasons[0].id)}（${reasons[0].count} 晚）`)
      );
    }
    if (median != null) {
      blocks.push(summaryBlock("通常几点放下手机", Analytics.minutesToHHMM(median)));
    }
    if (actions.length) {
      let txt = actionLabel(actions[0].id);
      const e = eff.find((x) => x.id === actions[0].id);
      if (e && e.total) {
        const okRate = Math.round(((e.good + e.ok) / e.total) * 100);
        txt += `（试过 ${e.total} 晚，其中 ${okRate}% 早晨状态尚可）`;
      }
      blocks.push(summaryBlock("最常尝试的微行为", txt));
    }
    {
      let txt = `近 ${rangeDays} 天记录 ${inRange.length} 晚`;
      if (avgDelay != null) {
        txt += avgDelay >= 0 ? `，平均比目标晚 ${avgDelay} 分钟` : `，平均比目标早 ${-avgDelay} 分钟`;
      }
      blocks.push(summaryBlock("这段时间的节奏", txt));
    }

    el.innerHTML = blocks.join("");
    el.hidden = false;
  }

  function summaryBlock(title, body) {
    return (
      `<div class="summary-block">` +
      `<div class="summary-title">${title}</div>` +
      `<div class="summary-body">${body}</div>` +
      `</div>`
    );
  }

  function bindHistoryRange() {
    const btns = $$("#history-range .range-btn");
    if (!btns.length) return;
    btns.forEach((b) =>
      b.addEventListener("click", () => {
        historyRange = Number(b.dataset.range) || 7;
        btns.forEach((x) => x.classList.toggle("is-active", x === b));
        if ($("#view-history").classList.contains("is-active")) renderHistory();
      })
    );
  }

  async function renderHistory() {
    // 数据源：只取 completed 的夜间记录。active / abandoned 不进入 History，
    // 既不会显示「未完成」记录，也不会产生 NaN:NaN（完成记录必有 phoneDownAt）。
    const [nights, mornings] = await Promise.all([
      DB.getCompletedNightSessions(30).catch(() => []),
      DB.getRecentMorningSessions(30).catch(() => []),
    ]);
    // 时间邻近配对，避免夜/晨日期锚点不同造成配错位（显示旧内容）
    const morningByNightId = pairMorningToNight(nights, mornings);

    renderHistoryTrend(nights); // 仅 completed（mvp 测试依赖趋势行）
    await renderHistorySummary(nights, mornings, historyRange);

    const wrap = $("#history-list");
    wrap.innerHTML = "";
    const shown = nights.filter(
      (n) => window.Analytics && Analytics.withinDays(n, historyRange)
    );
    $("#history-empty").hidden = shown.length > 0;

    shown.forEach((n) => {
      const div = document.createElement("div");
      div.className = "history-item";

      const pd = n.phoneDownAt || n.actualSleepAt;
      const dMin = delayMinutes(n);
      const reasonLabels = (n.reasons || [])
        .map((id) => (REASONS.find((r) => r.id === id) || {}).label)
        .filter(Boolean)
        .join("、");

      const head = document.createElement("div");
      head.className = "h-date";
      head.innerHTML =
        `<span>${n.date}</span>` +
        `<span class="h-delay">` +
        (dMin === null ? "" : dMin === 0 ? "按时入睡" : `晚了 ${dMin} 分钟`) +
        `</span>`;
      div.appendChild(head);

      const line = document.createElement("div");
      // fmtTime 对缺失/非法时间安全返回 "--:--"，永不出现 NaN:NaN
      line.innerHTML =
        `<span class="h-label">放下手机</span>${fmtTime(pd)}` +
        `　<span class="h-label">目标</span>${n.bedTimeTarget || "--:--"}`;
      div.appendChild(line);

      if (reasonLabels) {
        const r = document.createElement("div");
        r.innerHTML = `<span class="h-label">原因</span>${reasonLabels}`;
        div.appendChild(r);
      }
      if (n.tonightMessage) {
        const q = document.createElement("blockquote");
        q.textContent = n.tonightMessage;
        div.appendChild(q);
      }
      const m = morningByNightId[n.id];
      if (m && (m.morningMessage || m.mood)) {
        const mo = document.createElement("div");
        const moodIcon = { good: "🙂", ok: "😐", sleepy: "😴" }[m.mood] || "";
        mo.innerHTML =
          `<span class="h-label">早晨</span>${moodIcon} ` + (m.morningMessage || "");
        div.appendChild(mo);
      }

      // 轻量操作：编辑 / 删除
      const actions = document.createElement("div");
      actions.className = "h-actions";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "h-edit";
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", () => startEditHistory(n));
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "h-del";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", () => deleteHistory(n));
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      div.appendChild(actions);

      wrap.appendChild(div);
    });
  }

  /* ---------- HISTORY 编辑 / 删除（P1：安全纠正历史记录） ---------- */

  let editingHistoryId = null;          // 正在编辑的 NightSession id（null = 无）
  let selectedHistoryReasons = [];      // 编辑面板中选中的原因

  function renderHistoryReasonChips() {
    const wrap = $("#he-reason-chips");
    if (!wrap) return;
    wrap.innerHTML = "";
    REASONS.forEach((r) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip" + (selectedHistoryReasons.includes(r.id) ? " is-on" : "");
      btn.textContent = r.label;
      btn.addEventListener("click", () => {
        const i = selectedHistoryReasons.indexOf(r.id);
        if (i >= 0) selectedHistoryReasons.splice(i, 1);
        else selectedHistoryReasons.push(r.id);
        btn.classList.toggle("is-on");
      });
      wrap.appendChild(btn);
    });
  }

  function startEditHistory(night) {
    editingHistoryId = night.id;
    $("#he-date").value = night.date || "";
    $("#he-phone").value =
      DateUtils && DateUtils.formatLocalInput
        ? DateUtils.formatLocalInput(night.phoneDownAt || night.actualSleepAt)
        : "";
    $("#he-target").value = night.bedTimeTarget || "23:30";
    $("#he-message").value = night.tonightMessage || "";
    selectedHistoryReasons = [...(night.reasons || [])];
    renderHistoryReasonChips();
    $("#btn-history-save").textContent = "保存修改";
    $("#btn-history-cancel").hidden = false;
    const ed = $("#history-edit");
    // Bug 2 修复：必须同时移除 hidden 并展开，否则用户点击编辑看不到任何反应。
    // （<details hidden> 仅设 open=true 仍不可见；hidden 优先级高于 open。）
    if (ed) {
      ed.hidden = false;
      if (!ed.open) ed.open = true;
      // 滚动到编辑区，保证移动端小屏也能看到表单
      try { ed.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (_) {}
    }
  }

  function cancelHistoryEdit() {
    editingHistoryId = null;
    $("#he-date").value = "";
    $("#he-phone").value = "";
    $("#he-target").value = "23:30";
    $("#he-message").value = "";
    selectedHistoryReasons = [];
    renderHistoryReasonChips();
    $("#btn-history-save").textContent = "保存修改";
    $("#btn-history-cancel").hidden = true;
    // 取消后折叠编辑区（但保留 hidden=false 以便下次直接展开，避免再次出现「点了没反应」）
    const ed = $("#history-edit");
    if (ed) ed.open = false;
  }

  async function saveHistoryEdit() {
    if (editingHistoryId == null) return;
    const date = $("#he-date").value;
    const phoneInput = $("#he-phone").value;
    const target = $("#he-target").value;
    if (!DateUtils || !DateUtils.isValidDateStr(date)) {
      alert("睡眠日格式不正确（应为 YYYY-MM-DD）");
      return;
    }
    const phoneIso = DateUtils && DateUtils.parseLocalInput(phoneInput);
    if (phoneInput && !phoneIso) {
      alert("放下手机时间格式不正确");
      return;
    }
    if (!DateUtils || !DateUtils.isValidHHMM(target)) {
      alert("目标时间格式不正确（应为 HH:MM）");
      return;
    }
    const orig = await DB.getNightSessionById(editingHistoryId).catch(() => null);
    if (!orig) {
      alert("记录不存在，可能已被删除。");
      cancelHistoryEdit();
      await renderHistory();
      return;
    }
    const updated = Object.assign({}, orig, {
      date, // 修改睡眠日不改变 id，Morning 配对基于时间戳（不依赖 date 字符串），不会断裂
      phoneDownAt: phoneIso || orig.phoneDownAt || orig.actualSleepAt,
      actualSleepAt: phoneIso || orig.actualSleepAt, // 兼容旧字段
      bedTimeTarget: target,
      reasons: [...selectedHistoryReasons],
      tonightMessage: $("#he-message").value.trim() || null,
      updatedAt: new Date().toISOString(),
      dateSource: "manual",
    });
    try {
      await DB.updateNightSession(updated);
    } catch (e) {
      console.error("保存历史记录失败", e);
    }
    cancelHistoryEdit();
    await renderHistory();
  }

  async function deleteHistory(night) {
    if (!confirm("确定删除这条记录？该操作不可恢复，且只删除这一条。")) return;
    try {
      await DB.deleteNightSession(night.id);
    } catch (e) {
      console.error("删除历史记录失败", e);
    }
    await renderHistory();
  }

  function bindHistoryEdit() {
    const save = $("#btn-history-save");
    const cancel = $("#btn-history-cancel");
    if (save) save.addEventListener("click", saveHistoryEdit);
    if (cancel) cancel.addEventListener("click", cancelHistoryEdit);
  }

  /* ---------- 数据自检（P2：异常检测，人工确认后才修正） ---------- */

  async function bindDataCheck() {
    const checkBtn = $("#btn-data-check");
    const repairBtn = $("#btn-data-repair");
    const result = $("#data-check-result");
    if (!checkBtn || !result) return;

    let lastReport = []; // 最近一次扫描结果（供修正使用）

    checkBtn.addEventListener("click", async () => {
      // Bug 3 修复：点击必须有即时反馈，避免「点了没反应」错觉
      result.hidden = false;
      result.innerHTML = `<p class="data-loading">正在扫描历史数据…</p>`;
      if (repairBtn) repairBtn.hidden = true;
      let report;
      try {
        report = await DB.findSuspiciousNightSessions({ staleHours: 36 });
      } catch (e) {
        console.error("数据自检失败", e);
        result.innerHTML = `<p class="data-error">扫描失败：${(e && e.message) || e}。请重试。</p>`;
        return;
      }
      lastReport = report;
      if (!report.length) {
        result.hidden = false;
        result.innerHTML = `<p class="data-ok">✓ 检查完成，未发现异常记录。</p>`;
        if (repairBtn) repairBtn.hidden = true;
        return;
      }
      const mismatch = report.filter((o) =>
        o.issues.some((i) => i.code === "date_mismatch")
      );
      const lines = report
        .map((o) => {
          const issues = o.issues
            .map((i) => {
              const extra = i.calculatedDate ? `（应归 ${i.calculatedDate}）` : "";
              return `· ${i.code}${extra}：${i.detail}`;
            })
            .join("<br>");
          return `<div class="data-row"><div class="data-id">记录 #${o.id} · ${o.date} · ${o.status}</div><div class="data-issues">${issues}</div></div>`;
        })
        .join("");
      result.hidden = false;
      result.innerHTML = `<p class="data-warn">发现 ${report.length} 条疑点：</p>${lines}`;
      if (repairBtn) repairBtn.hidden = mismatch.length === 0;
    });

    if (repairBtn) {
      repairBtn.addEventListener("click", async () => {
        const mismatch = lastReport.filter((o) =>
          o.issues.some((i) => i.code === "date_mismatch")
        );
        if (!mismatch.length) return;
        if (!confirm(`将修正 ${mismatch.length} 条高置信度的日期错位（按放下手机时间重新归日），并标记为 migration。是否继续？`))
          return;
        for (const o of mismatch) {
          const issue = o.issues.find((i) => i.code === "date_mismatch");
          if (issue && issue.calculatedDate) {
            await DB.repairNightSessionDate(o.id, issue.calculatedDate, "migration").catch(() => {});
          }
        }
        // 修正后刷新扫描结果与 History
        checkBtn.click();
        await renderHistory().catch(() => {});
      });
    }
  }

  /* ---------- 版本诊断（排查「GitHub 已更新但手机没变化」） ----------
     在设置页显示 App / SW Cache / DB 版本，便于真机快速判断
     到底是代码问题、Service Worker 缓存问题、还是 IndexedDB 迁移问题。 */
  const APP_VERSION = "1.5.0";
  let swCacheVersion = null;

  function renderVersionDiagnostics() {
    const el = $("#version-diagnostics");
    if (!el) return;
    const dbDiag = (DB && DB.getDiagnostics) ? "（DB 层就绪）" : "";
    Promise.resolve(DB && DB.getDiagnostics ? DB.getDiagnostics() : null)
      .then((dbd) => {
        el.innerHTML =
          `<div class="diag-row"><span class="diag-k">App Version</span><span class="diag-v">${APP_VERSION}</span></div>` +
          `<div class="diag-row"><span class="diag-k">SW Cache</span><span class="diag-v">${swCacheVersion != null ? swCacheVersion : "未注册"}</span></div>` +
          `<div class="diag-row"><span class="diag-k">DB Name</span><span class="diag-v">${(dbd && dbd.dbName) || "—"}</span></div>` +
          `<div class="diag-row"><span class="diag-k">DB Version</span><span class="diag-v">${(dbd && dbd.dbVersion) || "—"}</span></div>` +
          `<div class="diag-row"><span class="diag-k">Legacy Migration</span><span class="diag-v">${(dbd && dbd.legacyMigrationVersion) || "—"}</span></div>`;
      })
      .catch(() => {
        el.innerHTML = `<div class="diag-row"><span class="diag-k">App Version</span><span class="diag-v">${APP_VERSION}</span></div>` +
          `<div class="diag-row"><span class="diag-k">SW Cache</span><span class="diag-v">${swCacheVersion != null ? swCacheVersion : "未注册"}</span></div>` +
          `<div class="diag-row"><span class="diag-k">DB</span><span class="diag-v">读取失败 ${dbDiag}</span></div>`;
      });
  }

  // 接收 Service Worker 报告的当前 cache 版本号
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e && e.data && e.data.type === "SW_CACHE_VERSION") {
        swCacheVersion = e.data.version;
        renderVersionDiagnostics();
      }
    });
  }

  /* ---------- SETTINGS（骨架，本阶段不开发） ---------- */

  async function renderSettings() {
    $("#setting-bedtime").value = await DB.getSetting("bedtime", "23:30");
    $("#setting-waketime").value = await DB.getSetting("waketime", "07:30");
    await renderContentList();
  }

  const CONTENT_TYPE_NAMES = {
    quote: "一句话",
    excerpt: "摘录",
    self: "写给自己",
    tip: "行为提示",
  };

  async function renderContentList() {
    const wrap = $("#content-list");
    wrap.innerHTML = "";
    const all = await DB.getAllContent().catch(() => []);
    const filtered = all.filter((c) => {
      if (contentFilter === "enabled") return c.enabled !== false;
      if (contentFilter === "disabled") return c.enabled === false;
      return true;
    });
    filtered.forEach((item) => {
      const row = document.createElement("div");
      row.className = "content-row" + (item.enabled === false ? " is-disabled" : "");

      const main = document.createElement("div");
      main.className = "c-main";

      const type = document.createElement("span");
      type.className = "c-type";
      type.textContent = CONTENT_TYPE_NAMES[item.type] || item.type;

      const text = document.createElement("span");
      text.className = "c-text";
      text.textContent = item.text;

      const meta = document.createElement("div");
      meta.className = "c-meta";
      const bits = [];
      if (item.reasons && item.reasons.length) {
        bits.push(
          "原因 " +
            item.reasons
              .map((id) => ((REASONS.find((r) => r.id === id) || {}).label || id))
              .join("/")
        );
      }
      if (item.tags && item.tags.length) bits.push("标签 " + item.tags.join("/"));
      bits.push("权重 " + (item.weight != null ? item.weight : 1));
      bits.push("展示 " + (item.usageCount || 0));
      meta.textContent = bits.join("　");

      main.appendChild(type);
      main.appendChild(text);
      main.appendChild(meta);
      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "c-actions";

      const en = document.createElement("label");
      en.className = "c-enable";
      en.title = "启用 / 停用";
      const enBox = document.createElement("input");
      enBox.type = "checkbox";
      enBox.checked = item.enabled !== false;
      enBox.addEventListener("change", async () => {
        await DB.updateContent(Object.assign({}, item, { enabled: enBox.checked }));
        renderContentList();
      });
      en.appendChild(enBox);

      const edit = document.createElement("button");
      edit.className = "c-edit";
      edit.type = "button";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => startEditContent(item));

      const del = document.createElement("button");
      del.className = "c-del";
      del.type = "button";
      del.textContent = "×";
      del.title = "删除";
      del.addEventListener("click", async () => {
        await DB.deleteContent(item.id);
        if (editingContentId === item.id) cancelEditContent();
        renderContentList();
      });

      actions.appendChild(en);
      actions.appendChild(edit);
      actions.appendChild(del);
      row.appendChild(actions);

      wrap.appendChild(row);
    });
  }

  function startEditContent(item) {
    editingContentId = item.id;
    $("#content-type").value = item.type;
    $("#content-text").value = item.text;
    $("#content-source").value = item.source || "";
    $("#content-enabled").checked = item.enabled !== false;
    $("#content-weight").value = item.weight != null ? item.weight : 1;
    $("#content-tags").value = (item.tags || []).join("、");
    selectedContentReasons = [...(item.reasons || [])];
    renderContentReasonChips();
    $("#btn-content-save").textContent = "保存修改";
    $("#content-editor-summary").textContent = "编辑内容";
    $("#btn-content-cancel").hidden = false;
    const ed = $("#content-editor");
    if (ed && !ed.open) ed.open = true;
    $("#content-text").focus();
  }

  function cancelEditContent() {
    editingContentId = null;
    $("#content-type").value = "quote";
    $("#content-text").value = "";
    $("#content-source").value = "";
    $("#content-enabled").checked = true;
    $("#content-weight").value = 1;
    $("#content-tags").value = "";
    selectedContentReasons = [];
    renderContentReasonChips();
    $("#btn-content-save").textContent = "存入";
    $("#content-editor-summary").textContent = "添加一条内容";
    $("#btn-content-cancel").hidden = true;
  }

  /* 设置页：新增内容的适用原因多选（不选 = 通用展示） */
  let selectedContentReasons = [];
  let editingContentId = null; // 正在编辑的内容 id（null = 新增模式）
  let contentFilter = "all"; // 内容库筛选：all / enabled / disabled

  function renderContentReasonChips() {
    const wrap = $("#content-reason-chips");
    if (!wrap) return;
    wrap.innerHTML = "";
    REASONS.forEach((r) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = r.label;
      btn.addEventListener("click", () => {
        const i = selectedContentReasons.indexOf(r.id);
        if (i >= 0) {
          selectedContentReasons.splice(i, 1);
          btn.classList.remove("is-on");
        } else {
          selectedContentReasons.push(r.id);
          btn.classList.add("is-on");
        }
      });
      wrap.appendChild(btn);
    });
  }

  function bindSettings() {
    renderContentReasonChips();
    $("#setting-bedtime").addEventListener("change", (e) => {
      DB.setSetting("bedtime", e.target.value);
      renderNightMeta(); // 目标时间改了，夜间页同步
    });
    $("#setting-waketime").addEventListener("change", (e) =>
      DB.setSetting("waketime", e.target.value)
    );

    $("#btn-content-save").addEventListener("click", async () => {
      const text = $("#content-text").value.trim();
      if (!text) return;
      const tags = $("#content-tags")
        .value.split(/[，,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const base = {
        type: $("#content-type").value,
        text,
        source: $("#content-source").value.trim(),
        reasons: [...selectedContentReasons],
        enabled: $("#content-enabled").checked,
        weight: Number($("#content-weight").value) || 1,
        tags,
      };
      if (editingContentId) {
        const orig = (await DB.getAllContent()).find((c) => c.id === editingContentId);
        await DB.updateContent(Object.assign({}, orig, base, { id: editingContentId }));
      } else {
        await DB.addContent(base);
      }
      cancelEditContent();
      renderContentList();
    });

    $("#btn-content-cancel").addEventListener("click", cancelEditContent);

    $("#content-filter").addEventListener("change", (e) => {
      contentFilter = e.target.value;
      renderContentList();
    });

    $("#btn-export").addEventListener("click", async () => {
      const data = await DB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "sleep-ritual-" + todayStr() + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
    });

    $("#file-import").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        await DB.importAll(data);
        await renderSettings();
        alert("导入完成。");
      } catch (err) {
        alert("导入失败：" + err.message);
      }
      e.target.value = "";
    });

    $("#btn-wipe").addEventListener("click", async () => {
      if (!confirm("确定清空所有数据？包括记录和内容库，无法恢复。")) return;
      await DB.wipeAll();
      await DB.seedContentIfEmpty();
      await renderSettings();
      alert("已清空。");
    });
  }

  /* ---------- PWA ---------- */

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;

    const showUpdateBanner = (worker) => {
      const banner = document.getElementById("update-banner");
      const btn = document.getElementById("btn-update-now");
      if (!banner || banner.dataset.shown) return;
      banner.dataset.shown = "1";
      banner.hidden = false;
      btn.onclick = () => {
        if (worker && worker.postMessage) worker.postMessage("SKIP_WAITING");
      };
    };

    const track = (worker) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateBanner(worker);
        }
      });
    };

    const checkBtn = document.getElementById("btn-check-update");
    if (checkBtn) {
      checkBtn.addEventListener("click", () => {
        if (window.__checkForUpdate) {
          window.__checkForUpdate();
          const old = checkBtn.textContent;
          checkBtn.textContent = "已检查";
          setTimeout(() => (checkBtn.textContent = old), 1500);
        }
      });
    }

    // 新 SW 接管后刷新一次，拿到新壳
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      location.reload();
    });

    navigator.serviceWorker
      .register("sw.js")
      .then((reg) => {
        if (reg.installing) track(reg.installing);
        reg.addEventListener("updatefound", () => track(reg.installing));
        window.__checkForUpdate = () => reg.update();
        // 主动询问当前 SW 的 cache 版本，用于设置页版本诊断
        try {
          if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage("GET_CACHE_VERSION");
          }
        } catch (_) {}
      })
      .catch((e) => console.warn("SW 注册失败", e));
  }

  /* ---------- 启动 ---------- */

  async function init() {
    try {
      await DB.ready();
      await DB.seedContentIfEmpty();
      // P0：启动时安全迁移旧数据（补 status 等），保留原 id / date / 时间戳，
      // 幂等且数量守恒校验；失败时记录但不阻断应用启动。
      try {
        const report = await DB.migrateLegacyNightSessions();
        if (report && report.modified) {
          console.info("[migration] 旧数据迁移完成", report);
        } else if (report) {
          console.info("[migration] 无需迁移 / 已迁移过", report);
        }
      } catch (me) {
        console.error("[migration] 旧数据迁移异常（应用继续启动）", me);
      }
      await DB.addEvent({ type: "app_opened", payload: { ts: Date.now() } }).catch(() => {});
    } catch (e) {
      console.error("IndexedDB 初始化失败，应用将以无存储模式运行", e);
    }
    await loadActionTips();
    bindTabs();
    startClock();
    renderNightMeta();
    renderNightContent();
    renderReasonChips();
    bindBrainDump();
    bindSleepButton();
    bindBackToNightFlow();
    bindNightContentShuffle();
    bindMood();
    bindMorningSave();
    bindSettings();
    bindHistoryRange();
    bindHistoryEdit();
    bindDataCheck();
    renderVersionDiagnostics();
    registerSW();

    // 入口来源：集中到 AnchorProvider（平台判断不再散落各处）
    if (window.AnchorProvider) currentSource = window.AnchorProvider.getCurrentSource();
    const deep = window.AnchorProvider ? window.AnchorProvider.parseHash() : { view: null };
    const startView = deep.view && VIEWS.indexOf(deep.view) >= 0 ? deep.view : defaultViewByHour();
    await showView(startView);
    if (startView === "night") {
      if (deep.view === "night") {
        // 显式深链 #/night：强制进入睡前流程（重开今晚会话，避免重复建）
        await enterNightViaDeepLink();
      } else {
        await resumeNightState();
      }
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
