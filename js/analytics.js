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

  /* ======================================================================
     第三阶段：30 天行为趋势 + 「以前 → 现在」变化（纯函数，跨午夜安全）
     原则：只做事实描述与统计关联，不做评分、不下因果结论。
     ====================================================================== */

  /* 放下手机时刻 → 当天本地分钟（0–1440），跨午夜（早于 cutoff）归到次日 +1440。
     缺时间返回 null。 */
  function phoneDownMinute(night) {
    const at = phoneDownAtOf(night);
    if (!at) return null;
    const d = new Date(at);
    if (isNaN(d.getTime())) return null;
    const cutoffMin =
      (global && global.DateUtils && global.DateUtils.SLEEP_CUTOFF_MINUTES) || 240;
    let m = d.getHours() * 60 + d.getMinutes();
    if (m < cutoffMin) m += 1440; // 次日凌晨 → 接到当晚时间轴
    return m;
  }

  /* 把「连续分钟（可能 >1440）」压回 0–1439 显示，并转 HH:MM。 */
  function minuteToHHMM(mins) {
    if (mins == null || isNaN(mins)) return "--:--";
    const m = ((Math.round(mins) % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
  }

  /* 方向判定阈值（分钟）：低于此视为「稳定」，避免噪声抖动。 */
  const TREND_THRESHOLD = 5;

  function trendDirection(firstAvg, lastAvg) {
    const delta = (lastAvg || 0) - (firstAvg || 0);
    if (delta <= -TREND_THRESHOLD) return "earlier"; // 提前
    if (delta >= TREND_THRESHOLD) return "later";     // 推迟
    return "stable";
  }

  /* 放下手机时间统计（最近 days 天）。
     返回 { count, avg, median, earliest, latest, trend, earliestHHMM, latestHHMM }。
     trend = 前半段均值 vs 后半段均值的方向（earlier/later/stable）。 */
  function phoneDownStats(nights, days) {
    const list = (nights || [])
      .filter((n) => phoneDownMinute(n) != null && withinDays(n, days))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const ms = list.map(phoneDownMinute).filter((x) => x != null);
    if (!ms.length)
      return { count: 0, avg: null, median: null, earliest: null, latest: null, trend: "stable", earliestHHMM: "--:--", latestHHMM: "--:--" };
    const avg = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
    const median = medianMinute(ms);
    const earliest = Math.min.apply(null, ms);
    const latest = Math.max.apply(null, ms);
    const half = Math.floor(list.length / 2);
    const firstHalf = list.slice(0, half || 1);
    const lastHalf = list.slice(half);
    const firstAvg = firstHalf.length ? Math.round(firstHalf.map(phoneDownMinute).reduce((a, b) => a + b, 0) / firstHalf.length) : avg;
    const lastAvg = lastHalf.length ? Math.round(lastHalf.map(phoneDownMinute).reduce((a, b) => a + b, 0) / lastHalf.length) : avg;
    return {
      count: ms.length,
      avg, median, earliest, latest,
      trend: trendDirection(firstAvg, lastAvg),
      earliestHHMM: minuteToHHMM(earliest),
      latestHHMM: minuteToHHMM(latest),
    };
  }

  /* 「以前 → 现在」：最初 N 条 vs 最近 N 条的放下手机均值变化。
     返回 { firstAvg, lastAvg, deltaMin, direction, firstHHMM, lastHHMM, sampleFirst, sampleLast }。
     数据按 sleepDate 升序；N = min(7, 总数)。 */
  function beforeNow(nights) {
    const list = (nights || [])
      .filter((n) => phoneDownMinute(n) != null)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (list.length < 2)
      return { firstAvg: null, lastAvg: null, deltaMin: null, direction: "stable", firstHHMM: "--:--", lastHHMM: "--:--", sampleFirst: 0, sampleLast: 0 };
    const chunk = Math.min(7, Math.floor(list.length / 2) || 1);
    const firstChunk = list.slice(0, chunk);
    const lastChunk = list.slice(-chunk);
    const firstAvg = Math.round(firstChunk.map(phoneDownMinute).reduce((a, b) => a + b, 0) / firstChunk.length);
    const lastAvg = Math.round(lastChunk.map(phoneDownMinute).reduce((a, b) => a + b, 0) / lastChunk.length);
    const deltaMin = lastAvg - firstAvg;
    return {
      firstAvg, lastAvg, deltaMin,
      direction: trendDirection(firstAvg, lastAvg),
      firstHHMM: minuteToHHMM(firstAvg),
      lastHHMM: minuteToHHMM(lastAvg),
      sampleFirst: firstChunk.length,
      sampleLast: lastChunk.length,
    };
  }

  /* 就寝时间对比：30 天均值 vs 最近 7 天均值，给出方向。
     返回 { d30Avg, d7Avg, direction, d30HHMM, d7HHMM, d30Count, d7Count }。 */
  function bedtimeCompare(nights) {
    const d30 = phoneDownStats(nights, 30);
    const d7 = phoneDownStats(nights, 7);
    return {
      d30Avg: d30.avg, d7Avg: d7.avg,
      direction: trendDirection(d30.avg, d7.avg),
      d30HHMM: d30.avg != null ? minuteToHHMM(d30.avg) : "--:--",
      d7HHMM: d7.avg != null ? minuteToHHMM(d7.avg) : "--:--",
      d30Count: d30.count, d7Count: d7.count,
    };
  }

  /* 高频熬夜原因 Top N（聚合 + 截断）。 */
  function topReasons(nights, n) {
    const agg = aggregateReasons(nights);
    const top = typeof n === "number" ? agg.slice(0, n) : agg;
    return top;
  }

  /* 微行为使用趋势：哪个用得最多 + 哪个最近在增加。
     返回 { mostUsed: {id,count}|null, rising: {id, before, after}|null }。
     rising = 把记录按时间分前后两半，after-before 增量最大且为正者。 */
  function behaviorTrend(nights) {
    const list = (nights || [])
      .filter((n) => n.selectedActionId)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!list.length) return { mostUsed: null, rising: null };
    const agg = aggregateActions(list);
    const mostUsed = agg.length ? { id: agg[0].id, count: agg[0].count } : null;
    const half = Math.floor(list.length / 2) || 1;
    const firstHalf = list.slice(0, half);
    const lastHalf = list.slice(half);
    const countIn = (arr, id) => arr.filter((x) => x.selectedActionId === id).length;
    let rising = null;
    agg.forEach((a) => {
      const before = countIn(firstHalf, a.id);
      const after = countIn(lastHalf, a.id);
      const inc = after - before;
      if (inc > 0 && (!rising || inc > rising.inc)) {
        rising = { id: a.id, before, after, inc };
      }
    });
    return { mostUsed, rising };
  }

  /* 原因 × 行为 × 次日状态 关联（观察性，不涉因果）。
     对每个原因，统计与其同晚出现的微行为分布，以及配对到的次日 mood 分布。
     pairMap: { nightId: morning }。
     返回 [{ reasonId, sampleSize, topActionId, topActionCount, pairedMornings, goodPct, okPct }]。
     仅供 UI 以「在你的历史记录中，出现了较高关联」式措辞呈现。 */
  function reasonBehaviorMood(nights, pairMap) {
    const map = {}; // reasonId -> { actions:{}, total, good, ok, sleepy, paired }
    (nights || []).forEach((n) => {
      (n.reasons || []).forEach((rid) => {
        const rec = (map[rid] = map[rid] || { actions: {}, total: 0, good: 0, ok: 0, sleepy: 0, paired: 0 });
        rec.total++;
        if (n.selectedActionId) rec.actions[n.selectedActionId] = (rec.actions[n.selectedActionId] || 0) + 1;
        const m = pairMap && pairMap[n.id];
        if (m) {
          rec.paired++;
          if (m.mood === "good") rec.good++;
          else if (m.mood === "ok") rec.ok++;
          else if (m.mood === "sleepy") rec.sleepy++;
        }
      });
    });
    return Object.keys(map).map((rid) => {
      const r = map[rid];
      const actions = Object.keys(r.actions).map((id) => ({ id, count: r.actions[id] })).sort((a, b) => b.count - a.count);
      const top = actions[0] || null;
      const moodTotal = r.good + r.ok + r.sleepy;
      return {
        reasonId: rid,
        sampleSize: r.total,
        topActionId: top ? top.id : null,
        topActionCount: top ? top.count : 0,
        pairedMornings: r.paired,
        goodPct: moodTotal ? Math.round((r.good / moodTotal) * 100) : null,
        okPct: moodTotal ? Math.round((r.ok / moodTotal) * 100) : null,
      };
    }).sort((a, b) => b.sampleSize - a.sampleSize);
  }

  /* 数据充分性分级：返回 'none' | 'sparse' | 'partial' | 'full'。
     <7 → none（不给趋势）；7–13 → sparse（降强度）；14–29 → partial；≥30 → full。 */
  function dataReadiness(nights, days) {
    const count = (nights || []).filter((n) => phoneDownMinute(n) != null && withinDays(n, days)).length;
    if (count < 7) return "none";
    if (count < 14) return "sparse";
    if (count < 30) return "partial";
    return "full";
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
    // 第三阶段：30 天趋势 + 以前→现在 + 关联（观察性）
    phoneDownMinute,
    minuteToHHMM,
    phoneDownStats,
    beforeNow,
    bedtimeCompare,
    topReasons,
    behaviorTrend,
    reasonBehaviorMood,
    dataReadiness,
  };
  global.Analytics = Analytics;
})(window);
