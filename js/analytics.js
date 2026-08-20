/* Analytics — 睡前行为干预的效果与趋势计算
 *
 * 纯函数层（数据进、结果出），无副作用、便于测试（见架构 Phase 6）。
 * 输入多为 NightSession / MorningSession 数组 + 设置，输出聚合结果。
 * 重点：跨午夜安全。睡眠日常被归入「前一天」（sleepDate 规则），
 * 但 actualSleepAt 可能是次日凌晨 00:xx，所有时长/偏差计算都按真实时间戳，
 * 不依赖字符串日期，天然跨午夜正确。
 */
(function (global) {
  "use strict";

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  /* 放下手机时间：新字段 phoneDownAt 优先，兼容旧字段 actualSleepAt。 */
  function phoneDownAtOf(night) {
    return (night && (night.phoneDownAt || night.actualSleepAt)) || null;
  }

  function parseDate(str) {
    const [y, m, d] = String(str).split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  /* 由「日期字符串 + HH:MM」构造当天本地时间。 */
  function timeToDate(dateStr, hhmm) {
    const [h, mi] = String(hhmm).split(":").map(Number);
    const dt = parseDate(dateStr);
    dt.setHours(h, mi || 0, 0, 0);
    return dt;
  }

  /* 该夜间记录是否落在最近 days 个日历日内（含今天）。 */
  function withinDays(night, days) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nd = parseDate(night.date);
    nd.setHours(0, 0, 0, 0);
    const diff = Math.floor((today - nd) / 86400000);
    return diff >= 0 && diff < days;
  }

  /* 干预时长：从开始睡前（sessionStartedAt）到完成（completedAt）。
     跨午夜安全（用真实时间戳差）。返回毫秒；缺字段返回 null。 */
  function interventionDuration(night) {
    if (!night || !night.sessionStartedAt || !night.completedAt) return null;
    const s = new Date(night.sessionStartedAt).getTime();
    const c = new Date(night.completedAt).getTime();
    if (isNaN(s) || isNaN(c)) return null;
    return Math.max(0, c - s);
  }

  /* 距目标就寝时间的偏差（分钟）：正=晚于目标，负=早于目标。
     跨午夜安全：若 actualSleepAt 远早于 target（次日凌晨），+1440 修正。
     bedtime 形如 "23:30"。缺字段返回 null。 */
  function targetDelay(night, bedtime) {
    const sleepAt = phoneDownAtOf(night);
    if (!night || !sleepAt || !bedtime) return null;
    const sleep = new Date(sleepAt).getTime();
    if (isNaN(sleep)) return null;
    const target = timeToDate(night.date, bedtime).getTime();
    let diff = (sleep - target) / 60000;
    if (diff < -720) diff += 1440; // 偏差小于 -12h 视为跨午夜（次日凌晨）
    return Math.round(diff);
  }

  /* 聚合：最常见熬夜原因（按出现次数降序）。 */
  function aggregateReasons(nights) {
    const map = {};
    (nights || []).forEach((n) =>
      (n.reasons || []).forEach((r) => { map[r] = (map[r] || 0) + 1; })
    );
    return Object.keys(map)
      .map((id) => ({ id, count: map[id] }))
      .sort((a, b) => b.count - a.count);
  }

  /* 聚合：最常尝试的微行为（selectedActionId）。 */
  function aggregateActions(nights) {
    const map = {};
    (nights || []).forEach((n) => {
      if (n.selectedActionId) map[n.selectedActionId] = (map[n.selectedActionId] || 0) + 1;
    });
    return Object.keys(map)
      .map((id) => ({ id, count: map[id] }))
      .sort((a, b) => b.count - a.count);
  }

  /* 聚合：最常展示的内容（shownContentIds 优先，回退 contentId）。 */
  function aggregateContent(nights) {
    const map = {};
    (nights || []).forEach((n) => {
      const ids = n.shownContentIds && n.shownContentIds.length
        ? n.shownContentIds
        : n.contentId
        ? [n.contentId]
        : [];
      ids.forEach((id) => { map[id] = (map[id] || 0) + 1; });
    });
    return Object.keys(map)
      .map((id) => ({ id, count: map[id] }))
      .sort((a, b) => b.count - a.count);
  }

  /* 就寝时间趋势：每天实际放下手机的时刻（分钟，0–1440）及是否跨午夜。
     用于「我通常几点睡」。按日期升序。 */
  function bedtimeTrend(nights) {
    // 统一睡眠日 cutoff：与 DateUtils.NIGHT_CUTOFF_HOUR (04:00=240 分) 一致，
    // 不再使用其它隐含的分钟阈值。
    const cutoffMin =
      (global && global.DateUtils && global.DateUtils.SLEEP_CUTOFF_MINUTES) || 240;
    return (nights || [])
      .filter((n) => phoneDownAtOf(n))
      .map((n) => {
        const d = new Date(phoneDownAtOf(n));
        const minutes = d.getHours() * 60 + d.getMinutes();
        // 早于 cutoff（04:00）视为次日凌晨，跨午夜
        const crossedMidnight = minutes < cutoffMin;
        return { date: n.date, minutes, crossedMidnight };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /* 中位数（分钟数组）。 */
  function medianMinute(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  function minutesToHHMM(mins) {
    if (mins == null || isNaN(mins)) return "--:--";
    const m = ((Math.round(mins) % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
  }

  /* 微行为「有效性」粗估：把每个有过 selectedActionId 的夜间，
     与其后一个早晨的 mood 配对；统计每个 action 对应的「好/一般/困」分布。
     配对规则：night.date 的下一个日历日 = morning.date（由调用方传入已配对 map）。
     nightsById: { id: night }，morningsByNightId: { nightId: morning }。
     返回 [{ id, total, good, ok, sleepy }]。 */
  function behaviorEffectiveness(nightsById, morningsByNightId) {
    const map = {};
    Object.keys(nightsById).forEach((id) => {
      const n = nightsById[id];
      if (!n.selectedActionId) return;
      const m = morningsByNightId[id];
      const rec = (map[n.selectedActionId] = map[n.selectedActionId] || {
        id: n.selectedActionId, total: 0, good: 0, ok: 0, sleepy: 0,
      });
      rec.total++;
      if (m) {
        if (m.mood === "good") rec.good++;
        else if (m.mood === "ok") rec.ok++;
        else if (m.mood === "sleepy") rec.sleepy++;
      }
    });
    return Object.keys(map)
      .map((id) => map[id])
      .sort((a, b) => b.total - a.total);
  }

  const Analytics = {
    parseDate,
    timeToDate,
    withinDays,
    interventionDuration,
    targetDelay,
    aggregateReasons,
    aggregateActions,
    aggregateContent,
    bedtimeTrend,
    medianMinute,
    minutesToHHMM,
    behaviorEffectiveness,
  };
  global.Analytics = Analytics;
})(window);
