# Sleep Ritual 第三阶段：数据健康与行为趋势 — 交付报告

> 阶段目标：重复记录处理 + 数据健康完善 + 30 天行为趋势 + 「以前 → 现在」变化。
> 坚持睡前行为干预定位：**不评分、不游戏化、不引入 AI。** 提交 message：`feat: add behavioral trends and data-health resolution`（单独提交）。

---

## 一、完成内容

### 1. Duplicate History 安全解决
- **修复 `findSuspiciousNightSessions` 漏报**：原实现只把「已有其它异常」的记录入列，导致干净的重复记录（仅因同日多条 completed）从不被标记 `duplicate_completed`。改为无条件入列 → 重复扫描补充 → 末尾过滤无异常者。
- **新增 DB**：`getNightSessionsByDate(date)`——取某睡眠日全部记录，供解决流程展示 A/B。
- **UI（`app.js` renderDuplicateResolution）**：检测到重复时按睡眠日分组卡片，每条显示 日期 / 开始(sessionStartedAt) / 结束(completedAt) + `保留 A / 保留 B / 取消`。
  - 不自动猜保留哪条——必须用户选择；
  - 删除前二次确认（`confirm`）；
  - 删除写 `events` 日志（`type=duplicate_resolved`，含 `keptId`/`deletedId`/`keptSessionStartedAt`）可追踪；
  - 只影响该重复日，绝不触碰其它日期；
  - 解决后自动重新扫描 + 刷新 History。
- **XSS 安全**：全程 `createElement` + `textContent`，无 `innerHTML` 注入用户数据。

### 2. 30 天趋势分析（`analytics.js` 纯函数）
新增可测纯函数（跨午夜安全，统一 `sleepDate` cutoff=04:00）：
- `phoneDownStats(nights, days)` → `{ count, avg, median, earliest, latest, trend, earliestHHMM, latestHHMM }`
- `beforeNow(nights)` → `{ firstAvg, lastAvg, deltaMin, direction, firstHHMM, lastHHMM }`（以前 → 现在）
- `bedtimeCompare(nights)` → `{ d30Avg, d7Avg, direction, d30HHMM, d7HHMM, d30Count, d7Count }`
- `topReasons(nights, n)` → 高频熬夜原因 Top N
- `behaviorTrend(nights)` → `{ mostUsed, rising }`（哪个微行为用得最多 + 哪个最近在增加）
- `reasonBehaviorMood(nights, pairMap)` → 原因 × 行为 × 次日状态关联（观察性）
- `dataReadiness(nights, days)` → `none`(<7) / `sparse`(7–13) / `partial`(14–29) / `full`(≥30)
- `phoneDownMinute` / `minuteToHHMM` 辅助

### 3. 「以前 → 现在」而非评分
Trends 视图以变化为主轴：`00:35 → 23:52　变化：提前 43 分钟`。**绝不出现**「睡眠分数 83 / 健康分数 74 / 今日得分」等评分。结论强度随数据量调整（<7 不分析、<14 降强度并标注「先当个参考」）。

### 4. 原因 × 行为 × Morning 关联（严格观察性）
`reasonBehaviorMood` 聚合同晚原因→微行为→配对次日 mood。UI 措辞严格：
- ✅「在你的历史记录中，出现了较高关联——次日状态尚可的比例较高（N 个样本）。这只是观察，不能说明行为导致了结果。」
- ❌ 绝不说「该行为导致你睡得更好」。区分数据描述 / 统计关联 / 推断，不越界。

### 5. Trends 视图（克制 UI）
- 新增 `<section id="view-trends">` + 「趋势」tab（`VIEWS` 加 `trends`）。
- 结构：睡得更早了吗（以前→现在 + 小型 SVG 趋势线）/ 最常见的熬夜原因（Top 3）/ 最近最常用的方法 / 这段时间的节奏 / 原因×行为×次日 / 放下手机时间统计。
- 文字优先，仅一条小型 `sparkline` 趋势线，不一堆图表。数据不足显示「再积累几天数据，我们再看看变化。」

