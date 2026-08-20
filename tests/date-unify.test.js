/* Sleep Ritual — 统一睡眠日 cutoff=04:00 专项测试
 *
 * 覆盖要求：
 *  - DateUtils 暴露唯一 cutoff（NIGHT_CUTOFF_HOUR=4 / SLEEP_CUTOFF_MINUTES=240）
 *  - Analytics.bedtimeTrend 的跨午夜阈值与 DateUtils 一致（不再是 04:48/288）
 *  - app.js delayMinutes 不再用隐含 360（06:00），改用统一 cutoff
 *  - 边界：23:59 / 00:00 / 00:30 / 03:59 / 04:00 / 04:01 / 12:00 全部一致
 *
 * 运行：
 *   NODE_PATH=<工作区>/node_modules node tests/date-unify.test.js
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
global.window = global;
for (const f of ["js/date-utils.js", "js/analytics.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}

const DU = global.DateUtils;
const results = [];
const check = (name, cond) => results.push([name, !!cond]);

(async () => {
  /* ===== 唯一 cutoff 常量 ===== */
  check("DateUtils.NIGHT_CUTOFF_HOUR === 4", DU.NIGHT_CUTOFF_HOUR === 4);
  check("DateUtils.SLEEP_CUTOFF_MINUTES === 240", DU.SLEEP_CUTOFF_MINUTES === 240);

  /* ===== 边界：睡眠日归属（00:00–03:59 → 前一天；04:00 起 → 当天） ===== */
  const sd = (hh, mm) => DU.sleepDate(new Date(2026, 7, 20, hh, mm, 0));
  check("sleepDate 23:59 → 当天(08-20)", sd(23, 59) === "2026-08-20");
  check("sleepDate 00:00 → 前一天(08-19)", sd(0, 0) === "2026-08-19");
  check("sleepDate 00:30 → 前一天(08-19)", sd(0, 30) === "2026-08-19");
  check("sleepDate 03:59 → 前一天(08-19)", sd(3, 59) === "2026-08-19");
  check("sleepDate 04:00 → 当天(08-20)", sd(4, 0) === "2026-08-20");
  check("sleepDate 04:01 → 当天(08-20)", sd(4, 1) === "2026-08-20");
  check("sleepDate 12:00 → 当天(08-20)", sd(12, 0) === "2026-08-20");

  /* ===== bedtimeTrend crossedMidnight 与 DateUtils 一致（证明不再是 288/04:48） =====
     关键反例：04:00 = 240 分。若阈值仍是 288（04:48），则 04:00 会被判为跨午夜(true)；
     使用统一 240 阈值时，04:00 应为 false。 */
  const trend = Analytics.bedtimeTrend([
    { date: "2026-08-20", actualSleepAt: "2026-08-20T23:59:00" },
    { date: "2026-08-20", actualSleepAt: "2026-08-20T00:00:00" },
    { date: "2026-08-20", actualSleepAt: "2026-08-20T00:30:00" },
    { date: "2026-08-20", actualSleepAt: "2026-08-20T03:59:00" },
    { date: "2026-08-20", actualSleepAt: "2026-08-20T04:00:00" },
    { date: "2026-08-20", actualSleepAt: "2026-08-20T04:01:00" },
    { date: "2026-08-20", actualSleepAt: "2026-08-20T12:00:00" },
  ]);
  const byTime = {};
  trend.forEach((t) => { byTime[t.minutes] = t.crossedMidnight; });
  check("crossedMidnight 23:59 false", byTime[1439] === false);
  check("crossedMidnight 00:00 true", byTime[0] === true);
  check("crossedMidnight 00:30 true", byTime[30] === true);
  check("crossedMidnight 03:59 true", byTime[239] === true);
  check("crossedMidnight 04:00 false (proves cutoff=240 not 288)", byTime[240] === false);
  check("crossedMidnight 04:01 false", byTime[241] === false);
  check("crossedMidnight 12:00 false", byTime[720] === false);

  // 一致性：crossedMidnight 当且仅当 actualSleepAt 的睡眠日 ≠ 其本地日历日
  const consistent = trend.every((t) => {
    const ts = t.date + "T" + String(Math.floor(t.minutes / 60)).padStart(2, "0") + ":" + String(t.minutes % 60).padStart(2, "0");
    return t.crossedMidnight === (DU.sleepDate(new Date(ts)) !== DU.getLocalDate(new Date(ts)));
  });
  check("crossedMidnight consistent with sleepDate vs localDate", consistent);

  /* ===== 源码级：业务模块不再写隐含阈值 ===== */
  const appSrc = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
  const anSrc = fs.readFileSync(path.join(root, "js/analytics.js"), "utf8");
  check("analytics.js no longer uses 288/04:48", !anSrc.includes("288") && !anSrc.includes("04:48"));
  check("app.js delayMinutes uses unified cutoff (no literal 360)", !appSrc.includes("actual < 360"));
  check("app.js references DateUtils.SLEEP_CUTOFF_MINUTES", appSrc.includes("SLEEP_CUTOFF_MINUTES"));

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
