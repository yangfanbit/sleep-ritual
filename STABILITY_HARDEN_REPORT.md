# Sleep Ritual 第一阶段：数据安全与稳定性收口 — 交付报告

> 阶段目标：只处理 P0 数据安全与高风险逻辑问题，**不新增产品功能、不重构无关模块**。
> 提交建议 message：`fix: harden data restore and sleep-date consistency`（已单独提交，未进入第二阶段）。

---

## 一、改动文件清单

### 源码（运行时）
| 文件 | 改动要点 |
|------|----------|
| `js/db.js` | 移除旧的 `importAll`（仅合并、无校验）；新增 `validateBackup()`、`normalizeBackup()`、`restoreAll()`；`exportAll()` 现返回 `schemaVersion`/`version = 2`；`CURRENT_SCHEMA_VERSION = 2`。 |
| `js/app.js` | 新增 `escapeHTML()`（并挂 `window.escapeHTML` 供测试）；`bindMorningSave()` 重写为「成功→终态 / 失败→真实报错 + 保留输入 + 不重复写入」；`renderHistory()` 的 `morningMessage` 改为 `textContent`（去 XSS）；数据自检渲染改用 `escapeHTML`；恢复 UI 改为「解析 → 校验 → 预览 → 确认/取消」。 |
| `js/date-utils.js` | 新增 `SLEEP_CUTOFF_MINUTES = 240`、`isAfterSleepCutoff(d, cutoff)`、`getSleepDateKey(d, cutoff)`；统一导出到 `DateUtils`。 |
| `js/analytics.js` | `bedtimeTrend()` 原 `minutes < 288`（04:48）改为读取 `DateUtils.SLEEP_CUTOFF_MINUTES`（240），消除隐含阈值。 |
| `index.html` | 早晨流新增 `<p id="morning-save-error" hidden>`；数据区新增恢复提示、`<div id="restore-preview" hidden>`，文件输入标签改为「恢复 JSON（覆盖）」。 |

### 测试
| 文件 | 状态 | 说明 |
|------|------|------|
| `tests/restore.test.js` | 新增 | 24 项：validate/normalize/restoreAll（数量守恒、失败安全、v1 兼容）。 |
| `tests/date-unify.test.js` | 新增 | 20 项：cutoff=04:00 边界 + 源码级阈值扫描。 |
| `tests/morning.test.js` | 新增 | 13 项：成功 / 失败 / 重试 / 不重复。 |
| `tests/xss.test.js` | 新增 | 8 项：`<script>` 与 `<img onerror>` 以纯文本渲染。 |
| `tests/architecture.test.js` | 修改 | `importAll → restoreAll` 语义更新（101 项）。 |
| `tests/db.test.js` | 修改 | 往返/坏备份改为 `restoreAll`（32 项）。 |
| `tests/ui-smoke.test.js` | 修改 | 注入 fake-indexeddb，避免无 DB 时早晨保存走旧「吞错」分支（26 项）。 |

---

## 二、Restore 与旧 Import 的语义差异

| 维度 | 旧 `importAll`（已移除） | 新 `restoreAll`（本阶段） |
|------|--------------------------|---------------------------|
| 语义 | **合并导入**：把备份数据并入当前库，不清空现有记录 | **整体覆盖恢复**：将数据库恢复到备份的状态（「以备份为准」） |
| 校验 | 无结构/字段校验，坏文件可能被静默吞掉 | `validateBackup()`：校验 `app === "sleep-ritual"`、`schemaVersion ≤ 2`、各 store 为数组、关键字段类型（如 `nightSessions[].date`、`morningSessions[].date`） |
| 预览 | 无 | 解析后展示「当前 vs 备份」各集合数量，明确提示「将以备份为准」，需二次确认 |
| 失败安全 | 写一半失败可能污染当前数据 | 还原在**单事务** `clear + put` 内完成（all-or-nothing），非法/不支持版本在触碰 DB 前即抛出，当前数据不动 |
| 反悔 | 无 | 恢复**成功之后**才把恢复前的快照写入 `lastRestoreBackup`，误恢复可再用备份反悔 |
| 旧版兼容 | — | `normalizeBackup()` 转换层：v1（无 `events`）自动补空数组，再统一恢复 |
| 文件覆盖 | 可能静默覆盖 | 永不静默覆盖；任何失败均报错，不写库 |

**职责分离**：`exportAll()`（导出）／`validateBackup()`（校验）／`normalizeBackup()`（版本归一）／`restoreAll()`（事务恢复）各自独立，避免职责耦合。

---

## 三、日期规则声明（统一 cutoff = 04:00）

**唯一规则**：以本地时间 **04:00** 为睡眠日分界。

- `00:00 – 03:59` 入睡 → 归**前一天**（`sleepDate` 返回昨日日期）。
- `04:00 – 23:59` 入睡 → 归**当天**。

**实现**：所有模块统一调用 `DateUtils.sleepDate()` / `isAfterSleepCutoff()` / `getSleepDateKey()`，禁止散落 `hour < 4`、`04:48`、`360`、`288`、`new Date().getDate()` 等隐含阈值。本阶段消除了三处分歧：
- `js/date-utils.js`：权威 `NIGHT_CUTOFF_HOUR = 4` + `SLEEP_CUTOFF_MINUTES = 240`。
- `js/analytics.js`：`bedtimeTrend()` 原 `minutes < 288`（04:48）改为 `SLEEP_CUTOFF_MINUTES`。
- `js/app.js`：`delayMinutes()` 原 `actual < 360`（06:00）改为 `SLEEP_CUTOFF_MINUTES`。

