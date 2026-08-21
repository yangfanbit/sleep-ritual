# Sleep Ritual 第二阶段：测试体系与 CI 工程化 — 交付报告

> 阶段目标：测试可移植性 + `npm test` 一键运行 + GitHub Actions 自动测试 + 基础质量门禁。
> **不新增产品功能、不大改 UI。** 提交 message：`test: make test suite portable and add CI gate`（单独提交）。

---

> **当前测试状态（持续同步）**：本仓库最新全量 `npm test` 为 **17 套件 / 441 项断言**全部通过（Unit 243 + Smoke 198）。本报告中的 12 套件 / 320 项断言为该阶段（测试体系与 CI）的快照，仅用于回溯当阶段交付范围，不代表当前总数。

## 一、测试环境

| 项 | 版本 / 说明 |
|----|------------|
| Node | v22.22.2（CI 固定 `22`，`engines` 声明 `>=20`） |
| npm | 10.9.7 |
| Browser | 无浏览器依赖；jsdom 30.0.1 模拟 DOM，fake-indexeddb 6.2.5 模拟存储 |
| 运行平台 | Windows / macOS / Linux / Codex / GitHub Actions（ubuntu-latest）均验证可用 |
| 构建 | 无构建步骤（纯静态 PWA），CI 不含 build/lint |

---

## 二、测试命令

| 命令 | 作用 | 需服务器 |
|------|------|---------|
| `npm test` | **一键完整入口**：先 unit 后 smoke，自动拉起本地静态服务器跑 jsdom 套件，跑完关闭，整体退出码反映成败 | 自动 |
| `npm run test:unit` | 纯 Node 套件（DateUtils / DB / 迁移 / Analytics / SW 静态分析 / Restore 校验 / 长期回归门禁），无需服务器，最快 | 否 |
| `npm run test:smoke` | jsdom 集成 / 冒烟套件（页面加载 / 路由 / PWA 壳 / 核心按钮 / Night→Morning / History / XSS / Morning 失败反馈），自动起服务器 | 自动 |

实现：`tools/run-tests.mjs` 统一运行器，按 `unit`/`smoke`/`all` 分类 spawn 各套件，解析 PASS/FAIL 与断言数，汇总后以退出码判定成败。

---

## 三、测试分类

| 分类 | 套件 | 项数 |
|------|------|------|
| **Unit** | db / date-unify / restore / regression / legacy-migration / sw-cache | 32 + 20 + 24 + 8 + 33 + 30 = **147** |
| **Integration / Smoke** | sleepdate / mvp / xss / morning / ui-smoke / architecture | 8 + 17 + 8 + 13 + 26 + 101 = **173** |
| **合计** | 12 套件 | **320** |

---

## 四、CI

**文件**：`.github/workflows/test.yml`

**触发条件**：`push` 到 `main` + `pull_request` 到 `main`（`concurrency` 取消同分支旧运行）。

**执行步骤**：
```
checkout
  → setup-node@v4 (node 22, npm cache)
  → npm ci
  → npm test
```

**CI 能发现的问题（对应第五节防回归清单）**：
- 日期规则被改回错误阈值 → `date-unify` 源码级扫描 + `regression` 边界断言
- migration 失败 / 丢数据 → `legacy-migration` 数量守恒 + `regression` 守恒门禁
- restore 数据丢失 → `restore` 数量守恒 + `regression` A→B=B 门禁
- History 编辑 / 删除回归 → `architecture` 编辑删除 + `regression` Edit 计数 / Delete 不存在门禁
- 数据自检失效 → `architecture` findSuspicious + `regression` Data Health 门禁 + `legacy-migration` 全码检测
- 用户文本变成 HTML → `xss` 纯文本渲染断言
- 核心页面加载错误 / 关键 JS 语法错误 → 所有 smoke 套件经 `jsdom.fromURL` 真实加载 index.html 及全部 JS，语法错误即加载失败

---

## 五、机器路径清理（可移植性）

清除全部硬编码绝对路径，改用相对定位：

