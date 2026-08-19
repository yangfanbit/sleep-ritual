# Sleep Ritual — History 数据一致性 / 跨午夜归日 / 记录编辑 专项修复报告

> 目标：建立「一个睡眠日 = 一个 canonical NightSession」的可靠数据模型，严格区分 `active / completed / abandoned`，
> History 只展示有效的 `completed` 记录，支持人工安全修正历史，并兼容既有 legacy 数据。
> 纯前端 PWA（Vanilla JS + IndexedDB，无后端/无账户），本次为**定向 bug-fix / 数据模型加固**，非大型重构。

---

## 1. 修改文件清单

| 文件 | 类型 | 关键改动 |
|---|---|---|
| `js/date-utils.js` | **新增** | 统一日期工具：`todayStr / getLocalDate / sleepDate(cutoff=4) / formatTime(安全) / formatLocalInput / parseLocalInput / isValidDateStr / isValidHHMM`。替代散落的 `slice(0,10)` 与重复实现 |
| `js/db.js` | 修改 | `getCompletedNightSessions`（completed 唯一数据源）、`addEvent` 时间戳本地日期派生、`findSuspiciousNightSessions`、`repairNightSessionDate`、`upsertMorningSessionByDate`、`incrementContentUsage`、`deleteNightSession`、`cmpNightSession` |
| `js/app.js` | 修改 | `renderHistory` 只取 completed；`bindBackToNightFlow` 重置 `currentNightId`；`bindSleepButton` 不覆盖 completed；历史编辑/删除 UI + 校验；`fmtTime` 安全格式化 |
| `js/analytics.js` | 修改 | `targetDelay` / `bedtimeTrend` 改用 `phoneDownAt ?? actualSleepAt`（兼容 legacy `actualSleepAt`） |
| `js/content-selector.js` | 修改 | 移除 `tagMatch`（`tags` 仅展示，`reasons` 才是匹配键） |
| `sw.js` | 修改 | App-Shell 预缓存新增 `date-utils.js`；cache 版本 `v10 → v11` |
| `index.html` | 修改 | 引入 `date-utils.js`（首个 script）；新增 History 编辑面板；设置页「数据自检」区块 |
| `tests/architecture.test.js` | 修改 | 固化 completed-only / 跨午夜 / 迁移修复 / 编辑删除 / 时区回归 |
| `.dev-server.mjs` | 新增（测试基建） | 本地静态测试服务器（回归套件依赖 `SR_PORT`） |

---

## 2. 数据模型变更

### 2.1 四种时间概念（统一到 `DateUtils`）
- **Calendar Date** 日历日：`todayStr()`
- **Local Date** 本地日期（由 ISO 按本地时区取 YYYY-MM-DD）：`getLocalDate()` —— 取代 `iso.slice(0,10)`（UTC，跨时区错位）
- **Sleep Date** 睡眠日：`sleepDate()`，00:00–03:59 归入前一天，04:00 起算当天（cutoff=4），与 `NightSession.date` / `Event.date` / History / Analytics / 配对 / 深链 全链路统一
- **Timestamp** ISO 时间戳

### 2.2 NightSession 状态机与唯一性
- 状态：`active / completed / abandoned`；`canTransitionSessionStatus` 已禁止 `completed→active` 与 `completed→abandoned`
- `ensureNightSession` 语义：复用当天 active，绝不覆盖 completed，防重复 active（race-safe）
- 新增字段：`phoneDownAt`（新，替代/优先于 legacy `actualSleepAt`）、`updatedAt`、`dateSource`（`auto` / `manual` / `migration`）

### 2.3 MorningSession 唯一性
- `upsertMorningSessionByDate(date, session)`：一天只保留一个 canonical MorningSession，保 id、置 `updatedAt`

### 2.4 ContentSelector 契约修正
- `tags` 仅展示标签，机器匹配只认 `reasons`；移除无效 `tagMatch` 权重项

---

## 3. 修复问题（按优先级）

### P0 — 数据一致性
| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| P0-1 | History 混入未完成的 active 记录、显示 `NaN:NaN` | `renderHistory` 改用 `getCompletedNightSessions(30)`；`fmtTime()` 对 `undefined/null/""/NaN/Invalid Date` 全部回退 `--:--` | Test8/9、formatTime 用例、人工流程 |
| P0-2 | 一个睡眠日可能多条 canonical NightSession | `getActiveNightSession` 复用 + 状态机保护 + `cmpNightSession` 稳定排序 | 深链保护 Test1–Test7 |
| P0-3 | 「completed → 返回流程 → 再次入睡」覆盖已完成记录 | `bindBackToNightFlow` 重置 `currentNightId=null`；`bindSleepButton` 对 `null` 或 existing completed 一律 `createNightSession()` | Test2–Test5、Test6/7 |
| P0-4 | 跨午夜 `sleepDate` 规则分散、可能不一致 | 统一到 `DateUtils.sleepDate(cutoff=4)`；NightSession.date / Event.date / History / Analytics / 配对 / 深链 全链路一致 | 03:59→前一天、04:00→当天、跨月末/年末 |
| P0-5 | `addEvent` 用 `ts.slice(0,10)`（UTC）导致丢事件 | 改为基于时间戳的本地日期派生（fallback `localDateOf`） | migration / events 读写用例 |
| P0-6 | legacy 数据无安全迁移/自检 | `findSuspiciousNightSessions`（只读，六类异常检测）+ `repairNightSessionDate`（仅改日期+标注，**绝不静默覆盖**） | date_mismatch 检测 + repair 用例 |

