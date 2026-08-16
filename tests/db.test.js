/* Sleep Ritual 数据层回归测试（fake-indexeddb + 真实 db.js/content.js）
 *
 * 运行方式（依赖装在隔离 Node 工作区，不进项目）：
 *   npm install fake-indexeddb   # 在隔离工作区
 *   NODE_PATH=<工作区>/node_modules node tests/db.test.js
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = "D:/GitHub Space/sleepearly";
// content.js 与 db.js 以脚本方式加载到当前上下文（模拟浏览器多 script 标签）
for (const f of ["js/content.js", "js/db.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

(async () => {
  /* ---- 初始化与种子 ---- */
  await DB.ready();
  await DB.seedContentIfEmpty();
  let content = await DB.getAllContent();
  check("seed content written", content.length === SEED_CONTENT.length);
  check("seed items have auto ids", content.every((c) => typeof c.id === "number"));
  await DB.seedContentIfEmpty();
  content = await DB.getAllContent();
  check("seed is idempotent", content.length === SEED_CONTENT.length);

  /* ---- UserSettings ---- */
  check("setting default fallback", (await DB.getSetting("bedtime", "23:30")) === "23:30");
  await DB.setSetting("bedtime", "00:15");
  await DB.setSetting("waketime", "06:50");
  check("setting persisted", (await DB.getSetting("bedtime")) === "00:15");
  await DB.setSetting("bedtime", "23:45");
  check("setting overwrite", (await DB.getSetting("bedtime")) === "23:45");

  /* ---- Content 增删 ---- */
  await DB.addContent({ type: "quote", text: "测试内容", source: "test" });
  content = await DB.getAllContent();
  check("content add", content.length === SEED_CONTENT.length + 1);
  const added = content.find((c) => c.text === "测试内容");
  check("content createdAt", !!added.createdAt);
  await DB.deleteContent(added.id);
  content = await DB.getAllContent();
  check("content delete", content.length === SEED_CONTENT.length);

  /* ---- NightSession ---- */
  const night1 = {
    date: "2026-08-15",
    bedTimeTarget: "23:45",
    shownAt: "2026-08-15T15:20:00.000Z",
    actualSleepAt: "2026-08-15T16:02:00.000Z",
    contentId: 1,
    reasons: ["keep_scrolling", "not_over"],
    behaviorTip: "先把手机放远 1 米，够不到就行。",
    tonightMessage: "明天见",
  };
  const night2 = { ...night1, date: "2026-08-16", actualSleepAt: "2026-08-16T15:40:00.000Z", tonightMessage: "第二晚" };
  await DB.addNightSession(night1);
  await DB.addNightSession(night2);
  const nights = await DB.getRecentNightSessions(30);
  check("night sessions saved", nights.length === 2);
  check("night sorted desc by date", nights[0].date === "2026-08-16");
  check("night reasons roundtrip", JSON.stringify(nights[0].reasons) === JSON.stringify(["keep_scrolling", "not_over"]));
  const latest = await DB.getLatestNightSession();
  check("latest night session", latest.date === "2026-08-16" && latest.tonightMessage === "第二晚");
  const limited = await DB.getRecentNightSessions(1);
  check("limit works", limited.length === 1);

  /* ---- MorningSession ---- */
  await DB.addMorningSession({ date: "2026-08-16", mood: "good", morningMessage: "加油", createdAt: "2026-08-16T01:00:00.000Z" });
  const mornings = await DB.getRecentMorningSessions(30);
  check("morning saved", mornings.length === 1 && mornings[0].mood === "good");

  /* ---- 导出 ---- */
  const dump = await DB.exportAll();
  check("export marker", dump.app === "sleep-ritual" && dump.version === 1);
  check("export settings", dump.settings.length === 2);
  check("export content", dump.content.length === SEED_CONTENT.length);
  check("export nights", dump.nightSessions.length === 2);
  check("export mornings", dump.morningSessions.length === 1);
  const json = JSON.stringify(dump);
  check("export serializable", json.length > 100);

  /* ---- 导入往返：清空 → 导入 → 校验 ---- */
  await DB.wipeAll();
  check("wipe empties nights", (await DB.getRecentNightSessions(30)).length === 0);
  check("wipe empties settings", (await DB.getSetting("bedtime")) === null);
  const restored = JSON.parse(json);
  await DB.importAll(restored);
  check("import settings", (await DB.getSetting("bedtime")) === "23:45");
  check("import nights", (await DB.getRecentNightSessions(30)).length === 2);
  check("import mornings", (await DB.getRecentMorningSessions(30)).length === 1);
  check("import content", (await DB.getAllContent()).length === SEED_CONTENT.length);
  const latestAfter = await DB.getLatestNightSession();
  check("roundtrip latest intact", latestAfter.tonightMessage === "第二晚");

  /* ---- 导入校验：坏文件拒绝 ---- */
  let rejected = false;
  try {
    await DB.importAll({ hello: "world" });
  } catch (e) {
    rejected = true;
  }
  check("bad import rejected", rejected);

  /* ---- 清空后重播种 ---- */
  await DB.wipeAll();
  await DB.seedContentIfEmpty();
  check("reseed after wipe", (await DB.getAllContent()).length === SEED_CONTENT.length);

  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(fail ? "\n" + fail + " failed" : "\nall " + results.length + " checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exit(1);
});