| 文件 | 原 | 现 |
|------|----|----|
| `.dev-server.mjs` | `resolve("D:/GitHub Space/sleepearly")` | `dirname(fileURLToPath(import.meta.url))`（脚本自身目录） |
| `tests/db.test.js` | `"D:/GitHub Space/sleepearly"` | `path.resolve(__dirname, "..")` |
| `tests/legacy-migration.test.js` | `"D:/GitHub Space/sleepearly"` | `path.resolve(__dirname, "..")` |
| `tests/sw-cache.test.js` | `"D:/GitHub Space/sleepearly"` | `path.resolve(__dirname, "..")` |

其余套件（architecture / date-unify / restore / mvp / sleepdate）本就用 `path.resolve(__dirname, "..")`，无需改。

**附带修复**：`architecture` / `sleepdate` / `mvp` / `ui-smoke` 四个 jsdom 套件原仅设 `process.exitCode` 不调用 `process.exit`，导致跑完不退出（jsdom 保持事件循环）。补 `process.exit()`，使 CI / 运行器能可靠收尾。

---

## 六、长期保护性回归门禁

新增 `tests/regression.test.js`（8 项，纯 Node），对应「六」要求的六类场景，每类规范化断言：

| 场景 | 断言 |
|------|------|
| 历史数据 migration | 数量守恒（前后相等）+ 字段正确（补 status=completed，保留原 date/id） |
| 日期 | 03:59 → 前一天 / 04:00 → 当天 |
| Restore | current A → restore B → 最终仅剩 B（A 被覆盖） |
| Edit | 编辑后仍只有 1 条、id 不变、字段已更新 |
| Delete | 删除后列表为空、按 id 查为空 |
| Data Health | 构造 date_mismatch 错误数据 → findSuspicious 能发现 |

不重复已有套件的完整流程，仅作 CI 可见的最小门禁。

---

## 七、最终测试结果

```
npm test  →  320/320 通过，0 失败（12 套件）
```

| 分类 | 通过 / 总计 |
|------|------------|
| Unit | 147 / 147 |
| Integration / Smoke | 173 / 173 |
| **Total** | **320** |
| **Passed** | **320** |
| **Failed** | **0** |

---

## 八、改动文件清单

### 新增
| 文件 | 说明 |
|------|------|
| `package.json` | devDependencies（fake-indexeddb 6.2.5 / jsdom 30.0.1）+ npm 脚本 + engines |
| `package-lock.json` | 锁定依赖，供 `npm ci` |
| `tools/run-tests.mjs` | 统一测试运行器（unit / smoke / all，自动起服务器） |
| `tests/regression.test.js` | 长期保护性回归门禁（8 项） |
| `.github/workflows/test.yml` | GitHub Actions CI |

### 修改
| 文件 | 说明 |
|------|------|
| `.dev-server.mjs` | ROOT 改为 `import.meta.url` 相对定位 |
| `tests/db.test.js` / `legacy-migration.test.js` / `sw-cache.test.js` | root 改为 `path.resolve(__dirname, "..")` |
| `tests/architecture.test.js` / `sleepdate.test.js` / `mvp.test.js` / `ui-smoke.test.js` | 补 `process.exit()` 可靠退出 |
| `README.md` | CI 徽章 + 测试章节重写（npm 入口 + 套件表 + 分类） + 目录结构补 tools/package.json/workflow |

---

## 九、Git 提交

```
test: make test suite portable and add CI gate

- 清除测试中的机器绝对路径（.dev-server.mjs / db / legacy-migration /
  sw-cache），改 import.meta.url / path.resolve(__dirname,..)，Win/Mac/Linux/CI 通用
- 新增 package.json + package-lock.json（fake-indexeddb 6.2.5 / jsdom 30.0.1），
  npm ci 后无需外部 NODE_PATH
- 新增 tools/run-tests.mjs 统一运行器：npm test / test:unit / test:smoke，
  自动拉起本地服务器跑 jsdom 套件并汇总
- jsdom 套件补 process.exit()，CI 可靠收尾
- 新增 tests/regression.test.js 长期保护门禁（migration 守恒 / 日期 / Restore=A→B /
  Edit 计数 / Delete / Data Health）
- 新增 .github/workflows/test.yml：push/PR → npm ci → npm test
- README 增加 CI 徽章 + 重写测试章节
- 全量 npm test：12 套件 320 项断言通过，0 失败
```

本阶段完成，**未进入下一阶段产品功能开发**。