### P1 — 可维护性与人工修正
| # | 问题 | 修复 |
|---|---|---|
| P1-1 | History 不可编辑/删除 | 新增编辑面板（sleepDate / phoneDownAt / targetTime / reasons / tonightMessage），校验 + `delayMinutes` 重算 + id 稳定 + `dateSource="manual"`；逐条删除带确认 |
| P1-2 | 缺审计字段 | 写入 `updatedAt` / `dateSource` |
| P1-3 | MorningSession 可重复 | `upsertMorningSessionByDate` 一天唯一 |
| P1-4 | `getLatestNightSession` 排序不稳定 | `cmpNightSession`（date↓ → completedAt↓ → sessionStartedAt↓ → id↓） |
| P1-5 | Analytics 计入非 completed | 聚合只统计 `completed` |
| P1-6 | `ContentSelector` usagePenalty 形同虚设 | `incrementContentUsage` 真正自增 `usageCount`/`lastShownAt` |

### P2
- 无后端；可疑记录检测（`findSuspiciousNightSessions`）为纯本地只读自检，不联网。

---

## 4. 测试结果（全部通过）

| 套件 | 项数 | 结果 |
|---|---|---|
| `tests/db.test.js` | 30 | ✅ 全绿 |
| `tests/sleepdate.test.js` | 8 | ✅ 全绿 |
| `tests/mvp.test.js` | 17 | ✅ 全绿 |
| `tests/ui-smoke.test.js` | 26 | ✅ 全绿 |
| `tests/architecture.test.js` | 101 | ✅ 全绿 |
| **合计** | **182** | **✅ 0 失败** |

覆盖：生命周期（active→completed）、跨午夜 23:29→04:01、legacy 修复、编辑（id 稳定 + delay 重算）、删除（精确一条）、时区（getLocalDate 本地派生而非 UTC slice）、迁移兼容（v1→v2 旧数据不丢）、深链已完成保护、Anchor source 语义。

---

## 5. 遗留 / 未决问题

1. **`repairNightSessionDate` 为单条修复 API**：UI 的「数据自检 → 一键修复」目前逐条调用；批量修复（如 `duplicate_completed` / `stale_active`）尚未提供聚合修复入口，需用户逐条确认。后续可加 `repairAllSuspicious()`（仍逐条 `dateSource=migration`，不静默覆盖）。
2. **`missing_times` / `unparseable_time` 仅检测不修复**：这类记录缺少可用时间戳，无法自动推算睡眠日，需人工编辑补全，未做自动处理（避免臆断）。
3. **`dateSource` 在导出/导入往返**：`exportAll` / `importAll` 已保留字段，但未对 `dateSource` 做专门的迁移/校验提示；旧备份导入后这些字段为空（视为 `auto`）。
4. **多设备/多时区**：`sleepDate` 以设备本地时区为准；跨时区同步同一 IndexedDB 不是本应用场景（无账户、本地优先），未处理。
5. **jsdom 回归不自退**：测试进程因 JSDOM 持有事件循环不会自动退出，需后台运行 + 读取输出文件（已在 `.dev-server.mjs` + 运行约定中固化）。

---

## 6. 验收场景对照（A–J 要点）

- **A 已完成才进 History** → `getCompletedNightSessions` 单一数据源 ✅
- **B 无 NaN / Invalid Date** → `fmtTime` 全覆盖 ✅
- **C 一个睡眠日一条 canonical** → 复用 active + 状态机 ✅
- **D 完成后再次入睡不覆盖** → `currentNightId` 重置 ✅
- **E 跨午夜归日统一** → `DateUtils.sleepDate(cutoff=4)` ✅
- **F legacy 兼容** → `phoneDownAt ?? actualSleepAt` ✅
- **G 安全迁移** → 只读自检 + 标注修复 ✅
- **H 人工编辑** → 编辑面板 + 校验 + 重算 ✅
- **I 删除** → 确认 + 精确一条 ✅
- **J 无后端/隐私** → 纯本地，无网络写入 ✅

---

*Commit: `5bd78a5`（已推送 `origin/main`，SSH）。关联前序 commit `ca1bd41`（completed 会话深链保护 + Anchor source 语义）。*
