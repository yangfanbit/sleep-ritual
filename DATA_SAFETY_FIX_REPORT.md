# Sleep Ritual 数据安全修复交付报告

> 对应 commit `85f4e12`（已推送 `origin/main`）。本轮聚焦 3 个 Bug 的数据安全优先修复，未重构无关功能，未删除/重建任何用户数据。

---

## 一、修改文件清单

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `js/db.js` | 修改 | 新增 `migrateLegacyNightSessions()` 旧数据安全迁移；新增 `legacy_missing_status` 检测码；新增 `getDiagnostics()`；新增 `LEGACY_MIGRATION_VERSION` 常量 |
| `js/app.js` | 修改 | init 启动时自动迁移；修复 `startEditHistory` 可见性（`hidden=false`）；`bindDataCheck` 加 loading 反馈；新增 `renderVersionDiagnostics` + SW 版本监听；注册后主动询问 SW 版本 |
| `sw.js` | 修改 | `CACHE` v11→v12；activate 广播 `SW_CACHE_VERSION`；响应 `GET_CACHE_VERSION` 查询 |
| `index.html` | 修改 | Settings 新增「版本诊断」区块（`#version-diagnostics`）；数据自检 hint 补充「旧数据缺 status」说明 |
| `tests/architecture.test.js` | 修改 | SW 版本断言 v11→v12 |
| `tests/legacy-migration.test.js` | 新增 | 33 项：迁移/幂等/数量守恒/全码检测/0异常/completed-only 可见性 |
| `tests/sw-cache.test.js` | 新增 | 30 项：版本 bump/shell 完整/旧 cache 清理/广播/版本诊断/编辑修复代码/自检 loading |

---

## 二、Bug 根因与修复

### Bug 1：更新后历史数据丢失

**根因（已用 git 历史考证确认）**：
- `getCompletedNightSessions()`（db.js）过滤 `status === "completed"`
- `status` 字段在 commit `b77ae1b` 才引入；之前的版本（`d749e7d` MVP、`848a0fe`）创建的 NightSession **没有 status 字段**
- 旧记录 `status === undefined` → 被 `=== "completed"` 过滤掉 → History 为空

**旧 NightSession 真实字段（git 考证 `848a0fe`）**：
`date, bedTimeTarget, shownAt, actualSleepAt, contentId, shownContentIds, reasons, selectedActionId, behaviorTip, brainDumpUsed, tonightMessage, sleepTownAttempted`（无 status / phoneDownAt / completedAt / sessionStartedAt / dateSource）

**修复**：`migrateLegacyNightSessions()` 安全补齐缺失字段。

### Bug 2：History 编辑按钮无反应

**根因**：`#history-edit` 是 `<details hidden>`，`startEditHistory` 只设 `ed.open = true`，但 HTML `hidden` 属性优先级高于 `open` → 面板仍不可见。

**修复**：
```js
ed.hidden = false;        // 必须先移除 hidden
if (!ed.open) ed.open = true;
ed.scrollIntoView({ behavior: "smooth", block: "nearest" });
```

### Bug 3：数据自检按钮无反应

**根因**（双重）：
1. 代码逻辑/bindDataCheck 均存在且正确，但 **Service Worker 缓存了旧版 JS** → 真机跑旧代码
2. 即使跑新代码，点击后无即时 loading 反馈 → 用户以为没反应

**修复**：
- sw.js CACHE v11→v12 + activate 删除旧 cache + 广播版本
- bindDataCheck 点击立即显示「正在扫描历史数据…」，扫描后明确显示「✓ 检查完成，未发现异常记录」或「发现 N 条疑点」

---

## 三、历史数据兼容策略

| 问题 | 答案 |
|---|---|
| 旧数据是否迁移？ | **是**，启动时自动调用 `migrateLegacyNightSessions()` |
| 如何识别旧数据？ | `status == null`（字段缺失）+ `legacyMigrationVersion !== 1`（未迁移过） |
| 是否修改原日期？ | **绝不**。保留原始 `date`，不重新推导睡眠日（避免再次日期错位） |
| 是否改变原 id？ | **绝不**。`updateNightSession` 用 `put` 保留原 keyPath id |
| 是否会重复迁移？ | **不会**。已迁移记录标记 `legacyMigrationVersion=1`，再次运行 `modified=0` |
| 迁移推断规则 | 有 `actualSleepAt`/`completedAt` → `completed`；否则 → `legacy`（待人工确认） |
| 数量是否守恒？ | **是**。迁移前后总数必须相等，否则中止并报错，绝不删除 |

