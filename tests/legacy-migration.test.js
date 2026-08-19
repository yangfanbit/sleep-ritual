/* 旧数据安全迁移回归测试（fake-indexeddb + 真实 db.js/date-utils.js/content.js）
 *
 * 覆盖：
 *   Test 1  Legacy 数据迁移：旧记录（无 status）补齐 status=completed，id/原日期/时间不变
 *   Test 2  迁移幂等：连续两次迁移，数量不变、不重复、日期不变化
 *   Test 3  数量守恒：迁移前后 nightSessions 总数相等
 *   Test 4  Data Check 全码检测：legacy_missing_status / date_mismatch /
 *           duplicate_completed / stale_active / missing_times / unparseable_time
 *   Test 5  0 异常路径：干净库扫描返回空数组
 *   Test 6  迁移后旧记录进入 completed-only History（修复 Bug 1）
 *
 * 运行：NODE_PATH=<隔离工作区>/node_modules node tests/legacy-migration.test.js
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = "D:/GitHub Space/sleepearly";
// db.js 的 localDateOf 依赖 window.DateUtils，故必须先加载 date-utils.js
global.window = global; // 让 IIFE 写 window.DateUtils = ... 生效
for (const f of ["js/date-utils.js", "js/content.js", "js/db.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

// 构造一条「旧版本」NightSession（b77ae1b 之前的字段结构：无 status / phoneDownAt / completedAt）
function legacyNight(overrides = {}) {
  return Object.assign(
    {
      date: "2026-08-10",
      bedTimeTarget: "23:30",
      shownAt: "2026-08-10T23:15:00.000Z",
      actualSleepAt: "2026-08-10T23:42:00.000Z",
      contentId: 1,
      shownContentIds: [1],
      reasons: ["phone"],
      selectedActionId: null,
      behaviorTip: null,
      brainDumpUsed: false,
      tonightMessage: "早点睡",
      sleepTownAttempted: true,
    },
    overrides
  );
}

(async () => {
  await DB.ready();

  /* ---- Test 1: Legacy 数据迁移 ---- */
  const before = await DB.addNightSession(legacyNight());
  const id1 = before;
  const r1 = await DB.migrateLegacyNightSessions();
  const after1 = await DB.getNightSessionById(id1);
  check("T1 迁移后记录仍存在", !!after1);
  check("T1 status 补齐为 completed", after1.status === "completed");
  check("T1 id 不变", after1.id === id1);
  check("T1 原始 date 不变", after1.date === "2026-08-10");
  check("T1 原始 actualSleepAt 不变", after1.actualSleepAt === "2026-08-10T23:42:00.000Z");
  check("T1 补 phoneDownAt", after1.phoneDownAt === "2026-08-10T23:42:00.000Z");
  check("T1 补 sessionStartedAt", !!after1.sessionStartedAt);
  check("T1 补 completedAt", !!after1.completedAt);
  check("T1 dateSource=legacy", after1.dateSource === "legacy");
  check("T1 标记 legacyMigrationVersion", after1.legacyMigrationVersion === 1);
  check("T1 报告 recovered=1", r1.recovered === 1);
  check("T1 报告 ok=true", r1.ok === true);
  check("T1 报告 modified=1", r1.modified === 1);

  /* ---- Test 2: 迁移幂等 ---- */
  const r2 = await DB.migrateLegacyNightSessions();
  const after2 = await DB.getNightSessionById(id1);
  check("T2 第二次 modified=0", r2.modified === 0);
  check("T2 第二次 recovered=0", r2.recovered === 0);
  check("T2 第二次后 id 仍不变", after2.id === id1);
  check("T2 第二次后 date 仍不变", after2.date === "2026-08-10");
  check("T2 第二次后 status 仍 completed", after2.status === "completed");
  check("T2 第二次后 actualSleepAt 仍不变", after2.actualSleepAt === "2026-08-10T23:42:00.000Z");

  /* ---- Test 3: 数量守恒 ---- */
  await DB.addNightSession(legacyNight({ date: "2026-08-11", actualSleepAt: "2026-08-11T00:10:00.000Z" }));
  await DB.addNightSession(legacyNight({ date: "2026-08-12", actualSleepAt: "2026-08-12T01:05:00.000Z" }));
  const beforeCount = (await DB.getRecentNightSessions(100000)).length;
  const r3 = await DB.migrateLegacyNightSessions();
  const afterCount = (await DB.getRecentNightSessions(100000)).length;
  check("T3 迁移前 3 条", beforeCount === 3);
  check("T3 迁移后仍 3 条", afterCount === 3);
  check("T3 报告 before===after", r3.before === r3.after);
  check("T3 报告 ok=true", r3.ok === true);

  /* ---- Test 4: Data Check 全码检测 ---- */
  // 4a. legacy_missing_status（直接塞一条无 status，绕过迁移）
  const rawLegacy = legacyNight({ date: "2026-08-13" });
  delete rawLegacy.status; // 本来就没有
  // 注意：若迁移已跑过则不会出现 legacy_missing_status；这里手动构造未迁移状态
  const sid4a = await DB.addNightSession(rawLegacy);
  const sus = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  const row4a = sus.find((s) => s.id === sid4a);
  check("T4a 检出 legacy_missing_status", !!(row4a && row4a.issues.some((i) => i.code === "legacy_missing_status")));

  // 4b. date_mismatch：completed 记录的 phoneDownAt 按 cutoff 应归到另一天
  //     （用 DateUtils.sleepDate 计算正确归日，再把 n.date 设成不同的值 —— 时区无关）
  const pd4b = "2026-08-15T01:30:00.000Z";
  const correctDate4b = window.DateUtils.sleepDate(new Date(pd4b)); // 按本地时区+cutoff 的正确睡眠日
  const wrongDate4b = correctDate4b === "2026-08-14" ? "2026-08-15" : "2026-08-14"; // 故意错位
  const sid4b = await DB.addNightSession({
    date: wrongDate4b,
    status: "completed",
    actualSleepAt: pd4b,
    phoneDownAt: pd4b,
    sessionStartedAt: "2026-08-14T23:00:00.000Z",
    completedAt: pd4b,
    bedTimeTarget: "23:30",
    reasons: [],
  });
  const sus2 = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  const row4b = sus2.find((s) => s.id === sid4b);
  check("T4b 检出 date_mismatch", !!(row4b && row4b.issues.some((i) => i.code === "date_mismatch")));

  // 4c. duplicate_completed：同一 sleepDate 两条 completed
  const dup1 = await DB.addNightSession({
    date: "2026-08-20", status: "completed", actualSleepAt: "2026-08-20T23:30:00.000Z",
    phoneDownAt: "2026-08-20T23:30:00.000Z", sessionStartedAt: "2026-08-20T23:00:00.000Z",
    completedAt: "2026-08-20T23:30:00.000Z", bedTimeTarget: "23:30", reasons: [],
  });
  const dup2 = await DB.addNightSession({
    date: "2026-08-20", status: "completed", actualSleepAt: "2026-08-21T00:10:00.000Z",
    phoneDownAt: "2026-08-21T00:10:00.000Z", sessionStartedAt: "2026-08-20T23:20:00.000Z",
    completedAt: "2026-08-21T00:10:00.000Z", bedTimeTarget: "23:30", reasons: [],
  });
  const sus3 = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  const dupRow = sus3.filter((s) => s.date === "2026-08-20" && s.status === "completed");
  check("T4c 检出 duplicate_completed（两条都报）", dupRow.length === 2 && dupRow.every((r) => r.issues.some((i) => i.code === "duplicate_completed")));

  // 4d. stale_active：active 超过 36h 未结束
  const staleStart = new Date(Date.now() - 40 * 3600 * 1000).toISOString();
  const sid4d = await DB.addNightSession({
    date: "2026-08-01", status: "active", sessionStartedAt: staleStart,
    bedTimeTarget: "23:30", reasons: [],
  });
  const sus4 = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  const row4d = sus4.find((s) => s.id === sid4d);
  check("T4d 检出 stale_active", !!(row4d && row4d.issues.some((i) => i.code === "stale_active")));

  // 4e. missing_times：completed 但缺 phoneDownAt/actualSleepAt
  const sid4e = await DB.addNightSession({
    date: "2026-08-25", status: "completed", sessionStartedAt: "2026-08-25T23:00:00.000Z",
    completedAt: "2026-08-26T07:00:00.000Z", bedTimeTarget: "23:30", reasons: [],
    // 无 actualSleepAt / phoneDownAt
  });
  const sus5 = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  const row4e = sus5.find((s) => s.id === sid4e);
  check("T4e 检出 missing_times", !!(row4e && row4e.issues.some((i) => i.code === "missing_times")));

  // 4f. unparseable_time：phoneDownAt 无法解析
  const sid4f = await DB.addNightSession({
    date: "2026-08-26", status: "completed", phoneDownAt: "not-a-date",
    actualSleepAt: "not-a-date", sessionStartedAt: "2026-08-26T23:00:00.000Z",
    completedAt: "2026-08-27T07:00:00.000Z", bedTimeTarget: "23:30", reasons: [],
  });
  const sus6 = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  const row4f = sus6.find((s) => s.id === sid4f);
  check("T4f 检出 unparseable_time", !!(row4f && row4f.issues.some((i) => i.code === "unparseable_time")));

  /* ---- Test 5: 0 异常路径（干净库） ---- */
  await DB.wipeAll();
  // 插入一条「完美」completed 记录：phoneDownAt 按 cutoff 归日与 date 一致、无重复
  // 用 DateUtils.sleepDate 计算 n.date，保证时区无关
  const pdClean = "2026-08-28T23:20:00.000Z";
  const cleanDate = window.DateUtils.sleepDate(new Date(pdClean));
  await DB.addNightSession({
    date: cleanDate, status: "completed",
    actualSleepAt: pdClean, phoneDownAt: pdClean,
    sessionStartedAt: "2026-08-28T23:00:00.000Z", completedAt: pdClean,
    bedTimeTarget: "23:30", reasons: [],
  });
  const cleanSus = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  check("T5 干净库 0 异常", Array.isArray(cleanSus) && cleanSus.length === 0);

  /* ---- Test 6: 迁移后旧记录进入 completed-only History ---- */
  await DB.wipeAll();
  await DB.addNightSession(legacyNight({ date: "2026-09-01", actualSleepAt: "2026-09-01T23:40:00.000Z" }));
  // 迁移前：completed-only 查不到这条（Bug 1 复现）
  const beforeMig = await DB.getCompletedNightSessions(100);
  check("T6 迁移前 completed-only 为空（Bug1 复现）", beforeMig.length === 0);
  await DB.migrateLegacyNightSessions();
  const afterMig = await DB.getCompletedNightSessions(100);
  check("T6 迁移后 completed-only 包含该旧记录", afterMig.length === 1 && afterMig[0].date === "2026-09-01");
  check("T6 迁移后该记录 status=completed", afterMig[0].status === "completed");

  /* ---- 输出 ---- */
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
