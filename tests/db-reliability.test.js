/* Sleep Ritual — 数据可靠性单元测试（P1 #7 并发保护 / P1 #8 迁移原子性）
 *
 * 覆盖：
 *  - addActiveNightSession 并发创建：Promise.all 双发同睡眠日 → 不会产生两条 active
 *  - addActiveNightSession 顺序创建：已有 active 则复用，不重复
 *  - 旧数据迁移在单事务提交中途失败 → 整体不写（无半迁移状态）+ 可安全重试
 *  - 迁移幂等：重复运行 modified=0，数量保守校验通过
 *
 * 纯 Node + fake-indexeddb，无需服务器。
 *   依赖装于隔离 Node 工作区：fake-indexeddb
 *   运行：node tests/db-reliability.test.js
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
global.window = global;
for (const f of ["js/date-utils.js", "js/db.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}

const results = [];
const check = (name, cond) => results.push([name, !!cond]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const mkActive = (date) => ({
  date,
  status: "active",
  sessionStartedAt: new Date().toISOString(),
  dateSource: "auto",
});

(async () => {
  /* ============ 并发保护（P1 #7） ============ */

  // 1) 并发双发：同一睡眠日的两次「确保 active」调用不得产生两条 active
  await DB.wipeAll();
  const sd = "2026-08-25";
  const [r1, r2] = await Promise.all([
    DB.addActiveNightSession(mkActive(sd)),
    DB.addActiveNightSession(mkActive(sd)),
  ]);
  check("concurrent addActiveNightSession returns ids", typeof r1.id === "number" && typeof r2.id === "number");
  const actives = (await DB.getRecentNightSessions(50)).filter(
    (n) => n.date === sd && n.status === "active"
  );
  check("concurrent create yields exactly ONE active session", actives.length === 1);

  // 2) 顺序调用：第二次应复用已有 active（reused=true, id 相同）
  await DB.wipeAll();
  const sd2 = "2026-08-26";
  const a = await DB.addActiveNightSession(mkActive(sd2));
  const b = await DB.addActiveNightSession(mkActive(sd2));
  check("sequential addActiveNightSession reuses existing", b.reused === true && b.id === a.id);

  // 3) 普通 addNightSession 不受锁影响（仍按原语义直写，用于非 active 创建）
  await DB.wipeAll();
  const plainId = await DB.addNightSession({ date: "2026-08-27", status: "completed" });
  check("addNightSession direct write works", typeof plainId === "number");

  /* ============ 迁移原子性（P1 #8） ============ */

  await DB.wipeAll();
  const legacy = [
    { date: "2026-01-01", actualSleepAt: new Date().toISOString() },
    { date: "2026-01-02", completedAt: new Date().toISOString() },
  ];
  for (const l of legacy) await DB.addNightSession(l);

  // 强制「单事务提交」失败，验证失败不会留下半迁移状态
  const origCommit = DB._commitMigrationWrites.bind(DB);
  DB._commitMigrationWrites = async () => {
    throw new Error("forced tx failure");
  };
  let threw = false;
  try {
    await DB.migrateLegacyNightSessions();
  } catch (e) {
    threw = true;
  }
  DB._commitMigrationWrites = origCommit;
  check("migration throws when commit fails", threw);

  const afterFail = await DB.getRecentNightSessions(50);
  check(
    "no partial migration (no legacyMigrationVersion / status written)",
    afterFail.length === legacy.length &&
      afterFail.every((n) => n.legacyMigrationVersion == null && n.status == null)
  );
  check("record count unchanged after interrupted migration", afterFail.length === legacy.length);

  // 失败后可安全重试：真实提交
  const rep = await DB.migrateLegacyNightSessions();
  check("migration succeeds on retry", rep.ok === true);
  check("migration modified 2 records", rep.modified === 2);
  const afterMig = await DB.getRecentNightSessions(50);
  check("migration sets status=completed", afterMig.every((n) => n.status === "completed"));
  check(
    "migration sets legacyMigrationVersion",
    afterMig.every((n) => n.legacyMigrationVersion === 1)
  );

  // 幂等：再次运行不重复迁移（modified=0），且数量守恒
  const rep2 = await DB.migrateLegacyNightSessions();
  check("migration idempotent (no re-modify)", rep2.modified === 0);
  check(
    "migration count conserved",
    rep2.before === rep2.after && rep2.after === legacy.length
  );

  await DB.wipeAll();

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
