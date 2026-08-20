# Sleep Ritual 第四阶段：个体化干预系统 — 交付报告

> 阶段目标：让系统从「固定规则推荐」逐步过渡到「基于本地历史的轻量自适应」。
> 坚持：无云端 AI、无大模型、无后端；纯本地 IndexedDB 自适应；简单、可解释、可回溯。
> 提交 message：`feat: personalize sleep interventions from local history`（单独提交）。

---

## 一、个体化数据模型

复用现有 session/event/content 字段，**不新建表、不重复造字段**。关联链：

```
Reason (NightSession.reasons)
   ↓
Content (NightSession.shownContentIds / contentId)
   ↓
MicroAction (NightSession.selectedActionId)
   ↓
Night behavior (phoneDownAt / completedAt / status)
   ↓
Morning feedback (MorningSession.mood)
```

- 内容效果复用：`usageCount`/`lastShownAt`（DB 已有）、`shownContentIds`/`contentId`（session 已有）。
- 微行为效果复用：`selectedActionId`、`phoneDownAt`、`bedTimeTarget`、配对的 `MorningSession.mood`。
- 新增 events 类型仅 `duplicate_resolved`（第三阶段），本阶段不新增存储字段。

---

## 二、推荐算法

新增 `js/behavior-profile.js`（BehaviorProfile 纯函数模块），升级 `content-selector.js` 为 PersonalizedContentSelector。

**评分公式**（`content-selector.js · scoreItem`）：

```
score =   reasonMatch × 命中原因数              // 原因命中（主信号）
        + baseWeight(item)                      // 基础权重 / priority
        − usageCount × usagePenalty            // 长期使用降权（多样性）
        + (personalSignal − 0.5) × 2 × personalHistory   // 个人历史效果
        − recentCount × recentUsagePenalty      // 最近 7 天使用降权（推荐疲劳）
        + rand() × noise                       // 探索噪声
```

权重可注入（`DEFAULT_WEIGHTS`，非硬编码过度）：

| 维度 | 默认权重 | 含义 |
|------|---------|------|
| reasonMatch | 3 | 每个命中原因 |
| usagePenalty | 0.15 | 每单位总使用次数 |
| personalHistory | 1.5 | 个人历史效果（0..1 信号，中性 0.5） |
| recentUsagePenalty | 0.8 | 最近 7 天每展示一次 |
| noise | 1.5 | 探索噪声 |

**personalSignal**（`behavior-profile.js · contentEffect/personalSignal`）：
```
personalSignal = completionRate × 0.5 + goodMorningRate × 0.5     （shownCount ≥ 3 才计算，否则 0.5 中性）
```

**推荐疲劳防护**：
- 硬排除：`excludeIds`（本次会话 + 近 7 晚 shownContentIds）整条排除，池空回退不过滤。
- 软降权：`recentUsagePenalty` 让最近用得多的内容降权（与硬排除互补）。
- 同分簇随机：取最高分区，随机选其一，保持「随机感 + 个体化」。

**可解释/可回溯**：`scoreItem` 可复算任一候选得分；每个内容画像可溯源到「哪些夜晚、完成/次日状态」。

---

## 三、熬夜模式识别

`behavior-profile.js · stayUpPattern(nights, 30)`：统计最近 30 天高频原因及占比。
- 结论门槛：**≥14 样本 且 首因占比 ≥40%** 才显示「你最近的熬夜大多出现在 X 的场景」。
- <14 样本或首因分散 → 只列统计、不下结论。
- **无心理诊断语言**（不说「你是娱乐补偿型」）。

---

## 四、未来扩展接口（预留，本阶段不实现复杂算法）

- `BehaviorProfile`（已实现：内容/行为/模式画像纯函数）
- `InterventionProfile`（形状预留：`{ usage, avgBedtimeAfter, avgDelayAfter, goodPct, personalSignal, sampleSize }`，见 `buildActionProfile` 返回）
- `PersonalizedContentSelector`（别名 `window.PersonalizedContentSelector = ContentSelector`，强调自适应入口语义）

保持简单、可解释、可回溯。

---

## 五、数据安全

