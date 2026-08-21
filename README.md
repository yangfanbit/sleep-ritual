# Sleep Ritual

![CI](https://github.com/yangfanbit/sleep-ritual/actions/workflows/test.yml/badge.svg)

一个跨平台（iOS / Android / 桌面浏览器）的个人睡前行为干预 PWA。

不是睡眠记录 App，是"睡前行为干预器"。核心逻辑：

**Anchor → Buffer → Transition**

到了设定的睡前时间，通过 iPhone Shortcut 打开它 → 不催促睡觉，先理解"我为什么现在还不想睡" → 用一个极低成本的行为替代完成缓冲 → 写一句给明天的自己 → 放下手机，进入 SleepTown 执行真正的睡眠。

- Sleep Ritual 负责心理和行为干预
- SleepTown 负责睡眠执行和闹钟

## 边界

本项目完全独立于个人博客（yfnwu.com / Gridea Pro）。不读、不改、不依赖博客的任何代码和部署方式。未来独立部署到 `https://sleep.yfnwu.com/`。

## 支持平台与进入睡前流程

跨平台 PWA：iOS（Safari「添加到主屏幕」standalone）、Android（Chrome「安装应用」）、桌面浏览器均可用，体验一致。

进入睡前流程有三种入口，统一抽象为 `AnchorProvider`，最终都落到 `#/night` 深链，iOS standalone 下无需 Shortcut 自动唤起：

- **手动**：打开 App，按时间默认进入 Night 视图（05:00–11:59 默认 Morning，其余 Night）。
- **深链**：直接打开 `index.html#/night` 即强制进入睡前流程（同晚已完成则重开该会话，不重复建）。这是跨平台统一入口，可放进主屏快捷方式、自动化或通知。
- **Shortcut / 通知**（可选）：历史上依赖 iPhone Shortcut 自动打开——现已不再是必要路径；任何能打开该 URL 的方式都等效。

`AnchorProvider.getCurrentSource()` 记录来源（`home_screen` / `shortcut` / `manual` / `notification` / `unknown`），写入 `NightSession.source`，用于后续分析「哪种入口更能促使用户完成睡前流程」。

## 技术栈

纯前端，无构建步骤：

- HTML / CSS / Vanilla JS
- PWA（manifest + Service Worker，离线可用）
- IndexedDB（local-first，无后端、无登录、无云同步）
- JSON 导出 / 导入
- 可部署到 GitHub Pages 等任意静态托管

## 本地运行

Service Worker 和 PWA 能力需要 HTTP 环境，不能用 `file://` 直接打开。

```bash
# 在项目根目录任选其一
python -m http.server 8080
# 或
npx serve .
```

浏览器打开 `http://localhost:8080` 即可。

真机调试：让手机和电脑在同一局域网，访问 `http://<电脑局域网IP>:8080`，然后通过「添加到主屏幕」以 standalone 模式运行（iOS Safari / Android Chrome 均支持）。进入睡前流程可用深链 `http://<电脑局域网IP>:8080/index.html#/night`——这是跨平台统一的入口，iOS standalone 下不依赖 Shortcut 自动唤起。

## 目录结构

```
index.html            入口，四个视图容器 + 底部导航
css/styles.css        全局样式（Night 深色 / Morning 明亮两套视觉）
js/content.js         原因选项、行为替代规则表、初始内容库种子
js/db.js              IndexedDB 数据层（v2：settings / content / 两类 session / events 行为日志）
js/anchor.js          AnchorProvider：入口来源抽象 + #/night 深链解析（跨平台）
js/content-selector.js ContentSelector：夜间内容规则评分选择器（原因匹配 + 权重 + 去重 + 探索噪声）
js/analytics.js       Analytics：睡前行为干预效果与趋势的纯函数层（跨午夜安全）
js/app.js             视图路由 + 全部交互逻辑
manifest.webmanifest  PWA 清单
sw.js                 Service Worker（离线缓存）
assets/icons/         PWA / Apple touch 图标
docs/PRD.md           产品需求文档
docs/DECISIONS.md     关键技术决策记录
tests/                无头回归测试（jsdom + fake-indexeddb，不进构建）
tools/run-tests.mjs   统一测试运行器（unit / smoke / all，自动拉起本地服务器）
package.json          开发依赖与 npm 脚本（无运行时依赖、无构建步骤）
.github/workflows/test.yml  CI：push / pull_request 自动跑 npm test
```

## 测试

依赖（`fake-indexeddb` + `jsdom`）记入 `devDependencies`，`npm ci` 后即可一键运行：

```bash
npm test            # 全部套件（先 unit 后 smoke，自动拉起本地静态服务器）
npm run test:unit   # 纯 Node 套件（无需服务器，最快）
npm run test:smoke  # jsdom 集成 / 冒烟套件（自动起服务器）
```

分类说明：

| 分类 | 命令 | 覆盖 |
| --- | --- | --- |
| Unit | `npm run test:unit` | DateUtils 边界、DB 数据层、迁移、Analytics、ContentSelector、SW 缓存静态分析、Restore 校验、长期回归门禁、30 天趋势、Duplicate 解决 |
| Integration / Smoke | `npm run test:smoke` | 页面加载、路由（深链）、PWA 壳、核心按钮、Night→Morning 闭环、History（含编辑/删除异常）、XSS 渲染、Morning 失败反馈 |

全量 `npm test` 共 17 套件 / 441 项断言（Unit 243 + Smoke 198），详见下表。

套件明细（`npm test` 全量）：

| 测试 | 项数 | 说明 | 分类 |
| --- | --- | --- | --- |
| `tests/db.test.js` | 32 | 数据层：种子/设置/两类 session/events 读写/导出恢复往返/清空重播种/v1→v2 迁移 | Unit |
| `tests/date-unify.test.js` | 20 | 睡眠日 cutoff=04:00 边界 + 源码级阈值扫描 | Unit |
| `tests/restore.test.js` | 24 | validateBackup / normalizeBackup / restoreAll（数量守恒、失败安全、v1 兼容） | Unit |
| `tests/regression.test.js` | 8 | 长期保护门禁：migration 守恒 / 日期 / Restore=A→B / Edit 计数 / Delete / Data Health | Unit |
| `tests/trends.test.js` | 43 | 30 天趋势：放下手机统计 / 以前→现在 / 30 vs 7 天 / 高频原因 / 微行为趋势 / 关联 / 数据充分性边界 / 空 / 跨午夜 / 异常 | Unit |
| `tests/duplicate.test.js` | 13 | Duplicate 安全解决：检测 / 保留A删B / 只影响该日 / events 可追踪 / 重扫清零 | Unit |
| `tests/personalize.test.js` | 26 | 个体化：reason match / 去重 / recent usage penalty / 数据不足 / 新用户 / 历史充足 / 熬夜模式阈值 | Unit |
| `tests/legacy-migration.test.js` | 33 | 旧数据安全迁移 + Data Check 全码检测 + 幂等 + 数量守恒 | Unit |
| `tests/db-reliability.test.js` | 13 | 数据可靠性：并发创建唯一 active / 迁移单事务原子性（中断不半迁移）/ 幂等可重试 | Unit |
| `tests/sw-cache.test.js` | 31 | SW 缓存版本 / App Shell 完整性 / 旧 cache 清理（静态分析） | Unit |
| `tests/sleepdate.test.js` | 8 | `sleepDate()` 凌晨归前一天的日期边界（跨月/跨年） | Smoke |
| `tests/mvp.test.js` | 17 | MVP 闭环：原因→内容匹配 / session 字段完整性 / History | Smoke |
| `tests/xss.test.js` | 8 | 用户文本以纯文本渲染，绝不生成 `<script>`/`<img>` | Smoke |
| `tests/morning.test.js` | 13 | 早晨保存成功 / 失败真实反馈 / 重试 / 不重复 | Smoke |
| `tests/ui-smoke.test.js` | 26 | UI 冒烟：视图/按钮/容错/配对 | Smoke |
| `tests/architecture.test.js` | 102 | 架构级：迁移/events/ContentSelector/Analytics/深链/重入/SW 壳/编辑删除/数据自检 | Smoke |
| `tests/history-error.test.js` | 24 | History 编辑/删除失败注入：编辑框保持/输入保留/可见错误/记录未变；删除失败保留记录；快速双击不重复；读取失败优雅降级；Data Check Repair 失败不假成功（记录不标记/不改日期/可见错误）+ Repair 成功改日期并标记 | Smoke |

CI（`.github/workflows/test.yml`）：任何 push 到 `main` 或 pull_request 都会自动 `npm ci` + `npm test`，全绿才视为可部署。

## 数据

全部数据只存在本机 IndexedDB。设置页提供 JSON 导出/导入做备份和迁移。

## 设计约束（不可违反）

1. 单次使用 30 秒 ~ 2 分钟，越短越好
2. 不做无限滚动、不做内容流、不做复杂日记
3. 不用羞辱式反馈，不出现「失败」「断签」「重新开始」
4. 夜间界面低刺激：深黑底、柔和灰文字、少动画、低信息密度
5. 内容只是干预入口，每晚只展示一条
