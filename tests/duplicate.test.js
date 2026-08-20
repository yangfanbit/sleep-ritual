/* Sleep Ritual — Duplicate History 安全解决测试（第三阶段 · 一）
 *
 * 覆盖：
 *   - 检测：同一睡眠日两条 completed → findSuspiciousNightSessions 报 duplicate_completed
 *   - 解决：保留 A 删除 B（手动选择，不自动猜）→ deleteNightSession
 *   - 可追踪：解决后写入 events 日志（type=duplicate_resolved，含 keptId/deletedId）
 *   - 只影响该日：删除后该日剩 1 条，其它日期记录不变
 *   - 完成后重新扫描：duplicate_completed 清零
 *
 * 运行：npm ci 后执行 node tests/duplicate.test.js（或 npm run test:unit）
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

function localISO(dateStr, hh, mm) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(y, mo - 1, d, hh, mm, 0, 0).toISOString();
}
function completedNight(id, date, extra = {}) {
  return Object.assign(
    {
      id,
      date,
      status: "completed",
      phoneDownAt: localISO(date, 23, 30),
      completedAt: localISO(date, 23, 35),
      sessionStartedAt: localISO(date, 22, 30),
      bedTimeTarget: "23:30",
      reasons: [],
    },
    extra
  );
}

(async () => {
  await DB.ready();
  await DB.wipeAll();

  /* ===== 检测：同一睡眠日两条 completed ===== */
  const date = "2026-08-15";
  const idA = await DB.addNightSession(completedNight("dupA", date, { bedTimeTarget: "23:00" }));
  const idB = await DB.addNightSession(completedNight("dupB", date, { bedTimeTarget: "23:30" }));
  // 另一天一条记录，验证「只影响该日」
  const idOther = await DB.addNightSession(completedNight("other", "2026-08-16"));

  let report = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  const dup = report.filter((o) => o.issues.some((i) => i.code === "duplicate_completed"));
  check("检测到 duplicate_completed", dup.length >= 2); // 两条都标记
  check("重复均在同一睡眠日", dup.every((o) => o.date === date));

  const byDate = await DB.getNightSessionsByDate(date);
  check("getNightSessionsByDate 返回 2 条", byDate.length === 2);

  /* ===== 解决：保留 A、删除 B（手动选择）===== */
  await DB.deleteNightSession(idB);
  await DB.addEvent({
    type: "duplicate_resolved",
    date,
    payload: { keptId: idA, deletedId: idB },
  }).catch(() => {});

  /* ===== 只影响该日：其它日期记录不变 ===== */
  const after = await DB.getRecentNightSessions(100000);
  check("解决后该日剩 1 条", after.filter((n) => n.date === date).length === 1);
  check("其它日期记录仍在", after.some((n) => n.id === idOther && n.date === "2026-08-16"));
  check("被删的 B 不复存在", !after.some((n) => n.id === idB));
  check("保留的 A 仍在", after.some((n) => n.id === idA));

  /* ===== 可追踪：events 日志写入 ===== */
  const events = await DB.getRecentEvents(50);
  const resolvedEvt = events.find((e) => e.type === "duplicate_resolved");
  check("events 记录 duplicate_resolved", !!resolvedEvt);
  check("events 含 keptId/deletedId",
    resolvedEvt && resolvedEvt.payload && resolvedEvt.payload.keptId === idA && resolvedEvt.payload.deletedId === idB);

  /* ===== 完成后重新扫描：duplicate 清零 ===== */
  report = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  const dupAfter = report.filter((o) => o.issues.some((i) => i.code === "duplicate_completed"));
  check("重新扫描 duplicate 清零", dupAfter.length === 0);

  /* ===== 三条记录的解决：保留 1 条删 2 条 ===== */
  await DB.wipeAll();
  const t1 = await DB.addNightSession(completedNight("t1", "2026-09-01"));
  const t2 = await DB.addNightSession(completedNight("t2", "2026-09-01"));
  const t3 = await DB.addNightSession(completedNight("t3", "2026-09-01"));
  let r3 = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  check("三条重复均被标记", r3.filter((o) => o.issues.some((i) => i.code === "duplicate_completed")).length === 3);
  // 保留 t1，删 t2/t3
  await DB.deleteNightSession(t2);
  await DB.deleteNightSession(t3);
  r3 = await DB.findSuspiciousNightSessions({ staleHours: 36 });
  check("三条解决后清零", r3.filter((o) => o.issues.some((i) => i.code === "duplicate_completed")).length === 0);
  check("三条解决后该日剩 1 条", (await DB.getNightSessionsByDate("2026-09-01")).length === 1);

  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(fail ? "\n" + fail + " failed (" + results.length + " checks)" : "\nall " + results.length + " checks passed");
  process.exitCode = fail ? 1 : 0;
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exit(1);
});
