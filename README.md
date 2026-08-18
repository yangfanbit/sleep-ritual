# Sleep Ritual

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
```

## 测试

回归套件（共 5 套、135 项，零运行时依赖进项目）：

| 测试 | 项数 | 说明 | 需服务器 |
| --- | --- | --- | --- |
| `tests/db.test.js` | 30 | 数据层：种子/设置/两类 session/events 读写/导出导入往返/清空重播种/v1→v2 迁移 | 否 |
| `tests/sleepdate.test.js` | 8 | `sleepDate()` 凌晨归前一天的日期边界 | 是（默认 8788，可 `SR_PORT` 指定） |
| `tests/mvp.test.js` | 17 | MVP 闭环：原因→内容匹配 / session 字段完整性 / History | 是（SR_PORT） |
| `tests/ui-smoke.test.js` | 26 | UI 冒烟：视图/按钮/容错（存储失败不阻断） | 是（SR_PORT） |
| `tests/architecture.test.js` | 54 | 架构级：迁移/events/ContentSelector/Analytics/深链/重入/SW 壳完整 | 是（SR_PORT） |

依赖装在隔离 Node 工作区，不进入项目：

```bash
npm install jsdom fake-indexeddb
```

jsdom 类测试（ui-smoke / mvp / architecture / sleepdate）需先在项目根目录起一个静态服务器（任意端口），并用 `SR_PORT` 告知测试：

```bash
python -m http.server 8795 &   # 或 npx serve . 等，端口任意
SR_PORT=8795 NODE_PATH=<工作区>/node_modules node tests/ui-smoke.test.js
SR_PORT=8795 NODE_PATH=<工作区>/node_modules node tests/architecture.test.js
```

注：Windows 本机若有系统代理（如 7897），Node 经 localhost 加载页面会被截断。测试前清空代理——用 `HTTP_PROXY= HTTPS_PROXY=` 前缀（**不要**用 `env -u HTTP_PROXY`，后者会吞掉 node 的 stdout）：

```bash
HTTP_PROXY= HTTPS_PROXY= SR_PORT=8795 NODE_PATH=<工作区>/node_modules node tests/architecture.test.js
```

## 数据

全部数据只存在本机 IndexedDB。设置页提供 JSON 导出/导入做备份和迁移。

## 设计约束（不可违反）

1. 单次使用 30 秒 ~ 2 分钟，越短越好
2. 不做无限滚动、不做内容流、不做复杂日记
3. 不用羞辱式反馈，不出现「失败」「断签」「重新开始」
4. 夜间界面低刺激：深黑底、柔和灰文字、少动画、低信息密度
5. 内容只是干预入口，每晚只展示一条
