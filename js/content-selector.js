/* ContentSelector — 夜间内容规则评分选择器
 *
 * 取代 app.js 内联的 pickContent，集中内容选取逻辑（见架构 Phase 5）。
 * 第四阶段：升级为 PersonalizedContentSelector（自适应），评分维度：
 *  - 原因命中：candidate.reasons 与当前 reasonIds 相交 → 加权（主信号）
 *  - 基础权重：weight（缺省回退 priority）→ 维护者可调优先级
 *  - 历史使用降权：usageCount 越高越不优先，保证长期曝光多样性
 *  - 个人历史效果（personalHistory）：基于本地 BehaviorProfile，
 *    历史上「展示该内容后较常完成 + 次日状态较好」的内容轻微提权；
 *    数据不足时为中性（0.5），不偏移——绝不凭小样本过度个性化
 *  - 最近使用降权（recentUsagePenalty）：最近 7 天展示次数越多越降权，
 *    与 excludeIds（硬排除）配合，避免连续多天给同一内容（推荐疲劳）
 *  - 探索噪声：加入随机项，使同分候选每次结果不同，避免长期只推同一条
 *
 * 近期降重：excludeIds（本次会话 + 近 7 晚已展示）整条排除；若排除后池空，
 * 自动回退到不过滤的池，永不返回 null（除非内容库为空）。
 *
 * 纯函数 + 可注入随机源（rand），便于确定性测试。
 * 可解释：selectForNight 可通过 scoreItem 复算任一候选得分，可回溯为何选它。
 */
(function (global) {
  "use strict";

  // 权重可配（非硬编码过度）；调用方可注入 weights 覆盖。
  const DEFAULT_WEIGHTS = {
    reasonMatch: 3,            // 每个命中原因（reasons 字段 = 真实匹配键）
    usagePenalty: 0.15,        // 每单位 usageCount（展示后真实自增）
    personalHistory: 1.5,      // 个人历史效果（0..1 信号，中性 0.5）
    recentUsagePenalty: 0.8,   // 最近 7 天每展示一次降权
    noise: 1.5,                // 探索噪声幅度
  };

  function baseWeight(item) {
    if (item.weight != null) return item.weight;
    if (item.priority != null) return item.priority; // 兼容旧 priority 字段
    return 0;
  }

  /* 个人历史信号：profile 为 buildContentProfile 产物 { [id]: {personalSignal} }。
     缺失/数据不足 → 0.5（中性，不偏移）。 */
  function personalSignalOf(item, profile) {
    if (!profile || !profile[item.id]) return 0.5;
    const s = profile[item.id].personalSignal;
    return typeof s === "number" ? s : 0.5;
  }

  /* 评分：原因命中 + 基础权重 - 使用降权 + 个人历史效果 - 最近使用降权 + 噪声(外部加)。
     注意：tags 在本项目数据契约中是「给人看的主题标签，不参与机器匹配」，
     因此不纳入评分（tagMatch 已移除，避免假装有效）。
     profile / recentUsage 可选；不传则个人历史与最近使用项为 0（向后兼容）。 */
  function scoreItem(item, reasonIds, weights, profile, recentUsage) {
    const w = weights || DEFAULT_WEIGHTS;
    let score = 0;
    const reasons = item.reasons || [];
    if (reasonIds && reasonIds.length) {
      const rm = reasons.filter((r) => reasonIds.includes(r)).length;
      score += rm * w.reasonMatch;
    }
    score += baseWeight(item);
    score -= (item.usageCount || 0) * w.usagePenalty;
    // 个人历史效果：信号偏离 0.5 的方向轻微提权/降权（中性时为 0）
    const sig = personalSignalOf(item, profile);
    score += (sig - 0.5) * 2 * (w.personalHistory || 0);
    // 最近使用降权
    const recent = (recentUsage && recentUsage[item.id]) || 0;
    score -= recent * (w.recentUsagePenalty || 0);
    return score;
  }

  /* 选一条。返回评分最高的候选（同分随机）；全部被排除则回退不过滤。
     opts: { all, reasonIds, excludeIds, weights, rand, profile, recentUsage } */
  function selectForNight(opts) {
    const o = opts || {};
    const all = o.all || [];
    const reasonIds = o.reasonIds || null;
    const weights = o.weights || DEFAULT_WEIGHTS;
    const rand = o.rand || Math.random;
    const profile = o.profile || null;
    const recentUsage = o.recentUsage || null;

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
      score: scoreItem(c, reasonIds, weights, profile, recentUsage) + rand() * weights.noise,
    }));
    scored.sort((a, b) => b.score - a.score);

    // 取最高分区（同分簇），随机选其一，避免总是命中第一条
    const top = scored[0].score;
    const topBand = scored.filter((x) => Math.abs(x.score - top) < 1e-9);
    return topBand[Math.floor(rand() * topBand.length)].item;
  }

  const ContentSelector = { DEFAULT_WEIGHTS, baseWeight, scoreItem, selectForNight, personalSignalOf };
  global.ContentSelector = ContentSelector;
  // 别名：第四阶段起的自适应入口（同一对象，强调语义）
  global.PersonalizedContentSelector = ContentSelector;
})(window);
