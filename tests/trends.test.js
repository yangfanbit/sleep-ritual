/* Sleep Ritual — 30 天行为趋势分析测试（纯函数，第三阶段）
 *
 * 覆盖：
 *   - 放下手机统计（平均/中位/最早/最晚/趋势）
 *   - 「以前 → 现在」变化方向
 *   - 30 天 vs 7 天就寝对比
 *   - 高频原因 / 微行为趋势 / 原因×行为×次日关联
 *   - 数据充分性边界：7 / 14 / 30
 *   - 空数据 / 少量数据 / 跨午夜 / 异常记录
 *
 * 运行：npm ci 后执行 node tests/trends.test.js（或 npm run test:unit）
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
global.window = global;
for (const f of ["js/date-utils.js", "js/content.js", "js/analytics.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

const pad = (n) => (n < 10 ? "0" + n : "" + n);
// 相对今天的日期字符串（offset 天前）
function dateStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
// 由「日期字符串 + 本地时:分」构造 ISO（跨时区可移植：构造与读取都用本地时）
function localISO(dateStr, hh, mm) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(y, mo - 1, d, hh, mm, 0, 0).toISOString();
}
// 构造一条 completed NightSession
function night(offset, hh, mm, opts = {}) {
  const date = dateStr(offset);
  return Object.assign(
    {
      id: "n" + offset + "_" + hh + mm,
      date,
      status: "completed",
      phoneDownAt: localISO(date, hh, mm),
      completedAt: localISO(date, hh, mm + 1 > 59 ? 59 : hh + 1, mm),
      bedTimeTarget: "23:30",
      reasons: opts.reasons || [],
      selectedActionId: opts.action || null,
    },
    opts.extra || {}
  );
}
function morningFor(n, mood) {
  // 次日早晨：配对靠 pairMorningToNight 的 wakeAt ≤ 18h 规则
  const wake = new Date(new Date(n.phoneDownAt).getTime() + 7 * 3600 * 1000).toISOString();
  return { id: "m" + n.id, date: n.date, mood, wakeAt: wake };
}

(async () => {
  /* ===== 空数据 ===== */
  check("phoneDownStats 空 count=0", Analytics.phoneDownStats([], 30).count === 0);
  check("phoneDownStats 空 avg=null", Analytics.phoneDownStats([], 30).avg === null);
  check("beforeNow 空 delta=null", Analytics.beforeNow([]).deltaMin === null);
  check("dataReadiness 空为 none", Analytics.dataReadiness([], 30) === "none");

  /* ===== 数据充分性边界：6/7/13/14/29/30 ===== */
  const mk6 = Array.from({ length: 6 }, (_, i) => night(i, 23, 30));
  const mk7 = Array.from({ length: 7 }, (_, i) => night(i, 23, 30));
  const mk13 = Array.from({ length: 13 }, (_, i) => night(i, 23, 30));
  const mk14 = Array.from({ length: 14 }, (_, i) => night(i, 23, 30));
  const mk29 = Array.from({ length: 29 }, (_, i) => night(i, 23, 30));
  const mk30 = Array.from({ length: 30 }, (_, i) => night(i, 23, 30));
  check("6 条 → none", Analytics.dataReadiness(mk6, 30) === "none");
  check("7 条 → sparse", Analytics.dataReadiness(mk7, 30) === "sparse");
  check("13 条 → sparse", Analytics.dataReadiness(mk13, 30) === "sparse");
  check("14 条 → partial", Analytics.dataReadiness(mk14, 30) === "partial");
  check("29 条 → partial", Analytics.dataReadiness(mk29, 30) === "partial");
  check("30 条 → full", Analytics.dataReadiness(mk30, 30) === "full");

  /* ===== 放下手机统计：平均/中位/最早/最晚 ===== */
  const stat = Analytics.phoneDownStats(
    [night(0, 23, 0), night(1, 23, 30), night(2, 0, 15), night(3, 23, 45)],
    30
  );
  // 23:00=1380, 23:30=1410, 00:15(跨午夜+1440)=1455, 23:45=1425
  check("stats count=4", stat.count === 4);
  check("stats 最早=23:00", stat.earliest === 1380 && stat.earliestHHMM === "23:00");
  check("stats 最晚=00:15(跨午夜归1455)", stat.latest === 1455 && stat.latestHHMM === "00:15");
  check("stats avg=1418", stat.avg === 1418); // (1380+1410+1455+1425)/4 = 1417.5→1418
  check("stats median=1418", stat.median === 1418); // (1410+1425)/2 = 1417.5→1418

  /* ===== 跨午夜归一化：00:15 > 23:45（时间轴更晚）===== */
  check("跨午夜 00:15 分钟=1455", Analytics.phoneDownMinute(night(5, 0, 15)) === 1455);
  check("跨午夜 00:15 晚于 23:45", Analytics.phoneDownMinute(night(5, 0, 15)) > Analytics.phoneDownMinute(night(5, 23, 45)));
  check("非跨午夜 23:30 分钟=1410", Analytics.phoneDownMinute(night(5, 23, 30)) === 1410);

  /* ===== 趋势方向：以前（更早的 offset=旧）晚睡 00:35 → 现在早睡 23:00 → earlier =====
     beforeNow 按日期升序（旧→新）：firstChunk=最旧、lastChunk=最新。
     故「以前晚」用大 offset，「现在早」用小 offset。 */
  const laterFirst = Array.from({ length: 5 }, (_, i) => night(5 + i, 0, 35)); // 旧：00:35（晚）
  const earlierLast = Array.from({ length: 5 }, (_, i) => night(i, 23, 0));     // 新：23:00（早）
  const trendNights = laterFirst.concat(earlierLast);
  const bn = Analytics.beforeNow(trendNights);
  check("beforeNow direction=earlier", bn.direction === "earlier");
  check("beforeNow delta 负数", bn.deltaMin < 0);
  check("beforeNow firstHHMM=00:35", bn.firstHHMM === "00:35");
  check("beforeNow lastHHMM=23:00", bn.lastHHMM === "23:00");
  check("phoneDownStats trend=earlier", Analytics.phoneDownStats(trendNights, 30).trend === "earlier");

  /* ===== 趋势反向：以前早睡 23:00 → 现在晚睡 00:35 → later ===== */
  const reverseNights = Array.from({ length: 5 }, (_, i) => night(5 + i, 23, 0)) // 旧：23:00
    .concat(Array.from({ length: 5 }, (_, i) => night(i, 0, 35)));               // 新：00:35
  check("反向 trend=later", Analytics.phoneDownStats(reverseNights, 30).trend === "later");
  check("反向 beforeNow direction=later", Analytics.beforeNow(reverseNights).direction === "later");

  /* ===== 稳定：全部相同 → stable ===== */
  const stable = Array.from({ length: 10 }, (_, i) => night(i, 23, 30));
  check("稳定 trend=stable", Analytics.phoneDownStats(stable, 30).trend === "stable");
  check("稳定 beforeNow direction=stable", Analytics.beforeNow(stable).direction === "stable");

  /* ===== 30 天 vs 7 天就寝对比 ===== */
  const bc = Analytics.bedtimeCompare(mk30);
  check("bedtimeCompare d30Count=30", bc.d30Count === 30);
  check("bedtimeCompare d7Count=7", bc.d7Count === 7);
  check("bedtimeCompare direction=stable（全相同）", bc.direction === "stable");

  /* ===== 高频熬夜原因 Top N ===== */
  const reasonNights = [
    night(0, 23, 0, { reasons: ["not_over", "keep_scrolling"] }),
    night(1, 23, 0, { reasons: ["not_over"] }),
    night(2, 23, 0, { reasons: ["keep_scrolling", "other"] }),
    night(3, 23, 0, { reasons: ["not_over", "other"] }),
  ];
  const top = Analytics.topReasons(reasonNights, 2);
  check("topReasons 返回 Top2", top.length === 2);
  check("topReasons 第一=not_over(3次)", top[0].id === "not_over" && top[0].count === 3);
  check("topReasons 第二=keep_scrolling(2次)", top[1].id === "keep_scrolling" && top[1].count === 2);

  /* ===== 微行为趋势：最常用 + 最近增加 =====
     behaviorTrend 按日期升序（旧→新），half=floor(7/2)=3：前 3 条=旧，后 4 条=新。
     braindump 共 4 次（最常用）；breath 3 次全在新半段 → rising。 */
  const behNights = [
    night(6, 23, 0, { action: "act_braindump" }),
    night(5, 23, 0, { action: "act_braindump" }),
    night(4, 23, 0, { action: "act_braindump" }),
    night(3, 23, 0, { action: "act_braindump" }),
    night(2, 23, 0, { action: "act_breath" }),
    night(1, 23, 0, { action: "act_breath" }),
    night(0, 23, 0, { action: "act_breath" }),
  ];
  const bt = Analytics.behaviorTrend(behNights);
  check("behaviorTrend mostUsed=act_braindump(4)", bt.mostUsed && bt.mostUsed.id === "act_braindump" && bt.mostUsed.count === 4);
  check("behaviorTrend rising=act_breath", bt.rising && bt.rising.id === "act_breath" && bt.rising.after > bt.rising.before);

  /* ===== 原因 × 行为 × 次日状态（观察性关联）===== */
  const rbNights = [
    night(0, 23, 0, { reasons: ["not_over"], action: "act_braindump" }),
    night(1, 23, 0, { reasons: ["not_over"], action: "act_braindump" }),
    night(2, 23, 0, { reasons: ["not_over"], action: "act_breath" }),
  ];
  const pairMap = {};
  rbNights.forEach((n) => { pairMap[n.id] = morningFor(n, "good"); });
  const rbm = Analytics.reasonBehaviorMood(rbNights, pairMap);
  const notOver = rbm.find((r) => r.reasonId === "not_over");
  check("reasonBehaviorMood 样本=3", notOver && notOver.sampleSize === 3);
  check("reasonBehaviorMood topAction=act_braindump(2)", notOver && notOver.topActionId === "act_braindump" && notOver.topActionCount === 2);
  check("reasonBehaviorMood 配对晨=3", notOver && notOver.pairedMornings === 3);
  check("reasonBehaviorMood goodPct=100", notOver && notOver.goodPct === 100);

  /* ===== 异常记录：不可解析时间被排除 ===== */
  const abnormal = [
    night(0, 23, 30),
    { id: "bad1", date: dateStr(1), status: "completed", phoneDownAt: "not-a-date", completedAt: "x", bedTimeTarget: "23:30", reasons: [] },
    { id: "bad2", date: dateStr(2), status: "completed", completedAt: "y", bedTimeTarget: "23:30", reasons: [] }, // 无 phoneDownAt
  ];
  const abStat = Analytics.phoneDownStats(abnormal, 30);
  check("异常记录被排除 count=1", abStat.count === 1);
  check("异常记录 avg=1410(23:30)", abStat.avg === 1410);
  check("异常 beforeNow 不报错（返回有限结果）", typeof Analytics.beforeNow(abnormal).direction === "string");

  /* ===== withinDays 边界：超出 30 天的不进统计 ===== */
  const outOfRange = [night(31, 23, 30), night(40, 23, 30)];
  check("超出30天不进统计", Analytics.phoneDownStats(outOfRange, 30).count === 0);

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