- **local-first**：所有计算在本地 IndexedDB 上完成（`buildPersonalContext` 仅读本地 nights/mornings/content）。
- **未增加**：自动上传、远程画像、用户行为追踪、第三方 analytics。
- 数据不足（shown<3 / 样本<14）→ 信号中性 0.5 / 不下结论，绝不凭小样本过度个性化。
- 观察性措辞严格：「历史记录中，这种行为与你的较早就寝时间经常同时出现」——**不下因果结论**。

---

## 六、界面原则

夜间页保持少信息、低认知负担：个体化提示 `#night-content-hint` 仅当 `personalSignal ≥ 0.65 且 shown ≥ 3` 时显示一句「今晚可能更适合这个。」——非 AI 报告风格，自然融入。Trends 视图新增「熬夜模式」区块（统计 + 达门槛才下结论）。

---

## 七、新增数据字段 / 函数 / 页面

| 类别 | 内容 |
|------|------|
| 新增数据字段 | 无新存储字段（全复用现有）；新增模块级画像（内存计算，不入库） |
| 新增模块 | `js/behavior-profile.js`（BehaviorProfile：contentEffect/buildContentProfile/recentUsage/actionEffect/buildActionProfile/stayUpPattern/personalSignal） |
| 扩展模块 | `js/content-selector.js`：scoreItem 加 personalHistory + recentUsagePenalty 项；DEFAULT_WEIGHTS 扩展；`window.PersonalizedContentSelector` 别名 |
| 新增页面/组件 | 夜间个体化提示 `#night-content-hint`；Trends「熬夜模式」区块；SW CACHE v13→v14（+ behavior-profile.js 入 App Shell） |

---

## 八、测试

新增 `tests/personalize.test.js`（26 项，纯函数）：reason match / 内容去重 / recent usage penalty / 数据不足（中性 0.5）/ 新用户（无历史仍可推荐）/ 历史充足（profile 影响评分）/ 熬夜模式阈值（≥14 & ≥40% 才结论）/ 微行为效果 / 推荐疲劳轮换。
更新 `tests/sw-cache.test.js`（v14 + behavior-profile 入壳）、`tests/architecture.test.js`（v14 + behavior-profile 壳检查）。

### 最终测试结果（`npm test`）

| 分类 | 通过 / 总计 |
|------|------------|
| Unit | 232 / 232 |
| Integration / Smoke | 172 / 172 |
| **Total** | **404** |
| **Passed** | **404** |
| **Failed** | **0** |

明细：db 32 / date-unify 20 / restore 24 / regression 8 / trends 43 / duplicate 13 / personalize 26 / legacy-migration 33 / sw-cache 31（Unit 232）；sleepdate 8 / mvp 17 / xss 8 / morning 13 / ui-smoke 26 / architecture 102（Smoke 172）。

### 测试环境
- Node v22.22.2 · npm 10.9.7 · jsdom 30.0.1 + fake-indexeddb 6.2.5（无浏览器依赖）
- CI：`.github/workflows/test.yml`（push/PR → npm ci → npm test）

---

## 九、Git 提交

```
feat: personalize sleep interventions from local history

- 新增 BehaviorProfile（js/behavior-profile.js）：本地纯函数计算内容/行为
  效果与熬夜模式，local-first、不下因果结论、数据不足中性 0.5
- ContentSelector 升级为 PersonalizedContentSelector：score 加
  personalHistory + recentUsagePenalty 项（可注入权重，非硬编码）；
  硬排除(excludeIds)+软降权(recentUsage)防推荐疲劳
- 夜间页接入自适应：buildPersonalContext 注入 profile/recentUsage；
  personalSignal≥0.65 且 shown≥3 时自然显示「今晚可能更适合这个」
- Trends 新增「熬夜模式」区块（≥14 样本且首因≥40% 才下结论，无心理诊断）
- 预留 InterventionProfile / PersonalizedContentSelector 接口
- sw.js CACHE v13→v14 + behavior-profile.js 入 App Shell
- 新增 tests/personalize.test.js(26 项)；全量 npm test：15 套件 404 项 0 失败
```

本阶段完成，**保持此版本稳定运行一段时间，再基于真实数据决定下一步**——不自动增加 AI、云同步或通知系统。