源码级扫描（`date-unify.test.js`）确认 `analytics.js` 不再含 `288`/`04:48`、`app.js` 不再含 `actual < 360`，且 `app.js` 引用 `SLEEP_CUTOFF_MINUTES`。

---

## 四、测试结果

运行方式（隔离 Node 工作区已装 `fake-indexeddb` + `jsdom`；jsdom 套件需本地服务器提供 `index.html`）：

```bash
# 纯函数/DB 套件
NODE_PATH=<workspace>/node_modules node tests/restore.test.js
NODE_PATH=<workspace>/node_modules node tests/date-unify.test.js
NODE_PATH=<workspace>/node_modules node tests/db.test.js

# jsdom 集成套件（先起服务器 SR_PORT=8795）
SR_PORT=8795 NODE_PATH=<workspace>/node_modules node tests/architecture.test.js
SR_PORT=8795 NODE_PATH=<workspace>/node_modules node tests/sleepdate.test.js
SR_PORT=8795 NODE_PATH=<workspace>/node_modules node tests/mvp.test.js
SR_PORT=8795 NODE_PATH=<workspace>/node_modules node tests/xss.test.js
SR_PORT=8795 NODE_PATH=<workspace>/node_modules node tests/morning.test.js
SR_PORT=8795 NODE_PATH=<workspace>/node_modules node tests/ui-smoke.test.js
```

> 注：`architecture`/`sleepdate`/`mvp` 为 jsdom 套件，跑完所有断言后会因 jsdom 保持事件循环而不自动退出（已知行为），属正常，断言已全部通过。

| 套件 | 结果 | 项数 |
|------|------|------|
| restore | ✅ | 24 |
| date-unify | ✅ | 20 |
| db | ✅ | 32 |
| architecture | ✅ | 101 |
| xss | ✅ | 8 |
| morning | ✅ | 13 |
| ui-smoke | ✅ | 26 |
| sleepdate | ✅ | 8 |
| mvp | ✅ | 17 |
| **合计** | **✅ 0 失败** | **249** |

**关键回归点覆盖**：
- Restore：合法/非法 JSON、错误 `app`、超出版本（99）、非数组、缺失关键字段、v1 无 `events` 兼容、数量守恒、失败安全（坏备份不动当前数据）、`lastRestoreBackup` 写入时机。
- Morning：保存成功（进入终态、清空输入、写入 1 条）、`upsert` 幂等（不重复）、保存失败（不进终态、报错可见、输入保留、写入 0 条）、重试（终态可见、恰好 1 条、报错隐藏）。
- XSS：`<script>alert(1)</script>` 与 `<img src=x onerror=alert(1)>` 在 History 中仅作为**文本**出现，绝不生成 `<script>`/`<img>` 元素。
- 日期：23:59 / 00:00 / 00:30 / 03:59 / 04:00 / 04:01 / 12:00 全部一致（cutoff 在 04:00，非 04:48 / 06:00）。

---

## 五、风险检查

| 风险点 | 评估 | 缓解 |
|--------|------|------|
| 恢复误覆盖用户数据 | 中→低 | 先校验、再预览、再二次确认；成功后才写 `lastRestoreBackup` 快照，可反悔。 |
| 恢复事务中途失败污染数据 | 低 | 单事务 `clear+put` all-or-nothing；非法/超版本在触碰 DB 前抛出；数量守恒校验兜底。 |
| 旧备份（v1）无法恢复 | 低 | `normalizeBackup()` 转换层补齐缺省 store。 |
| 早晨保存失败被静默吞掉 | 已消除 | `bindMorningSave` 捕获异常并真实反馈，输入保留，可重试。 |
| 早晨重复点击产生重复记录 | 已消除 | `upsertMorningSessionByDate` 按日期幂等。 |
| 用户输入触发 XSS | 已消除 | 用户文本统一 `textContent`；动态插值经 `escapeHTML`。 |
| 睡眠日归日不一致 | 已消除 | 单一 `DateUtils` 阈值（04:00），源码级扫描锁死漂移。 |
| 误触第二阶段功能 | 无 | 本阶段仅做数据/稳定性收口，未新增任何产品功能、未引入后端/云同步、未改 SleepTown 核心。 |

**禁止事项核对**：✅ 未新增统计页 / AI 功能 / SleepTown 核心改动 / 通知 / 大改 UI / 后端 / 云同步 / 全量 DB 重写。

---

## 六、Git 提交建议（已执行）

建议本阶段**单独提交**，与功能开发分离：

```
fix: harden data restore and sleep-date consistency

- 重定义「恢复」语义：整体覆盖（非旧 import 的仅合并），新增
  validateBackup/normalizeBackup/restoreAll，单事务恢复 + 数量守恒校验
  + 失败安全 + lastRestoreBackup 反悔快照（写于事务之后，修复被清空 bug）
- 早晨保存失败真实反馈：catch 异常、提示重试、保留输入、幂等不重复
- 清理 innerHTML XSS：用户输入走 textContent，新增统一 escapeHTML
- 统一睡眠日期规则：cutoff=04:00（SLEEP_CUTOFF_MINUTES=240），
  analytics/app.js 移除 288/360 隐含阈值，统一 DateUtils 入口
- 新增 restore/date-unify/morning/xss 测试，更新 architecture/db/ui-smoke
- 全部 9 套件 249 项断言通过，0 失败
```

已执行的动作：
- `git add` 上述 8 个修改文件 + 4 个新增测试文件（单独提交，未混入其他改动）。
- `git commit -m "fix: harden data restore and sleep-date consistency"`。
- `git push origin main`。

> 下一步：请勿擅自进入第二阶段功能开发；本阶段收口已完成并入库。
