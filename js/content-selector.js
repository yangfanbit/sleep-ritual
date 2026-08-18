/* ContentSelector — 夜间内容规则评分选择器
 *
 * 取代 app.js 内联的 pickContent，集中内容选取逻辑（见架构 Phase 5）。
 * 评分维度：
 *  - 原因命中：candidate.reasons 与当前 reasonIds 相交 → 加权（主信号）
 *  - 标签命中：candidate.tags 与 reasonIds 派生标签相交 → 小加权（可选增强）
 *  - 基础权重：weight（缺省回退 priority）→ 维护者可调优先级
 *  - 历史使用降权：usageCount 越高越不优先，保证长期曝光多样性
 *  - 探索噪声：加入随机项，使同分候选每次结果不同，避免长期只推同一条
 *
 * 近期降重：excludeIds（本次会话 + 近 7 晚已展示）整条排除；若排除后池空，
 * 自动回退到不过滤的池，永不返回 null（除非内容库为空）。
 *
 * 纯函数 + 可注入随机源（rand），便于确定性测试。
 */
(function (global) {
  "use strict";

  const DEFAULT_WEIGHTS = {
    reasonMatch: 3, // 每个命中原因
    tagMatch: 1, // 每个命中标签
    usagePenalty: 0.15, // 每单位 usageCount
    noise: 1.5, // 探索噪声幅度
  };

  function baseWeight(item) {
    if (item.weight != null) return item.weight;
    if (item.priority != null) return item.priority; // 兼容旧 priority 字段
    return 0;
  }

  function scoreItem(item, reasonIds, weights) {
    let score = 0;
    const reasons = item.reasons || [];
    const tags = item.tags || [];
    if (reasonIds && reasonIds.length) {
      const rm = reasons.filter((r) => reasonIds.includes(r)).length;
      score += rm * weights.reasonMatch;
      const tm = tags.filter((t) => reasonIds.includes(t)).length;
      score += tm * weights.tagMatch;
    }
    score += baseWeight(item);
    score -= (item.usageCount || 0) * weights.usagePenalty;
    return score;
  }

  /* 选一条。返回评分最高的候选（同分随机）；全部被排除则回退不过滤。 */
  function selectForNight(opts) {
    const o = opts || {};
    const all = o.all || [];
    const reasonIds = o.reasonIds || null;
    const weights = o.weights || DEFAULT_WEIGHTS;
    const rand = o.rand || Math.random;

    const exclude = o.excludeIds
      ? new Set(
          Array.isArray(o.excludeIds) ? o.excludeIds : Array.from(o.excludeIds)
        )
      : new Set();

    const enabled = all.filter(
      (c) => c.enabled !== false && (!c.modes || c.modes.includes("night"))
    );
    if (!enabled.length) return null;

    // 先尝试排除近期的池；若空则回退不过滤
    let pool = enabled;
    if (exclude.size) {
      const rest = enabled.filter((c) => !exclude.has(c.id));
      if (rest.length) pool = rest;
    }

    // 评分 + 探索噪声
    const scored = pool.map((c) => ({
      item: c,
      score: scoreItem(c, reasonIds, weights) + rand() * weights.noise,
    }));
    scored.sort((a, b) => b.score - a.score);

    // 取最高分区（同分簇），随机选其一，避免总是命中第一条
    const top = scored[0].score;
    const topBand = scored.filter((x) => Math.abs(x.score - top) < 1e-9);
    return topBand[Math.floor(rand() * topBand.length)].item;
  }

  const ContentSelector = { DEFAULT_WEIGHTS, baseWeight, scoreItem, selectForNight };
  global.ContentSelector = ContentSelector;
})(window);