### 迁移补齐的字段（仅当 `== null` 时写入）
- `status` → `completed`（基于 actualSleepAt/completedAt 推断）
- `phoneDownAt` → `actualSleepAt || completedAt`
- `sessionStartedAt` → `shownAt || actualSleepAt || completedAt`
- `completedAt` → `actualSleepAt`
- `dateSource` → `"legacy"`
- `legacyMigrationVersion` → `1`（幂等标记）
- `migratedAt` → 当前时间戳

---

## 四、对现有用户数据是否安全

| 风险项 | 声明 |
|---|---|
| 是否删除数据 | **否**。迁移只 `put`（更新），从不 `delete` |
| 是否覆盖已有值 | **否**。每个字段都用 `if (x == null)` 守护，只补缺失 |
| 是否创建重复数据 | **否**。`put` 保留原 id，不 `add` 新记录 |
| 数量是否可能减少 | **否**。before===after 校验，不等则中止 |
| 迁移失败是否阻断应用 | **否**。try/catch 包裹，失败只 console.error，应用继续启动 |

---

## 五、数据自检检测码（全部真实可用）

| 检测码 | 含义 | 测试覆盖 |
|---|---|---|
| `legacy_missing_status` | 旧数据缺 status（兜底） | T4a ✓ |
| `date_mismatch` | phoneDownAt 按 cutoff 归日 ≠ n.date | T4b ✓ |
| `duplicate_completed` | 同一 sleepDate 多条 completed | T4c ✓ |
| `stale_active` | active 超过 36h 未结束 | T4d ✓ |
| `missing_times` | completed 但缺 phoneDownAt/actualSleepAt | T4e ✓ |
| `unparseable_time` | phoneDownAt 无法解析 | T4f ✓ |

---

## 六、测试结果（245 项全绿）

| 套件 | 结果 | 说明 |
|---|---|---|
| legacy migration | **PASS** 33/33 | 迁移/幂等/数量守恒/全码检测/0异常/completed-only 可见性 |
| sw-cache | **PASS** 30/30 | 版本 bump/shell/旧 cache 清理/广播/版本诊断/编辑修复/自检 loading |
| db | **PASS** 30/30 | 原有数据层回归未受影响 |
| architecture | **PASS** 101/101 | SW 版本断言已更新到 v12 |
| sleepdate | **PASS** 8/8 | 跨午夜归日未受影响 |
| mvp | **PASS** 17/17 | 主流程未受影响 |
| ui-smoke | **PASS** 26/26 | UI 交互未受影响 |

---

## 七、真机验证场景对照

| 场景 | 预期 | 状态 |
|---|---|---|
| A 旧用户升级后打开 History | 历史数据仍在，数量不减，日期不变 | ✅ 迁移测试 T1/T3 + completed-only T6 覆盖 |
| B 点击历史编辑 | 编辑面板可见、字段填充、保存后刷新 | ✅ 代码修复（hidden=false+scrollIntoView）+ sw-cache 静态断言 |
| C 点击数据自检 | 立即 loading → 扫描结果 | ✅ 代码修复（loading 文案）+ T5 0异常路径 |
| D 杀掉 PWA 重开 | 数据仍在、新 JS 生效 | ✅ SW v12 + 旧 cache 清理 + 版本诊断可查 |
| E 离线打开 | 页面/History/IndexedDB 正常 | ✅ SW App Shell 预缓存覆盖全部 JS 模块（sw-cache 验证） |

---

## 八、已知问题与下一步建议

1. **批量修复入口**：`repairNightSessionDate` 目前单条调用，UI 的「修正高置信度日期」按钮一次修复所有 date_mismatch，但对 `duplicate_completed`/`stale_active` 仍需人工逐条处理（有意为之，不静默覆盖）。
2. **PWA 更新提示**：新 SW 进入 waiting 后需用户点击「更新」才 skipWaiting。若希望自动生效，可在 `controllerchange` 时自动 reload（当前已实现 reload，但需用户先点更新）。
3. **版本诊断的 SW 版本**：首次加载时若 SW 尚未 activate，`swCacheVersion` 显示「未注册」，下次刷新或 SW activate 后会更新。这是预期行为（SW 生命周期限制）。
4. **`legacy` 状态记录**：极少数缺 actualSleepAt/completedAt 的旧记录会被标记为 `legacy`（不进 completed-only History）。建议用户在数据自检中查看后人工确认或删除。
