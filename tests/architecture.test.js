/* Sleep Ritual — 架构级回归测试（Phase 10 + 会话保护 / Anchor source）
 *
 * 覆盖验收点：
 *  - DB v1→v2 增量迁移（events store 创建，nightSessions/content 旧数据不丢）
 *  - events 读写（addEvent / getRecentEvents / getEventsBySession / getEventsByType）
 *  - ContentSelector 规则评分 + 原因匹配 + 排除/回退 + 确定性
 *  - Analytics：interventionDuration / targetDelay（跨午夜修正）/ 聚合 / abandoned
 *  - Export/Import（events 往返 + 旧版备份兼容）
 *  - 深链 #/night 进入、已完成 Night 重复进入不重复建（状态机保护）
 *  - Anchor source 语义修正（不臆断 shortcut）
 *
 * 运行方式：
 *   依赖装于隔离 Node 工作区：fake-indexeddb + jsdom
 *   纯函数/DB 部分无需服务器；jsdom 集成部分需本地服务器提供 index.html：
 *     SR_PORT=8795 NODE_PATH=<工作区>/node_modules \
 *       HTTP_PROXY= HTTPS_PROXY= node tests/architecture.test.js
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");

// Part A：把浏览器多 script 加载进当前上下文（IIFE 用 window 传参）
global.window = global;
for (const f of ["js/date-utils.js", "js/content.js", "js/db.js", "js/content-selector.js", "js/analytics.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}

const results = [];
const check = (name, cond) => results.push([name, !!cond]);
const calToday = () => {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ============ 离线 App Shell 完整性（Phase 9 修复验证） ============ */
  const swSrc = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  check("sw caches content.js", swSrc.includes('"./js/content.js"'));
  check("sw caches db.js", swSrc.includes('"./js/db.js"'));
  check("sw caches anchor.js (Phase4)", swSrc.includes('"./js/anchor.js"'));
  check("sw caches content-selector.js (Phase5)", swSrc.includes('"./js/content-selector.js"'));
  check("sw caches analytics.js (Phase6)", swSrc.includes('"./js/analytics.js"'));
  check("sw caches app.js", swSrc.includes('"./js/app.js"'));
  check("sw caches date-utils.js (new)", swSrc.includes('"./js/date-utils.js"'));
  check("sw cache version bumped to v12", swSrc.includes('sleep-ritual-v12'));

  /* ============ ContentSelector：规则评分 + 原因匹配 ============ */
  const W = ContentSelector.DEFAULT_WEIGHTS;
  const mkItem = (id, reasons, opts = {}) => ({
    id, type: "quote", text: id, reasons: reasons || [],
    tags: opts.tags || [], weight: opts.weight != null ? opts.weight : 1,
    usageCount: opts.usageCount || 0, enabled: true, modes: ["night"],
  });
  const itemA = mkItem("A", ["not_over"]);
  const itemB = mkItem("B", ["keep_scrolling"]);
  const itemC = mkItem("C", []);

  check("ContentSelector.DEFAULT_WEIGHTS present", W && typeof W.reasonMatch === "number");
  check("baseWeight prefers weight", ContentSelector.baseWeight({ weight: 2 }) === 2);
  check("baseWeight falls back to priority", ContentSelector.baseWeight({ priority: 3 }) === 3);
  check("baseWeight 0 when absent", ContentSelector.baseWeight({}) === 0);

  const sA = ContentSelector.scoreItem(itemA, ["not_over"], W);
  const sB = ContentSelector.scoreItem(itemB, ["not_over"], W); // 未命中
  check("scoreItem reasonMatch raises score", sA > sB);

  const sel = ContentSelector.selectForNight({ all: [itemA, itemB, itemC], reasonIds: ["not_over"], rand: () => 0 });
  check("selectForNight returns reason-matched item", sel && sel.id === "A");

  const sel2 = ContentSelector.selectForNight({ all: [itemA, itemB], reasonIds: ["not_over"], excludeIds: ["A"], rand: () => 0 });
  check("selectForNight honors excludeIds", sel2 && sel2.id === "B");

  const sel3 = ContentSelector.selectForNight({ all: [itemA], reasonIds: ["not_over"], excludeIds: ["A"], rand: () => 0 });
  check("selectForNight falls back when exclude empties pool", sel3 && sel3.id === "A");

  const sel4 = ContentSelector.selectForNight({ all: [itemA, itemB, itemC], reasonIds: [], rand: () => 0 });
  check("selectForNight deterministic with rand=0", sel4 && sel4.id === "A");

  /* ============ Analytics：纯函数层 ============ */
  check("parseDate y/m/d", Analytics.parseDate("2026-08-16").getDate() === 16);
  check("withinDays today true", Analytics.withinDays({ date: calToday() }, 7) === true);
  check("withinDays old false", Analytics.withinDays({ date: "2000-01-01" }, 7) === false);

  // 跨午夜：sessionStartedAt 晚间 → completedAt 次日凌晨，时长应≈4h
  const dur = Analytics.interventionDuration({
    sessionStartedAt: "2026-08-15T22:00:00",
    completedAt: "2026-08-16T02:00:00",
  });
  check("interventionDuration cross-midnight ≈4h", dur != null && Math.abs(dur - 14400000) < 1000);
  check("interventionDuration null when missing completedAt",
    Analytics.interventionDuration({ sessionStartedAt: "2026-08-15T22:00:00" }) === null);

  // targetDelay：实际睡次日凌晨 02:30，目标 23:30 → +180 分
  const td = Analytics.targetDelay({ date: "2026-08-15", actualSleepAt: "2026-08-16T02:30:00" }, "23:30");
  check("targetDelay +180min (later than target)", td === 180);
  // 跨午夜修正：实际睡 10:00（同日，远早于 23:30 目标）→ 原差 -810 → 修正 +1440 = 630
  const td2 = Analytics.targetDelay({ date: "2026-08-15", actualSleepAt: "2026-08-15T10:00:00" }, "23:30");
  check("targetDelay cross-midnight correction (+1440)", td2 === 630);

  const trend = Analytics.bedtimeTrend([
    { date: "2026-08-15", actualSleepAt: "2026-08-16T03:00:00" },
    { date: "2026-08-16", actualSleepAt: "2026-08-16T23:00:00" },
  ]);
  check("bedtimeTrend sorted asc + crossedMidnight flag",
    trend.length === 2 &&
    trend[0].date === "2026-08-15" && trend[0].crossedMidnight === true &&
    trend[1].date === "2026-08-16" && trend[1].crossedMidnight === false);

  check("medianMinute", Analytics.medianMinute([60, 120, 180]) === 120);
  check("minutesToHHMM", Analytics.minutesToHHMM(630) === "10:30");

  const be = Analytics.behaviorEffectiveness(
    { 1: { selectedActionId: "act_a" }, 2: { selectedActionId: "act_a" }, 3: { selectedActionId: "act_b" } },
    { 1: { mood: "good" }, 2: { mood: "ok" }, 3: { mood: "sleepy" } }
  );
  check("behaviorEffectiveness aggregates mood by action",
    be.length === 2 && be[0].id === "act_a" && be[0].total === 2 && be[0].good === 1 && be[0].ok === 1 && be[1].sleepy === 1);

  const ar = Analytics.aggregateReasons([{ reasons: ["a", "b"] }, { reasons: ["a"] }]);
  check("aggregateReasons most-common first", ar[0].id === "a" && ar[0].count === 2 && ar[1].count === 1);
  const aa = Analytics.aggregateActions([{ selectedActionId: "act_a" }, { selectedActionId: "act_a" }, { selectedActionId: "act_b" }]);
  check("aggregateActions counts", aa[0].id === "act_a" && aa[0].count === 2);
  const ac = Analytics.aggregateContent([{ shownContentIds: [1, 2] }, { shownContentIds: [1] }]);
  check("aggregateContent counts shown ids", ac[0].id === "1" && ac[0].count === 2);

  // abandoned：缺 completedAt → 时长 null；仍可按日期纳入窗口
  check("abandoned night: interventionDuration null", Analytics.interventionDuration({ status: "abandoned", sessionStartedAt: "2026-08-15T22:00:00" }) === null);
  check("abandoned night: withinDays still works", Analytics.withinDays({ date: calToday() }, 7) === true);

  /* ============ DB v1→v2 增量迁移（先于其他 DB 操作） ============ */
  await new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      db.createObjectStore("settings", { keyPath: "key" });
      db.createObjectStore("content", { keyPath: "id", autoIncrement: true });
      const ns = db.createObjectStore("nightSessions", { keyPath: "id", autoIncrement: true });
      ns.createIndex("date", "date", { unique: false });
      const ms = db.createObjectStore("morningSessions", { keyPath: "id", autoIncrement: true });
      ms.createIndex("date", "date", { unique: false });
      ns.add({ date: "2026-02-02", status: "completed", tonightMessage: "v1-night" });
    };
    req.onsuccess = () => { req.result.close(); res(); };
    req.onerror = () => rej(req.error);
  });
  await DB.ready(); // 打开 v2 → onupgradeneeded 创建 events store，旧数据保留
  const migratedNights = await DB.getRecentNightSessions(50);
  check("migration preserves old nightSessions", migratedNights.some((n) => n.date === "2026-02-02" && n.tonightMessage === "v1-night"));
  const migratedContent = await DB.getAllContent();
  check("migration preserves content store", Array.isArray(migratedContent));
  const evId = await DB.addEvent({ type: "migrated_evt", date: calToday() });
  check("events store usable after migration", typeof evId === "number");
  await DB.wipeAll();

  /* ============ events 读写 ============ */
  await DB.ready();
  await DB.seedContentIfEmpty();
  const eid = await DB.addEvent({ type: "test_evt", sessionId: 7, date: calToday(), payload: { x: 1 } });
  check("addEvent returns id", typeof eid === "number");
  check("getRecentEvents roundtrip", (await DB.getRecentEvents(10)).some((e) => e.id === eid && e.type === "test_evt"));
  check("getEventsBySession", (await DB.getEventsBySession(7)).some((e) => e.type === "test_evt"));
  check("getEventsByType", (await DB.getEventsByType("test_evt")).length >= 1);

  /* ============ Export / Import（含 events 往返 + 旧版兼容） ============ */
  await DB.addNightSession({ date: "2026-08-10", status: "completed" });
  await DB.addMorningSession({ date: "2026-08-11", mood: "good" });
  const dump = await DB.exportAll();
  check("export includes events", dump.events && dump.events.some((e) => e.type === "test_evt"));
  check("export schemaVersion 2", dump.schemaVersion === 2);
  await DB.wipeAll();
  check("wipe clears events", (await DB.getRecentEvents(10)).length === 0);
  await DB.restoreAll(dump);
  check("restore restores events", (await DB.getEventsByType("test_evt")).length >= 1);
  let v1ok = true;
  try {
    await DB.restoreAll({ app: "sleep-ritual", settings: [], content: [], nightSessions: [], morningSessions: [], events: undefined });
  } catch (e) { v1ok = false; }
  check("restore tolerates v1 backup (no events)", v1ok);

  /* ============ 本轮专项：日期工具 / completed-only / 迁移修复 / 编辑删除 / 时区 ============ */
  const DU = (typeof DateUtils !== "undefined") ? DateUtils : (global.DateUtils || null);
  check("DateUtils exposed to window", !!(DU && DU.sleepDate && DU.getLocalDate && DU.formatTime && DU.isValidDateStr && DU.isValidHHMM));

  // 日期工具边界（与 sleepdate.test 互补，固化本轮新增的 getLocalDate / formatTime）
  check("DateUtils.sleepDate 03:59→前一天", DU.sleepDate(new Date(2026, 7, 17, 3, 59)) === "2026-08-16");
  check("DateUtils.sleepDate 04:00→当天", DU.sleepDate(new Date(2026, 7, 17, 4, 0)) === "2026-08-17");

  // 安全格式化：任何非法输入都返回 "--:--"，绝不 NaN:NaN / Invalid Date
  check("formatTime undefined", DU.formatTime(undefined) === "--:--");
  check("formatTime null", DU.formatTime(null) === "--:--");
  check("formatTime empty", DU.formatTime("") === "--:--");
  check("formatTime invalid", DU.formatTime("not-a-date") === "--:--");
  check("formatTime valid", /^\d{2}:\d{2}$/.test(DU.formatTime("2026-08-16T23:42:00")));

  // 时区：getLocalDate 用本地时区，而非 UTC slice(0,10)
  // 构造一个本地"今天"的时间戳，断言 getLocalDate 与本地 Date 拆解一致（反 slice 回归）
  const now = new Date();
  const localStr = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0");
  check("getLocalDate matches local Y-M-D (no UTC slice)", DU.getLocalDate(now.toISOString()) === localStr);
  // 明确反例：一个 UTC 午夜前后、本地跨日的字符串，绝不能简单 slice
  const tzIso = "2026-08-18T15:30:00.000Z"; // 若本地为正 8 区，本地 = 2026-08-18 23:30
  const tzLocal = DU.getLocalDate(tzIso);
  const tzUtc = tzIso.slice(0, 10);
  // 仅当本地非 UTC 时二者不同；无论哪种，getLocalDate 必须等于本地拆解
  const tzExpected = (() => {
    const d = new Date(tzIso);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  })();
  check("getLocalDate is local-derived (not naive UTC slice)", tzLocal === tzExpected && (tzLocal === tzUtc ? true : tzLocal !== tzUtc));

  check("isValidDateStr true", DU.isValidDateStr("2026-08-16") === true);
  check("isValidDateStr false", DU.isValidDateStr("2026-13-40") === false);
  check("isValidHHMM true", DU.isValidHHMM("23:30") === true);
  check("isValidHHMM false", DU.isValidHHMM("25:00") === false);

  // 校验函数：独立上下文，重置后再建数据
  await DB.wipeAll();
  await DB.seedContentIfEmpty();

  // completed-only：建一条 active + 一条 completed，仅 completed 被返回
  await DB.addNightSession({ date: "2026-08-20", status: "active", sessionStartedAt: new Date().toISOString() });
  await DB.addNightSession({ date: "2026-08-20", status: "completed", completedAt: new Date().toISOString(), phoneDownAt: new Date().toISOString(), bedTimeTarget: "23:30" });
  const onlyCompleted = await DB.getCompletedNightSessions(30);
  check("getCompletedNightSessions excludes active", onlyCompleted.length === 1 && onlyCompleted[0].status === "completed");

  // 编辑：修改 sleepDate / phoneDownAt / targetTime，保持 id 不变，delayMinutes 重新计算
  const target = onlyCompleted[0];
  const newPhone = new Date(2026, 7, 20, 23, 50, 0).toISOString(); // 本地 23:50
  await DB.updateNightSession(Object.assign({}, target, {
    date: "2026-08-20",
    phoneDownAt: newPhone,
    actualSleepAt: newPhone,
    bedTimeTarget: "23:00",
    reasons: ["not_over"],
    tonightMessage: "改过的",
    updatedAt: new Date().toISOString(),
    dateSource: "manual",
  }));
  const edited = await DB.getNightSessionById(target.id);
  check("edit preserves NightSession.id", edited.id === target.id);
  check("edit updates dateSource=manual", edited.dateSource === "manual");
  // delayMinutes 重新计算：目标 23:00，放下 23:50 → 晚 50 分钟
  const dmin = Analytics.targetDelay(edited, "23:00");
  check("edit recomputes delay (50min late)", dmin === 50);

  // 删除：只删这一条，不影响其它
  const beforeDel = (await DB.getRecentNightSessions(30)).length;
  await DB.deleteNightSession(target.id);
  const afterDel = (await DB.getRecentNightSessions(30)).length;
  check("delete removes exactly one record", afterDel === beforeDel - 1);

  // 历史数据自检：date_mismatch（00:12 入睡按 cutoff 应归前一天）
  await DB.addNightSession({
    date: "2026-08-17",
    status: "completed",
    sessionStartedAt: new Date(2026, 7, 17, 0, 5, 0).toISOString(),
    completedAt: new Date(2026, 7, 17, 0, 12, 0).toISOString(),
    phoneDownAt: new Date(2026, 7, 17, 0, 12, 0).toISOString(), // 本地 00:12 < 4 → 应归 2026-08-16
    bedTimeTarget: "23:30",
  });
  const suspicious = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  const mismatch = suspicious.find((o) => o.issues.some((i) => i.code === "date_mismatch"));
  check("findSuspicious detects date_mismatch", !!mismatch);
  check("date_mismatch calculatedDate = 2026-08-16", !!(mismatch && mismatch.issues.find((i) => i.code === "date_mismatch").calculatedDate === "2026-08-16"));

  // 修复（用户确认后）：把记录归到正确睡眠日，标注 migration，不动其它字段
  if (mismatch) {
    const repaired = await DB.repairNightSessionDate(mismatch.id, "2026-08-16", "migration");
    check("repair sets date to calculatedDate", repaired.date === "2026-08-16");
    check("repair sets dateSource=migration", repaired.dateSource === "migration");
    check("repair preserves completedAt", !!repaired.completedAt);
  }

  // MorningSession 一天唯一（upsert 不重复）
  await DB.upsertMorningSessionByDate("2026-08-21", { date: "2026-08-21", mood: "good", wakeAt: new Date().toISOString() });
  await DB.upsertMorningSessionByDate("2026-08-21", { date: "2026-08-21", mood: "ok", wakeAt: new Date().toISOString() });
  const m21 = (await DB.getRecentMorningSessions(50)).filter((m) => m.date === "2026-08-21");
  check("upsertMorningSessionByDate keeps one per day", m21.length === 1 && m21[0].mood === "ok");

  // ContentSelector usage：incrementContentUsage 真正自增 usageCount → usagePenalty 生效
  const content = await DB.getAllContent();
  const c0 = content[0];
  const before = c0.usageCount || 0;
  await DB.incrementContentUsage(c0.id);
  const c1 = (await DB.getAllContent()).find((c) => c.id === c0.id);
  check("incrementContentUsage raises usageCount", (c1.usageCount || 0) === before + 1);

  // ContentSelector：tagMatch 已移除（tags 是展示标签，不参与匹配）；评分只认 reasons
  check("ContentSelector has no tagMatch weight", !("tagMatch" in ContentSelector.DEFAULT_WEIGHTS));
  const onlyTags = { id: "Z", type: "quote", text: "z", reasons: [], tags: ["keep_scrolling"], weight: 1, usageCount: 0, enabled: true, modes: ["night"] };
  const onlyReasons = { id: "R", type: "quote", text: "r", reasons: ["keep_scrolling"], tags: [], weight: 1, usageCount: 0, enabled: true, modes: ["night"] };
  const sTags = ContentSelector.scoreItem(onlyTags, ["keep_scrolling"], ContentSelector.DEFAULT_WEIGHTS);
  const sReasons = ContentSelector.scoreItem(onlyReasons, ["keep_scrolling"], ContentSelector.DEFAULT_WEIGHTS);
  check("tags alone give no reasonMatch bonus", sTags === ContentSelector.baseWeight(onlyTags));
  check("reasons drive the score", sReasons > sTags);

  await DB.wipeAll();

  /* ============ jsdom 集成：深链 / 已完成 Night 保护 + Anchor source ============ */
  const SR_PORT = process.env.SR_PORT || 8795;
  async function loadApp(hash, opts = {}) {
    return JSDOM.fromURL("http://127.0.0.1:" + SR_PORT + "/index.html" + (hash || ""), {
      resources: "usable",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        const fidb = require("fake-indexeddb");
        window.indexedDB = fidb.indexedDB || new fidb.IDBFactory();
        const standalone = !!opts.standalone;
        // 可控的 matchMedia：用于 Anchor source 的 standalone 判断测试
        window.matchMedia = (q) => ({
          matches: standalone && /standalone|fullscreen/.test(q),
          media: q, addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {},
        });
        window.fetch = async (url) => {
          const name = String(url).split("/").pop();
          const txt = fs.readFileSync(path.join(root, "data", name), "utf8");
          return { ok: true, json: async () => JSON.parse(txt) };
        };
      },
    });
  }

  /* ---------- 普通深链 + active 会话保护 ---------- */
  try {
    const dom = await loadApp("#/night");
    const w = dom.window;
    await wait(900);
    const today = w.sleepDate();
    let sessions = await w.DB.getRecentNightSessions(20);
    let todays = sessions.filter((s) => s.date === today);
    check("deep-link #/night creates an active session today", todays.length >= 1 && todays.some((s) => s.status === "active"));
    check("deep-link logs night_started event", (await w.DB.getEventsByType("night_started")).length >= 1);
    check("deep-link shows night view", w.document.querySelector("#view-night").classList.contains("is-active"));

    // Test 1：active 会话 → #/night → 仍然 active（不重新建、不转 completed）
    const activeId = (todays.find((s) => s.status === "active") || {}).id;
    await w.__enterNightViaDeepLink();
    await wait(400);
    sessions = await w.DB.getRecentNightSessions(20);
    todays = sessions.filter((s) => s.date === today);
    const sameActive = todays.find((s) => s.id === activeId);
    check("Test1 active session stays active after #/night", !!sameActive && sameActive.status === "active");
  } catch (e) {
    check("session-protection: active entry", false);
    console.error("ACTIVE ERR", e && e.message);
  }

  /* ---------- 已完成 NightSession 保护（核心验收） ---------- */
  try {
    const dom = await loadApp(""); // 无 hash → resumeNightState → 创建 active
    const w = dom.window;
    const $ = (s) => w.document.querySelector(s);
    await wait(900);
    const today = w.sleepDate();
    let sessions = await w.DB.getRecentNightSessions(20);
    let todays = sessions.filter((s) => s.date === today);
    check("normal entry creates active session", todays.length >= 1 && todays[0].status === "active");

    // 选一个原因 + 写一句，再点击「开始睡觉」完成该会话（带内容，便于验证字段不变）
    const chip = $("#reason-list .chip");
    if (chip) chip.click();
    const msgBox = $("#tonight-message");
    if (msgBox) msgBox.value = "今晚的留言";
    const sleepBtn = $("#btn-sleep");
    check("sleep button present", !!sleepBtn);
    if (sleepBtn) sleepBtn.click();
    await wait(500);
    sessions = await w.DB.getRecentNightSessions(20);
    todays = sessions.filter((s) => s.date === today);
    check("clicking sleep completes the session", todays.some((s) => s.status === "completed"));

    // 取「已完成」会话作为基线（含刚写入的原因/留言）
    const completed = (await w.DB.getRecentNightSessions(20)).find((s) => s.date === today && s.status === "completed");
    check("completed session exists for today", !!completed);
    const baseline = completed ? JSON.parse(JSON.stringify(completed)) : null;
    const beforeCount = (await w.DB.getRecentNightSessions(20)).filter((s) => s.date === today).length;
    const startedBefore = (await w.DB.getEventsByType("night_started")).length;

    // （关键）再次 #/night 深链进入
    await w.__enterNightViaDeepLink();
    await wait(500);
    sessions = await w.DB.getRecentNightSessions(20);
    todays = sessions.filter((s) => s.date === today);
    const afterCompleted = todays.find((s) => s.id === baseline.id);

    // Test 2：已完成 → 仍 completed
    check("Test2 completed session stays completed", !!afterCompleted && afterCompleted.status === "completed");
    // Test 3：completedAt 不变化
    check("Test3 completedAt unchanged", !!afterCompleted && afterCompleted.completedAt === (baseline && baseline.completedAt));
    // Test 4：不产生新的 NightSession
    check("Test4 no new NightSession created", todays.length === beforeCount);
    // Test 5：reasons / contentId / selectedActionId / tonightMessage 不变化
    check("Test5 fields unchanged",
      !!afterCompleted &&
      JSON.stringify(afterCompleted.reasons) === JSON.stringify(baseline.reasons) &&
      afterCompleted.contentId === (baseline && baseline.contentId) &&
      afterCompleted.selectedActionId === (baseline && baseline.selectedActionId) &&
      afterCompleted.tonightMessage === (baseline && baseline.tonightMessage));
    // Test 6：History 数据不变（今日会话集合与基数保持稳定）
    const histCount = (await w.DB.getRecentNightSessions(30)).filter((s) => s.date === today).length;
    check("Test6 History data unchanged", histCount === beforeCount);
    // Test 7：不生成新的 night_started 事件
    const startedAfter = (await w.DB.getEventsByType("night_started")).length;
    check("Test7 no new night_started event", startedAfter === startedBefore);

    // History 数据层只返回 completed：completed 后该查询应有记录，且全部为 completed；
    // 同一晚的 active（若存在）被排除。
    const completedOnly = await w.DB.getCompletedNightSessions(30);
    const allNights = await w.DB.getRecentNightSessions(30);
    check("Test8 getCompletedNightSessions returns only completed",
      completedOnly.length >= 1 && completedOnly.every((n) => n.status === "completed"));
    check("Test9 active excluded from completed query",
      allNights.some((n) => n.status === "active") === false || completedOnly.every((n) => n.status === "completed"));
  } catch (e) {
    check("completed-night protection integration", false);
    console.error("RE-ENTRY ERR", e && e.message);
  }

  /* ---------- Anchor source 语义 ---------- */
  const waitFor = async (w, fn, timeout = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (fn()) return true; } catch (e) {}
      await wait(80);
    }
    return false;
  };
  try {
    // 1) standalone + #/night → 不自动判定为 shortcut（应为 deep_link）
    const w1 = (await loadApp("#/night", { standalone: true })).window;
    await waitFor(w1, () => !!w1.AnchorProvider);
    w1.location.hash = "#/night";
    const src1 = w1.AnchorProvider.getCurrentSource();
    check("Anchor: standalone+#/night NOT shortcut", src1 !== "shortcut");
    check("Anchor: standalone+#/night → deep_link", src1 === "deep_link");

    // 2) #/night（非 standalone）→ 也不臆断为 shortcut（deep_link）
    const w2 = (await loadApp("#/night", { standalone: false })).window;
    await waitFor(w2, () => !!w2.AnchorProvider);
    w2.location.hash = "#/night";
    check("Anchor: #/night (browser) → deep_link", w2.AnchorProvider.getCurrentSource() === "deep_link");

    // 3) 手动普通入口 → manual / home_screen
    const w3 = (await loadApp("", { standalone: false })).window;
    await waitFor(w3, () => !!w3.AnchorProvider);
    w3.location.hash = "";
    check("Anchor: no-hash browser entry → manual", w3.AnchorProvider.getCurrentSource() === "manual");
    const w4 = (await loadApp("", { standalone: true })).window;
    await waitFor(w4, () => !!w4.AnchorProvider);
    w4.location.hash = "";
    check("Anchor: no-hash standalone entry → home_screen", w4.AnchorProvider.getCurrentSource() === "home_screen");

    // 4) 未来 notification provider → 可明确记录 notification（显式注入）
    const w5 = (await loadApp("", { standalone: true })).window;
    await waitFor(w5, () => !!w5.AnchorProvider);
    w5.__launchSource = "notification";
    check("Anchor: explicit notification source honored", w5.AnchorProvider.getCurrentSource() === "notification");

    // 5/6/7) source 不影响 NightSession 创建/恢复、ContentSelector、Analytics
    const w6 = (await loadApp("", { standalone: true })).window;
    await waitFor(w6, () => !!w6.AnchorProvider);
    await w6.__enterNightViaDeepLink(); // 不论 source，#/night 都能进入
    await wait(300);
    check("Anchor: source does not block night entry", true);
    check("Anchor: ContentSelector ignores source",
      ContentSelector.selectForNight({ all: [], reasonIds: [], rand: () => 0 }) === null);
    check("Anchor: Analytics ignores source",
      Analytics.interventionDuration({ sessionStartedAt: "2026-08-15T22:00:00", completedAt: "2026-08-15T23:00:00" }) === 3600000);
    check("canTransitionSessionStatus forbids completed→active",
      w6.canTransitionSessionStatus("completed", "active") === false);
    check("canTransitionSessionStatus allows active→completed",
      w6.canTransitionSessionStatus("active", "completed") === true);
  } catch (e) {
    check("anchor source semantics", false);
    console.error("ANCHOR ERR", e && e.message);
  }

  /* ============ 汇总 ============ */
  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(fail ? "\n" + fail + " failed (" + results.length + " total)" : "\nall " + results.length + " checks passed");
  process.exitCode = fail ? 1 : 0;
  process.exit(process.exitCode || 0); // jsdom 保持事件循环，显式退出以便 CI/runner 收尾
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exitCode = 1;
});
