/* ============================================================
   Sleep Ritual — 主逻辑 v2（第二阶段）
   范围：Night / Morning 完整交互；History / Settings 保持骨架。
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 小工具 ---------- */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function nowHHMM(d = new Date()) {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function todayStr(d = new Date()) {
    return (
      d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0")
    );
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
  }

  /* 从内容池中按规则选取一条：
     1. enabled 为 true（默认 true）
     2. modes 含 "night"（缺省视为 night）
     3. 命中所给 reasonIds 之一（reasonIds 为空 = 通用池）
     4. 排除 excludeIds（最近展示过 / 本次会话展示过），池子空了则回退不过滤
     5. 优先 priority 更大的；同优先级随机 */
  function pickContent(all, reasonIds, excludeIds = null) {
    const filtered = all.filter(
      (c) =>
        c.enabled !== false &&
        (!c.modes || c.modes.includes("night")) &&
        (!reasonIds || !reasonIds.length
          ? true
          : (c.reasons || []).some((r) => reasonIds.includes(r)))
    );
    let pool = filtered;
    if (excludeIds && excludeIds.size) {
      const rest = filtered.filter((c) => !excludeIds.has(c.id));
      if (rest.length) pool = rest;
    }
    if (!pool.length) return null;
    const maxPri = Math.max(...pool.map((c) => c.priority ?? 0));
    const top = pool.filter((c) => (c.priority ?? 0) === maxPri);
    return top[Math.floor(Math.random() * top.length)];
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
  }

  let brainDumpUsed = false; // 本次夜间流程是否用过「丢掉」（只记标志，不存内容）

  function bindBrainDump() {
    const input = $("#braindump-input");
    $("#braindump-clear").addEventListener("click", () => {
      if (!input.value.trim()) return;
      // 不保存，只做轻微淡出反馈
      brainDumpUsed = true;
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
      const session = {
        date: todayStr(),
        bedTimeTarget: await DB.getSetting("bedtime", "23:30").catch(() => "23:30"),
        shownAt: nightShownAt,
        actualSleepAt: new Date().toISOString(),
        contentId: shownContentId,
        shownContentIds: shownContentId ? [shownContentId] : [],
        reasons: [...selectedReasons],
        selectedActionId: firstReason ? ACTION_IDS[firstReason] || null : null,
        behaviorTip: firstReason ? ACTION_TIPS[firstReason] : null,
        brainDumpUsed,
        tonightMessage: $("#tonight-message").value.trim() || null,
        sleepTownAttempted: true, // 点击开始睡觉即发起跳转尝试（能否成功无法可靠检测）
      };
      try {
        await DB.addNightSession(session);
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
    const attemptAt = Date.now();
    window.location.href = "sleeptown://";
    setTimeout(() => {
      // 2.2 秒后页面仍可见 → 大概率没有唤起，显示手动提示
      if (!document.hidden && Date.now() - attemptAt < 2600) {
        const hint = $("#sleeptown-hint");
        if (hint) hint.hidden = false;
      }
    }, 2200);
  }

  /* 今天已经记录过 → 直接进入晚安终态，避免重复填写、减少停留 */
  async function resumeNightState() {
    nightShownAt = new Date().toISOString();
    try {
      const last = await DB.getLatestNightSession();
      if (last && last.date === todayStr()) {
        showGoodnight();
      } else {
        showNightFlow();
      }
    } catch (e) {
      showNightFlow();
    }
  }

  /* ---------- MORNING ---------- */

  let selectedMood = null;

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
    const last = await DB.getLatestNightSession().catch(() => null);
    // 只在「最近 18 小时内」的夜间记录才算"昨晚"，避免展示几天前的旧数据
    const fresh =
      last && Date.now() - new Date(last.actualSleepAt).getTime() < 18 * 3600 * 1000;
    if (fresh) {
      const d = new Date(last.actualSleepAt);
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
      };
      try {
        await DB.addMorningSession(session);
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
    if (!session.bedTimeTarget || !session.actualSleepAt) return null;
    const [th, tm] = session.bedTimeTarget.split(":").map(Number);
    const target = th * 60 + tm;
    const d = new Date(session.actualSleepAt);
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

  async function renderHistory() {
    const [nights, mornings] = await Promise.all([
      DB.getRecentNightSessions(30).catch(() => []),
      DB.getRecentMorningSessions(30).catch(() => []),
    ]);
    const morningByDate = {};
    mornings.forEach((m) => (morningByDate[m.date] = m));

    renderHistoryTrend(nights);

    const wrap = $("#history-list");
    wrap.innerHTML = "";
    $("#history-empty").hidden = nights.length > 0;

    nights.forEach((n) => {
      const div = document.createElement("div");
      div.className = "history-item";

      const actual = new Date(n.actualSleepAt);
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
      line.innerHTML =
        `<span class="h-label">放下手机</span>${nowHHMM(actual)}` +
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
      const m = morningByDate[n.date];
      if (m && (m.morningMessage || m.mood)) {
        const mo = document.createElement("div");
        const moodIcon = { good: "🙂", ok: "😐", sleepy: "😴" }[m.mood] || "";
        mo.innerHTML =
          `<span class="h-label">早晨</span>${moodIcon} ` + (m.morningMessage || "");
        div.appendChild(mo);
      }
      wrap.appendChild(div);
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
    all.forEach((item) => {
      const row = document.createElement("div");
      row.className = "content-row";

      const type = document.createElement("span");
      type.className = "c-type";
      type.textContent = CONTENT_TYPE_NAMES[item.type] || item.type;

      const text = document.createElement("span");
      text.className = "c-text";
      text.textContent = item.text;

      const del = document.createElement("button");
      del.className = "c-del";
      del.type = "button";
      del.textContent = "×";
      del.title = "删除";
      del.addEventListener("click", async () => {
        await DB.deleteContent(item.id);
        renderContentList();
      });

      row.appendChild(type);
      row.appendChild(text);
      row.appendChild(del);
      wrap.appendChild(row);
    });
  }

  /* 设置页：新增内容的适用原因多选（不选 = 通用展示） */
  let selectedContentReasons = [];

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

    $("#btn-content-add").addEventListener("click", async () => {
      const text = $("#content-text").value.trim();
      if (!text) return;
      await DB.addContent({
        type: $("#content-type").value,
        text,
        source: $("#content-source").value.trim(),
        reasons: [...selectedContentReasons],
        enabled: true,
      });
      $("#content-text").value = "";
      $("#content-source").value = "";
      selectedContentReasons = [];
      renderContentReasonChips();
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
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch((e) =>
        console.warn("SW 注册失败", e)
      );
    }
  }

  /* ---------- 启动 ---------- */

  async function init() {
    try {
      await DB.ready();
      await DB.seedContentIfEmpty();
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
    bindMood();
    bindMorningSave();
    bindSettings();
    registerSW();

    const fromHash = location.hash.replace("#/", "");
    const view = VIEWS.includes(fromHash) ? fromHash : defaultViewByHour();
    await showView(view);
    if (view === "night") await resumeNightState();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
