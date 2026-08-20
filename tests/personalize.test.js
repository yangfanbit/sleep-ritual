/* Sleep Ritual — 个体化干预系统测试（第四阶段，纯函数）
 *
 * 覆盖（完成标准要求的回归点）：
 *   - reason match（原因命中提权）
 *   - 内容去重（excludeIds 排除 + 池空回退）
 *   - recent usage penalty（最近使用降权）
 *   - 数据不足（personalSignal 中性 0.5）
 *   - 新用户（无历史 → 中性，仍可推荐）
 *   - 历史充足用户（profile 影响评分）
 *   - 熬夜模式阈值（≥14 样本 且 首因≥40% 才给结论）
 *
 * 运行：npm ci 后执行 node tests/personalize.test.js（或 npm run test:unit）
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
global.window = global;
for (const f of ["js/date-utils.js", "js/content.js", "js/analytics.js", "js/behavior-profile.js", "js/content-selector.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

const pad = (n) => (n < 10 ? "0" + n : "" + n);
function dateStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function localISO(dateStr, hh, mm) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(y, mo - 1, d, hh, mm, 0, 0).toISOString();
}

// 内容池
const CONTENT = [
  { id: "c1", type: "quote", text: "A", reasons: ["not_over"], weight: 1, usageCount: 0, enabled: true, modes: ["night"] },
  { id: "c2", type: "quote", text: "B", reasons: ["keep_scrolling"], weight: 1, usageCount: 0, enabled: true, modes: ["night"] },
  { id: "c3", type: "quote", text: "C", reasons: [], weight: 1, usageCount: 0, enabled: true, modes: ["night"] },
];
const W = ContentSelector.DEFAULT_WEIGHTS;

// 构造一条 completed 夜，展示了某内容、选了某原因/行为、放下手机于 hh:mm
function night(offset, contentId, reasons, action, hh, mm, status) {
  const date = dateStr(offset);
  return {
    id: "n" + offset,
    date,
    status: status || "completed",
    phoneDownAt: localISO(date, hh, mm),
    completedAt: localISO(date, hh, mm + 1 > 59 ? 59 : hh + 1),
    sessionStartedAt: localISO(date, hh - 1 < 0 ? 0 : hh - 1, mm),
    bedTimeTarget: "23:30",
    reasons: reasons || [],
    selectedActionId: action || null,
    shownContentIds: contentId ? [contentId] : [],
  };
}

(async () => {
  const BP = BehaviorProfile;

  /* ===== 1. reason match ===== */
  const s1 = ContentSelector.scoreItem(CONTENT[0], ["not_over"], W);
  const s2 = ContentSelector.scoreItem(CONTENT[1], ["not_over"], W);
  check("reason match: c1(not_over) 得分高于 c2(keep_scrolling)", s1 > s2);
  check("reason match: 命中加分 = reasonMatch 权重", s1 - s2 === W.reasonMatch);

  /* ===== 2. 内容去重：excludeIds 排除 ===== */
  const picked = ContentSelector.selectForNight({ all: CONTENT, reasonIds: null, excludeIds: ["c1"], rand: () => 0 });
  check("去重：排除 c1 后不返回 c1", picked && picked.id !== "c1");
  // 全排除 → 回退不过滤（永不 null）
  const fallback = ContentSelector.selectForNight({ all: CONTENT, reasonIds: null, excludeIds: ["c1", "c2", "c3"], rand: () => 0 });
  check("去重：全排除后回退不过滤（非 null）", !!fallback);

  /* ===== 3. recent usage penalty ===== */
  const base = ContentSelector.scoreItem(CONTENT[0], null, W);
  const withRecent = ContentSelector.scoreItem(CONTENT[0], null, W, null, { c1: 3 });
  check("recent usage penalty: 最近用 3 次降权", withRecent < base);
  check("recent usage penalty: 降幅 = 3 * recentUsagePenalty", base - withRecent === 3 * W.recentUsagePenalty);

  /* ===== 4. 数据不足：personalSignal 中性 0.5 ===== */
  const fewNights = [night(0, "c1", ["not_over"], "act_a", 23, 30), night(1, "c1", ["not_over"], "act_a", 0, 10)];
  const eff = BP.contentEffect(CONTENT[0], fewNights, {});
  check("数据不足 shown<3 → personalSignal=0.5", eff.personalSignal === 0.5);
  check("数据不足 shownCount=2", eff.shownCount === 2);

  /* ===== 5. 新用户：无历史，profile 全中性，仍可推荐 ===== */
  const emptyProfile = BP.buildContentProfile(CONTENT, [], {});
  check("新用户：所有内容 personalSignal=0.5", CONTENT.every((c) => emptyProfile[c.id].personalSignal === 0.5));
  const newUserPick = ContentSelector.selectForNight({ all: CONTENT, reasonIds: null, profile: emptyProfile, rand: () => 0 });
  check("新用户：仍能选出内容", !!newUserPick);
  // 中性 profile 不改变得分（personalHistory 项为 0）
  const scoreNoProfile = ContentSelector.scoreItem(CONTENT[0], null, W);
  const scoreNeutralProfile = ContentSelector.scoreItem(CONTENT[0], null, W, emptyProfile, null);
  check("新用户：中性 profile 不偏移得分", scoreNoProfile === scoreNeutralProfile);

  /* ===== 6. 历史充足：profile 影响评分 ===== */
  // c1 被展示 4 次，每次完成 + 次日 good → 高信号；c2 展示 4 次但 abandoned + 次日 sleepy → 低信号
  const goodNights = Array.from({ length: 4 }, (_, i) => night(i, "c1", ["not_over"], "act_a", 23, 30));
  const badNights = Array.from({ length: 4 }, (_, i) => night(i + 4, "c2", ["keep_scrolling"], "act_b", 0, 30, "abandoned"));
  const histNights = goodNights.concat(badNights);
  const pairMap = {};
  goodNights.forEach((n) => { pairMap[n.id] = { id: "m" + n.id, date: n.date, mood: "good", wakeAt: n.phoneDownAt }; });
  badNights.forEach((n) => { pairMap[n.id] = { id: "m" + n.id, date: n.date, mood: "sleepy", wakeAt: n.phoneDownAt }; });
  const profile = BP.buildContentProfile(CONTENT, histNights, pairMap);
  check("历史充足：c1 信号 > 0.5", profile.c1.personalSignal > 0.5);
  check("历史充足：c2 信号 < 0.5", profile.c2.personalSignal < 0.5);
  check("历史充足：c1 shownCount=4", profile.c1.shownCount === 4);
  check("历史充足：c1 goodPct=100", profile.c1.goodPct === 100);
  // profile 让 c1 得分提升、c2 下降
  const c1Base = ContentSelector.scoreItem(CONTENT[0], null, W);
  const c1WithProfile = ContentSelector.scoreItem(CONTENT[0], null, W, profile, null);
  const c2WithProfile = ContentSelector.scoreItem(CONTENT[1], null, W, profile, null);
  check("历史充足：profile 提升 c1", c1WithProfile > c1Base);
  check("历史充足：profile 拉低 c2", c2WithProfile < c1WithProfile);

  /* ===== 7. 熬夜模式阈值 ===== */
  // 15 晚，70% not_over → dominant
  const dom15 = Array.from({ length: 11 }, (_, i) => night(i, "c1", ["not_over"], "act_a", 0, 30))
    .concat(Array.from({ length: 4 }, (_, i) => night(i + 11, "c1", ["other"], "act_a", 0, 30)));
  const pat1 = BP.stayUpPattern(dom15, 30);
  check("熬夜模式：15样本70%首因 → 给结论", pat1.showConclusion === true && pat1.dominant && pat1.dominant.id === "not_over");
  // 6 晚 → 样本不足，不给结论
  const few6 = Array.from({ length: 5 }, (_, i) => night(i, "c1", ["not_over"], "act_a", 0, 30))
    .concat([night(5, "c1", ["other"], "act_a", 0, 30)]);
  const pat2 = BP.stayUpPattern(few6, 30);
  check("熬夜模式：<14 样本不给结论", pat2.showConclusion === false && pat2.dominant === null);
  // 15 晚但首因仅 30%（分散）→ 不给结论
  const spread = Array.from({ length: 5 }, (_, i) => night(i, "c1", ["not_over"], "act_a", 0, 30))
    .concat(Array.from({ length: 5 }, (_, i) => night(i + 5, "c1", ["other"], "act_a", 0, 30)))
    .concat(Array.from({ length: 5 }, (_, i) => night(i + 10, "c1", ["not_sleepy"], "act_a", 0, 30)));
  const pat3 = BP.stayUpPattern(spread, 30);
  check("熬夜模式：首因<40% 不给结论", pat3.showConclusion === false);

  /* ===== 8. 微行为效果（观察性）===== */
  const actionEff = BP.actionEffect("act_a", goodNights, pairMap, "23:30");
  check("actionEffect: usage=4", actionEff.usage === 4);
  check("actionEffect: avgBedtimeAfter 非空", actionEff.avgBedtimeAfter != null);
  check("actionEffect: goodPct=100", actionEff.goodPct === 100);

  /* ===== 9. 推荐疲劳：recentUsage 驱动轮换 ===== */
  const ru = BP.recentUsage(histNights, 7);
  check("recentUsage: c1 最近7天=4", ru.c1 === 4);
  check("recentUsage: c2 最近7天=3（offset 7 超出 7 天窗口）", ru.c2 === 3);
  // 同分候选中，最近用得多的被降权 → selectForNight 倾向另一条
  const twoSame = [
    { id: "x1", reasons: [], weight: 1, usageCount: 0, enabled: true, modes: ["night"] },
    { id: "x2", reasons: [], weight: 1, usageCount: 0, enabled: true, modes: ["night"] },
  ];
  const ruSame = { x1: 5, x2: 0 };
  // 多次确定性采样（rand=0 固定噪声），x2 应被选中（x1 被重降权）
  const pick = ContentSelector.selectForNight({ all: twoSame, reasonIds: null, recentUsage: ruSame, rand: () => 0 });
  check("推荐疲劳：最近用得多的被降权 → 选 x2", pick && pick.id === "x2");

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
