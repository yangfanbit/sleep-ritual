/* Sleep Ritual — Restore（数据恢复）专项测试
 *
 * 覆盖要求：
 *  - validateBackup：合法备份通过；非法 JSON/app/schemaVersion/数组/字段类型 被拒绝
 *  - restoreAll：合法备份整体覆盖（数量守恒）；非法/不支持版本在触碰 DB 前拒绝，
 *    当前数据不被改动（恢复失败安全）
 *  - normalizeBackup：旧版（无 events）兜底为空数组
 *
 * 运行：
 *   NODE_PATH=<工作区>/node_modules node tests/restore.test.js
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
global.window = global;
for (const f of ["js/date-utils.js", "js/content.js", "js/db.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

(async () => {
  /* ===== validateBackup ===== */
  // 构造一份合法备份（模仿 exportAll 结构）
  const good = {
    app: "sleep-ritual",
    schemaVersion: 2,
    version: 2,
    settings: [{ key: "bedtime", value: "23:30" }],
    content: [{ id: 1, type: "quote", text: "x", reasons: [], tags: [], weight: 1, usageCount: 0, enabled: true }],
    nightSessions: [{ id: 1, date: "2026-08-20", status: "completed" }],
    morningSessions: [{ id: 1, date: "2026-08-21", mood: "good" }],
    events: [{ id: 1, type: "test", date: "2026-08-20" }],
  };
  const v1 = DB.validateBackup(good);
  check("validateBackup valid ok", v1.ok === true);
  check("validateBackup summary.night=1", v1.summary && v1.summary.night === 1);
  check("validateBackup summary.events=1", v1.summary && v1.summary.events === 1);

  check("validateBackup rejects non-object", DB.validateBackup("nope").ok === false);
  check("validateBackup rejects wrong app", DB.validateBackup({ app: "other", schemaVersion: 2, settings: [], content: [], nightSessions: [], morningSessions: [], events: [] }).ok === false);
  check("validateBackup rejects unsupported version", DB.validateBackup(Object.assign({}, good, { schemaVersion: 99 })).ok === false);
  check("validateBackup rejects non-array nightSessions", DB.validateBackup(Object.assign({}, good, { nightSessions: "x" })).ok === false);
  check("validateBackup rejects missing field in night", DB.validateBackup(Object.assign({}, good, { nightSessions: [{ id: 1 }] })).ok === false);
  check("validateBackup allows missing events (v1)", DB.validateBackup({ app: "sleep-ritual", schemaVersion: 1, settings: [], content: [], nightSessions: [], morningSessions: [] }).ok === true);

  /* ===== normalizeBackup ===== */
  const norm = DB.normalizeBackup({ app: "sleep-ritual", schemaVersion: 1, settings: [], content: [], nightSessions: [{ id: 1, date: "2026-08-20" }], morningSessions: [] });
  check("normalizeBackup fills events for v1", Array.isArray(norm.events) && norm.events.length === 0);
  check("normalizeBackup keeps nightSessions", norm.nightSessions.length === 1);

  /* ===== restoreAll ===== */
  await DB.ready();
  await DB.wipeAll();

  // 先放一些「当前数据」，用于验证恢复后整体覆盖 + 失败时不破坏
  await DB.addNightSession({ date: "2026-08-01", status: "completed", actualSleepAt: "2026-08-01T23:00:00.000Z", phoneDownAt: "2026-08-01T23:00:00.000Z", sessionStartedAt: "2026-08-01T22:30:00.000Z", completedAt: "2026-08-01T23:00:00.000Z", bedTimeTarget: "23:30", reasons: [] });

  // 合法恢复：用 good 备份整体覆盖
  const rs = await DB.restoreAll(good);
  check("restoreAll returns ok", rs.ok === true);
  check("restoreAll nights replaced to 1", (await DB.getRecentNightSessions(30)).length === 1);
  check("restoreAll mornings replaced to 1", (await DB.getRecentMorningSessions(30)).length === 1);
  check("restoreAll events replaced to 1", (await DB.getRecentEvents(10)).length === 1);
  const exported = await DB.exportAll();
  check("restoreAll count-conservation (nights)", exported.nightSessions.length === good.nightSessions.length);
  check("restoreAll count-conservation (events)", exported.events.length === good.events.length);
  check("restoreAll backed up current to lastRestoreBackup", !!(await DB.getSetting("lastRestoreBackup")));

  // 失败安全：非法备份在触碰 DB 前抛错，当前数据不变
  const beforeFail = (await DB.getRecentNightSessions(30)).length;
  let threw = false;
  try {
    await DB.restoreAll({ hello: "world" });
  } catch (e) { threw = true; }
  check("restoreAll invalid throws", threw);
  check("restoreAll invalid leaves data intact", (await DB.getRecentNightSessions(30)).length === beforeFail);

  // 不支持版本：同样在触碰 DB 前抛错
  let threwVer = false;
  try {
    await DB.restoreAll(Object.assign({}, good, { schemaVersion: 99 }));
  } catch (e) { threwVer = true; }
  check("restoreAll unsupported version throws", threwVer);
  check("restoreAll unsupported version leaves data intact", (await DB.getRecentNightSessions(30)).length === beforeFail);

  // v1 备份（无 events）可恢复
  const v1backup = { app: "sleep-ritual", schemaVersion: 1, settings: [{ key: "bedtime", value: "22:00" }], content: [], nightSessions: [{ date: "2026-08-02", status: "completed", actualSleepAt: "2026-08-02T23:00:00.000Z", phoneDownAt: "2026-08-02T23:00:00.000Z", sessionStartedAt: "2026-08-02T22:30:00.000Z", completedAt: "2026-08-02T23:00:00.000Z", bedTimeTarget: "23:30", reasons: [] }], morningSessions: [] };
  await DB.restoreAll(v1backup);
  check("restoreAll v1 backup nights=1", (await DB.getRecentNightSessions(30)).length === 1);
  check("restoreAll v1 backup events=0", (await DB.getRecentEvents(10)).length === 0);

  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(fail ? "\n" + fail + " failed (" + results.length + " checks)" : "\nall " + results.length + " checks passed");
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exitCode = 1;
});
