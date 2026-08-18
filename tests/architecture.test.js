/* Sleep Ritual — 架构级回归测试（Phase 10）
 *
 * 覆盖验收点：
 *  - DB v1→v2 增量迁移（events store 创建，nightSessions/content 旧数据不丢）
 *  - events 读写（addEvent / getRecentEvents / getEventsBySession / getEventsByType）
 *  - ContentSelector 规则评分 + 原因匹配 + 排除/回退 + 确定性
 *  - Analytics：interventionDuration / targetDelay（跨午夜修正）/ 聚合 / abandoned
 *  - Export/Import（events 往返 + 旧版备份兼容）
 *  - 深链 #/night 进入、已完成 Night 重复进入不重复建
 *  - 离线 App Shell 完整性（sw.js 预缓存所有 JS 模块）
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
for (const f of ["js/content.js", "js/db.js", "js/content-selector.js", "js/analytics.js"]) {
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
  check("sw cache version bumped to v10", swSrc.includes('sleep-ritual-v10'));

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
  await DB.importAll(dump);
  check("import restores events", (await DB.getEventsByType("test_evt")).length >= 1);
  let v1ok = true;
  try {
    await DB.importAll({ app: "sleep-ritual", settings: [], content: [], nightSessions: [], morningSessions: [], events: undefined });
  } catch (e) { v1ok = false; }
  check("import tolerates v1 backup (no events)", v1ok);

  /* ============ jsdom 集成：深链 #/night + 已完成 Night 重复进入 ============ */
  const SR_PORT = process.env.SR_PORT || 8795;
  async function loadApp(hash) {
    return JSDOM.fromURL("http://127.0.0.1:" + SR_PORT + "/index.html" + (hash || ""), {
      resources: "usable",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        const fidb = require("fake-indexeddb");
        window.indexedDB = fidb.indexedDB || new fidb.IDBFactory();
        window.fetch = async (url) => {
          const name = String(url).split("/").pop();
          const txt = fs.readFileSync(path.join(root, "data", name), "utf8");
          return { ok: true, json: async () => JSON.parse(txt) };
        };
      },
    });
  }

  // 深链 #/night
  try {
    const dom = await loadApp("#/night");
    const w = dom.window;
    const $ = (s) => w.document.querySelector(s);
    await wait(900);
    const today = w.sleepDate();
    const sessions = await w.DB.getRecentNightSessions(20);
    const todays = sessions.filter((s) => s.date === today);
    check("deep-link #/night creates a night session for today", todays.length >= 1);
    check("deep-link session is active (no dup/completed)", todays.some((s) => s.status === "active"));
    check("deep-link logs night_started event", (await w.DB.getEventsByType("night_started")).length >= 1);
    check("deep-link shows night view", $("#view-night") && $("#view-night").classList.contains("is-active"));
  } catch (e) {
    check("deep-link #/night integration", false);
    console.error("DEEP-LINK ERR", e && e.message);
  }

  // 已完成 Night 重复进入不重复建
  try {
    const dom = await loadApp(""); // 无 hash → resumeNightState
    const w = dom.window;
    const $ = (s) => w.document.querySelector(s);
    await wait(900);
    const today = w.sleepDate();
    let sessions = await w.DB.getRecentNightSessions(20);
    let todays = sessions.filter((s) => s.date === today);
    check("normal entry creates active session", todays.length >= 1 && todays[0].status === "active");
    const beforeCount = todays.length;
    const sleepBtn = $("#btn-sleep");
    check("sleep button present", !!sleepBtn);
    if (sleepBtn) sleepBtn.click();
    await wait(500);
    sessions = await w.DB.getRecentNightSessions(20);
    todays = sessions.filter((s) => s.date === today);
    check("clicking sleep completes the session", todays.length >= 1 && todays[0].status === "completed");
    await w.__enterNightViaDeepLink(); // 模拟再次深链进入
    await wait(500);
    sessions = await w.DB.getRecentNightSessions(20);
    todays = sessions.filter((s) => s.date === today);
    check("re-entry does NOT create a duplicate session", todays.length === beforeCount);
    check("re-entry reopens same session as active", todays.some((s) => s.status === "active"));
    check("re-entry logs night_reopened event", (await w.DB.getEventsByType("night_reopened")).length >= 1);
  } catch (e) {
    check("completed-night re-entry integration", false);
    console.error("RE-ENTRY ERR", e && e.message);
  }

  /* ============ 汇总 ============ */
  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(fail ? "\n" + fail + " failed (" + results.length + " total)" : "\nall " + results.length + " checks passed");
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exitCode = 1;
});