### 6. SW 缓存
`sw.js` CACHE `v12 → v13`（app.js/analytics.js/db.js/index.html/css 更新需 bump 才能真机生效）。

---

## 二、Bug 修复（顺带）
- `findSuspiciousNightSessions` 重复漏报（见上）：干净重复记录现在能被检测，是 Duplicate 解决流程能工作的前提。

---

## 三、新增数据字段 / 函数 / 页面

| 类别 | 内容 |
|------|------|
| 新增数据字段 | 无新存储字段；复用现有 `NightSession.selectedActionId`/`reasons`/`phoneDownAt`/`sessionStartedAt`/`completedAt` 与 `MorningSession.mood`；新增 `events` 类型 `duplicate_resolved`（含 `keptId`/`deletedId`）做删除可追踪。 |
| 新增 DB 方法 | `getNightSessionsByDate(date)` |
| 新增分析函数 | `phoneDownMinute`、`minuteToHHMM`、`phoneDownStats`、`beforeNow`、`bedtimeCompare`、`topReasons`、`behaviorTrend`、`reasonBehaviorMood`、`dataReadiness`（均挂 `window.Analytics`） |
| 新增页面/组件 | Trends 视图（`#view-trends` + 趋势 tab）+ Duplicate 解决卡片（`#duplicate-resolution`）+ 小型 `sparkline` 趋势线 + 配套 CSS |

---

## 四、测试

新增 2 套件（均纯 Node，归入 `npm run test:unit`）：
- `tests/trends.test.js`（43 项）：放下手机统计 / 以前→现在方向 / 30 vs 7 天对比 / 高频原因 / 微行为趋势 / 关联 / **数据充分性 6·7·13·14·29·30 边界** / **空数据** / **少量数据** / **跨午夜归一** / **异常记录排除** / 超 30 天不进统计。
- `tests/duplicate.test.js`（13 项）：检测 / 解决（保留 A 删 B）/ **只影响该日** / events 可追踪 / **重新扫描清零** / 三条重复解决。

更新：`tests/architecture.test.js`（v12→v13）、`tests/sw-cache.test.js`（v12→v13）。

### 最终测试结果（`npm test`）

| 分类 | 通过 / 总计 |
|------|------------|
| Unit | 203 / 203 |
| Integration / Smoke | 173 / 173 |
| **Total** | **376** |
| **Passed** | **376** |
| **Failed** | **0** |

明细：db 32 / date-unify 20 / restore 24 / regression 8 / trends 43 / duplicate 13 / legacy-migration 33 / sw-cache 30（Unit 203）；sleepdate 8 / mvp 17 / xss 8 / morning 13 / ui-smoke 26 / architecture 101（Smoke 173）。

### 测试环境
- Node v22.22.2 · npm 10.9.7 · jsdom 30.0.1 + fake-indexeddb 6.2.5（无浏览器依赖）
- CI：`.github/workflows/test.yml`（push/PR → npm ci → npm test）

---

## 五、Git 提交

```
feat: add behavioral trends and data-health resolution

- Duplicate 安全解决：修复 findSuspicious 漏报干净重复；新增
  getNightSessionsByDate；UI 展示 A/B + 保留A/保留B/取消 + 二次确认 +
  events 可追踪 + 解决后重扫；只影响该日
- analytics 新增 30 天趋势纯函数：phoneDownStats / beforeNow /
  bedtimeCompare / topReasons / behaviorTrend / reasonBehaviorMood /
  dataReadiness（跨午夜安全、统一 cutoff=04:00）
- 新增 Trends 视图：以前→现在变化 + 高频原因 + 微行为趋势 + 观察性
  关联（严格措辞，不评分/不游戏化/不 AI）；数据不足(<7)不分析，
  <14 降强度
- sw.js CACHE v12→v13；新增 trends/duplicate 测试(56 项)
- 全量 npm test：14 套件 376 项断言通过，0 失败
```

本阶段完成，**未进入下一阶段开发**。
