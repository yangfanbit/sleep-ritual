/* Sleep Ritual — 长期保护性回归门禁（CI Gate）
 *
 * 本套件对应「第二阶段 · 六」要求的六类长期保护性测试，每类一条规范化断言，
 * 作为 CI 可见的最小门禁：任一行为被后续改动破坏即在此失败。
 *   1. 历史数据：旧版 → migration → 数量守恒 + 字段正确
 *   2. 日期：03:59 = 前一天 / 04:00 = 当天
 *   3. Restore：current A → restore B → 最终数据 = B
 *   4. Edit：记录 A → 编辑 → 仍然只有 1 条 A
 *   5. Delete：记录 A → 删除 → 确实不存在
 *   6. Data Health：构造错误数据 → health check → 能发现错误
 *
 * 纯 Node 套件（fake-indexeddb + vm 加载源码），无需服务器：
 *   node tests/regression.test.js   或   npm run test:unit
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
global.window = global; // 让 IIFE 写 window.DateUtils / window.DB 生效
for (const f of ["js/date-utils.js", "js/content.js", "js/db.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

// 构造一条「旧版本」NightSession（无 status / phoneDownAt / completedAt）
function legacyNight(date, overrides = {}) {
  return Object.assign(
    {
      id: Date.now() + Math.random(),
      date,
      actualSleepAt: date + "T23:30:00.000Z",
      bedTimeTarget: "23:30",
      reasons: [],
    },
    overrides
  );
}

function completedNight(date, overrides = {}) {
  return Object.assign(
    {
      id: Date.now() + Math.random(),
      date,
      status: "completed",
      actualSleepAt: date + "T23:30:00.000Z",
      phoneDownAt: date + "T23:30:00.000Z",
      sessionStartedAt: date + "T22:30:00.000Z",
      completedAt: date + "T23:35:00.000Z",
      bedTimeTarget: "23:30",
      reasons: [],
    },
    overrides
  );
}

(async () => {
  await DB.ready();
  await DB.wipeAll();

  /* ===== 1. 历史数据 migration：数量守恒 + 字段正确 ===== */
  const legacy = legacyNight("2026-07-01");
  await DB.addNightSession(legacy);
  const beforeCnt = (await DB.getRecentNightSessions(100000)).length;
  const report = await DB.migrateLegacyNightSessions();
  const afterList = await DB.getRecentNightSessions(100000);
  const migrated = afterList[0];
  check(
    "migration 数量守恒（前后相等）",
    beforeCnt === 1 && afterList.length === 1 && report.before === report.after
  );
  check(
    "migration 字段正确（补 status=completed，保留原 date/id）",
    migrated.status === "completed" &&
      migrated.date === "2026-07-01" &&
      migrated.actualSleepAt === legacy.actualSleepAt
  );

  await DB.wipeAll();

  /* ===== 2. 日期边界：03:59 → 前一天 / 04:00 → 当天 ===== */
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);
  check(
    "日期 03:59 → 前一天",
    DateUtils.sleepDate(at(2026, 8, 17, 3, 59)) === "2026-08-16"
  );
  check(
    "日期 04:00 → 当天",
    DateUtils.sleepDate(at(2026, 8, 17, 4, 0)) === "2026-08-17"
  );

  /* ===== 3. Restore：current A → restore B → 最终 = B ===== */
  await DB.addNightSession(completedNight("2026-08-01")); // current A
  const backupB = {
    app: "sleep-ritual",
    schemaVersion: 2,
    version: 2,
    settings: [],
    content: [],
    nightSessions: [completedNight("2026-08-02")],
    morningSessions: [],
    events: [],
  };
  const rs = await DB.restoreAll(backupB);
  const afterRestore = await DB.getRecentNightSessions(100000);
  check(
    "Restore A→B 后最终数据 = B（仅剩 08-02，A 被覆盖）",
    rs.ok === true &&
      afterRestore.length === 1 &&
      afterRestore[0].date === "2026-08-02"
  );

  await DB.wipeAll();

  /* ===== 4. Edit：记录 A → 编辑 → 仍然只有 1 条 A ===== */
  const idA = await DB.addNightSession(completedNight("2026-08-10"));
  const a = await DB.getNightSessionById(idA);
  await DB.updateNightSession(
    Object.assign({}, a, { bedTimeTarget: "22:45", dateSource: "manual" })
  );
  const afterEdit = await DB.getRecentNightSessions(100000);
  const edited = await DB.getNightSessionById(idA);
  check(
    "Edit 后仍然只有 1 条且 id 不变、字段已更新",
    afterEdit.length === 1 && edited.id === idA && edited.bedTimeTarget === "22:45"
  );

  /* ===== 5. Delete：记录 A → 删除 → 确实不存在 ===== */
  await DB.deleteNightSession(idA);
  const afterDel = await DB.getRecentNightSessions(100000);
  const gone = await DB.getNightSessionById(idA);
  check(
    "Delete 后记录确实不存在（列表为空、按 id 查为空）",
    afterDel.length === 0 && gone == null
  );

  await DB.wipeAll();

  /* ===== 6. Data Health：构造错误数据 → health check 能发现 ===== */
  // 故意构造 phoneDownAt 的日期与记录 date 不一致 → 触发 date_mismatch
  await DB.addNightSession(
    completedNight("2026-08-15", { phoneDownAt: "2026-08-16T01:30:00.000Z" })
  );
  const suspicious = await DB.findSuspiciousNightSessions();
  const hasMismatch = suspicious.some((s) =>
    s.issues.some((i) => i.code === "date_mismatch")
  );
  check(
    "Data Health 能发现构造的错误数据（date_mismatch）",
    suspicious.length > 0 && hasMismatch
  );

  /* ===== 汇总 ===== */
  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(
    fail ? "\n" + fail + " failed (" + results.length + " checks)" : "\nall " + results.length + " checks passed"
  );
  process.exitCode = fail ? 1 : 0;
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exit(1);
});
