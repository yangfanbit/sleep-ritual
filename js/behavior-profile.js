/* BehaviorProfile — 本地个体化画像（第四阶段）
 *
 * 定位：让系统从「固定规则推荐」逐步过渡到「基于本地历史的轻量自适应」。
 * 原则（严格遵守）：
 *   - 纯函数 + local-first：只吃 session/event/content 数组，输出聚合结果；
 *     绝不上传、不远程画像、不第三方 analytics。
 *   - 只表达统计关联，不下因果结论（观察性数据）。
 *   - 简单、可解释、可回溯：每个信号都能溯源到「哪些夜晚、哪种结果」。
 *   - 数据不足时返回中性值（0.5），不强行个性化。
 *
 * 关联模型（复用现有字段，不新建表）：
 *   Reason → Content(shownContentIds) → MicroAction(selectedActionId)
 *         → Night behavior(phoneDownAt/completedAt/status) → Morning feedback(mood)
 *
 * 依赖：Analytics.phoneDownMinute / targetDelay / withinDays（跨午夜安全）。
 */
(function (global) {
  "use strict";

  const A = (global && global.Analytics) || null;

  /* 工具：该夜是否展示了某内容 id。 */
  function nightShownIds(n) {
    if (!n) return [];
    if (n.shownContentIds && n.shownContentIds.length) return n.shownContentIds;
    return n.contentId != null ? [n.contentId] : [];
  }
  function nightShown(n, contentId) {
    return nightShownIds(n).includes(contentId);
  }

  /* 个人化信号（0..1）：数据不足返回 0.5（中性，不偏移）。
     混合 = 完成率 * 0.5 + 次日好心情率 * 0.5。 */
  function personalSignal(stats) {
    if (!stats || !stats.shownCount || stats.shownCount < 3) return 0.5;
    const completion = stats.completedCount / stats.shownCount;
    const good = stats.pairedMornings ? stats.goodCount / stats.pairedMornings : 0.5;
    return completion * 0.5 + good * 0.5;
  }

  /* 单条内容的效果统计。
     content: { id, reasons }
     nights: NightSession[]
     pairMap: { nightId: morning }
     返回 { shownCount, completedCount, dismissedCount, selectedAsReasonCount,
            pairedMornings, goodCount, completionRate, goodPct, personalSignal } */
  function contentEffect(content, nights, pairMap) {
    const cid = content && content.id;
    const reasons = (content && content.reasons) || [];
    const shown = (nights || []).filter((n) => nightShown(n, cid));
    const shownCount = shown.length;
    const completedCount = shown.filter((n) => n.status === "completed").length;
    const dismissedCount = shownCount - completedCount;
    const selectedAsReasonCount = shown.filter((n) =>
      (n.reasons || []).some((r) => reasons.includes(r))
    ).length;
    const paired = shown.filter((n) => pairMap && pairMap[n.id]);
    const pairedMornings = paired.length;
    const goodCount = paired.filter((n) => pairMap[n.id].mood === "good").length;
    const completionRate = shownCount ? completedCount / shownCount : null;
    const goodPct = pairedMornings ? Math.round((goodCount / pairedMornings) * 100) : null;
    return {
      shownCount, completedCount, dismissedCount, selectedAsReasonCount,
      pairedMornings, goodCount, completionRate, goodPct,
      personalSignal: personalSignal({ shownCount, completedCount, pairedMornings, goodCount }),
    };
  }

  /* 整库内容画像：{ [contentId]: stats }。 */
  function buildContentProfile(contentList, nights, pairMap) {
    const map = {};
    (contentList || []).forEach((c) => { map[c.id] = contentEffect(c, nights, pairMap); });
    return map;
  }

  /* 最近 N 天的内容使用次数：{ [contentId]: count }（用于推荐疲劳降权）。 */
  function recentUsage(nights, days) {
    const d = days != null ? days : 7;
    const map = {};
    (nights || []).forEach((n) => {
      if (!A || !A.withinDays(n, d)) return;
      nightShownIds(n).forEach((id) => { map[id] = (map[id] || 0) + 1; });
    });
    return map;
  }

  /* 单个微行为的效果统计（观察性，不涉因果）。
     actionId: NightSession.selectedActionId
     bedtime: 设置目标（用于 targetDelay）
     返回 { usage, avgBedtimeAfter(min), avgBedtimeHHMM, avgDelayAfter, pairedMornings,
            goodPct, sampleSize, personalSignal } */
  function actionEffect(actionId, nights, pairMap, bedtime) {
    const used = (nights || []).filter((n) => n && n.selectedActionId === actionId);
    const usage = used.length;
    const bedMin = used.map((n) => A && A.phoneDownMinute(n)).filter((x) => x != null);
    const delays = used.map((n) => A && A.targetDelay(n, bedtime)).filter((x) => x != null);
    const avgBedtimeAfter = bedMin.length ? Math.round(bedMin.reduce((a, b) => a + b, 0) / bedMin.length) : null;
    const avgDelayAfter = delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null;
    const paired = used.filter((n) => pairMap && pairMap[n.id]);
    const pairedMornings = paired.length;
    const goodCount = paired.filter((n) => pairMap[n.id].mood === "good").length;
    const goodPct = pairedMornings ? Math.round((goodCount / pairedMornings) * 100) : null;
    return {
      usage, avgBedtimeAfter, avgBedtimeHHMM: A && A.minuteToHHMM ? A.minuteToHHMM(avgBedtimeAfter) : null,
      avgDelayAfter, pairedMornings, goodPct, sampleSize: usage,
      personalSignal: usage < 3 ? 0.5 : ((goodPct != null ? goodPct / 100 : 0.5) * 0.5 + 0.5 * 0.5),
    };
  }

  /* 整体微行为画像：{ [actionId]: InterventionProfile }。
     InterventionProfile 形状（未来扩展接口，本阶段保持简单）：
       { usage, avgBedtimeAfter, avgDelayAfter, goodPct, personalSignal, sampleSize } */
  function buildActionProfile(nights, pairMap, bedtime) {
    const map = {};
    (nights || []).forEach((n) => {
      if (n && n.selectedActionId && !map[n.selectedActionId]) {
        map[n.selectedActionId] = actionEffect(n.selectedActionId, nights, pairMap, bedtime);
      }
    });
    return map;
  }

  /* 熬夜模式识别（统计，非诊断）。
     days 默认 30。只在样本充足时给出「主导模式」结论。
     返回 { total, top:[{id,count,pct}], dominant:{id,pct}|null, showConclusion:boolean, summary } */
  function stayUpPattern(nights, days) {
    const d = days != null ? days : 30;
    const inRange = (nights || []).filter((n) => A && A.withinDays(n, d) && n.status === "completed");
    const total = inRange.length;
    const reasonMap = {};
    inRange.forEach((n) =>
      (n.reasons || []).forEach((r) => { reasonMap[r] = (reasonMap[r] || 0) + 1; })
    );
    const top = Object.keys(reasonMap)
      .map((id) => ({ id, count: reasonMap[id], pct: total ? reasonMap[id] / total : 0 }))
      .sort((a, b) => b.count - a.count);
    // 结论门槛：≥14 样本 且 首因占比 ≥40%
    const showConclusion = total >= 14 && top.length > 0 && top[0].pct >= 0.4;
    const dominant = showConclusion ? { id: top[0].id, pct: Math.round(top[0].pct * 100) } : null;
    return { total, top, dominant, showConclusion, summary: top };
  }

  const BehaviorProfile = {
    nightShownIds,
    personalSignal,
    contentEffect,
    buildContentProfile,
    recentUsage,
    actionEffect,
    buildActionProfile,
    stayUpPattern,
  };
  global.BehaviorProfile = BehaviorProfile;
})(window);
