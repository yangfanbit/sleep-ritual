# DECISIONS — Sleep Ritual

记录关键技术决策及其理由。新决策追加在文末。

## D1. 纯 Vanilla 三件套，无框架无构建（2026-08-16）

**决定**：HTML + CSS + Vanilla JS，单页四个视图，无构建步骤。

**理由**：项目要求极轻量、GitHub Pages 可直接部署、首屏秒开；交互复杂度低（单方向表单流），框架反而是负担。脚本以普通 `<script src>` 按序加载（content.js → db.js → app.js），不引入模块化打包。

## D2. 单页视图切换而非多页面（2026-08-16）

**决定**：Night / Morning / History / Settings 四个 `<section>` 放在同一 `index.html`，用底部标签栏切换，配合 hash（`#/night` 等）保持可返回性。

**理由**：PWA 下多页面跳转有闪白；单页切换零延迟，符合「停留时间越短越好」的原则。hash 用于记录当前视图，刷新后回到同一页。

## D3. 按时段决定默认视图，不做强制锁定（2026-08-16）

**决定**：05:00–11:59 默认进入 Morning，其余时间默认进入 Night；用户可随时手动切换。

**理由**：Anchor 由 iPhone Shortcut 触发（外部），App 内只需温和猜测上下文。强制锁定会在用户作息不规律时制造挫败感，违反「不羞辱」原则。

## D4. IndexedDB 而非 localStorage（2026-08-16）

**决定**：四个 object store：`settings`（keyPath key）、`content`、`nightSessions`、`morningSessions`（后三者自增 id，session 加 date 索引）。

**理由**：session 是持续追加的结构化记录，localStorage 只能存字符串且容量/结构化查询都不适合；IndexedDB 是 PWA local-first 的标准选择。`js/db.js` 只做薄封装，所有读写为 Promise 风格。

## D5. Brain Dump 物理上不写入任何存储（2026-08-16）

**决定**：Brain Dump 文本只存在于 DOM，`丢掉`按钮只清空 + 800ms 淡出，不触碰 IndexedDB。

**理由**：需求强调「写完就消失」是干预的一部分——用户必须确信它不会被保存，才敢真正倾倒。代码层面不保存比「保存了但不展示」更诚实。

## D6. 行为替代用查表规则，不调用 AI（2026-08-16）

**决定**：`js/content.js` 中 `BEHAVIOR_TIPS` 常量表，原因 id → 固定文案；选了多个原因时取第一个的提示。

**理由**：需求明确不调 AI；离线可用、零延迟、文案可控。后续如要个性化，先把表改成可配置数组，再考虑更复杂的来源。

## D7. SleepTown 跳转：尝试 + 显式备用按钮（2026-08-16）

**决定**：点「开始睡觉」→ 先保存 NightSession → `location.href = "sleeptown://"` 尝试跳转 → 同时显示常驻的「打开 SleepTown」按钮。

**理由**：`sleeptown://` scheme **未验证**。iOS 上自定义 scheme 跳转无法可靠检测失败，因此不做脆弱的成功判定，而是让备用按钮始终可见——保存睡眠记录这个动作与打开 SleepTown 完全解耦，scheme 失效不影响 App 任何功能。

**2026-08-16 补充查证与强化**：

- `sleeptown://` 收录于社区维护的 iOS App URL 清单（GitHub `meseck/app-urls`），但 SEEKRTECH 官方无 URL Scheme 文档——社区记录级别，仍不当事实依赖。
- iOS standalone PWA 唤起自定义 scheme：iOS 13 起通常可唤起已安装 App，但**无成功回调**；唯一可用信号是 `visibilitychange`（页面是否进后台）。
- 实现强化：尝试跳转 2.2 秒后页面仍可见 → 显示「看起来没有跳转。没装 SleepTown 也没关系——直接放下手机就好。」；手动按钮始终常驻晚安页。
- 已知风险：若 iPhone 未装 SleepTown，自动尝试可能每晚弹「无法打开页面」类系统提示。真机验证若确认烦扰，降级为纯手动按钮（移除自动尝试一行即可）。

## D8. Service Worker：App Shell 预缓存 + 网络回退（2026-08-16）

**决定**：`sw.js` 安装时预缓存全部 shell 资源（HTML/CSS/JS/manifest/图标），fetch 时 cache-first、后台更新。

**理由**：App 是全静态的，所有资源可以一次预缓存；这保证离线可用和「首页秒开」。版本号变更靠修改 `CACHE` 常量，activate 时清旧缓存。

## D9. JSON 导出/导入作为唯一备份通道（2026-08-16）

**决定**：导出整个数据库四个 store 为单个 JSON（含 `app: "sleep-ritual"` 与版本字段）；导入时校验标识后按 keyPath 覆盖写入。

**理由**：无账号无云同步，导出文件是用户数据的唯一保障。带标识字段防止误导入其他应用的 JSON。

## D10. 历史页按 date 关联早晚记录（2026-08-16）

**决定**：History 以 NightSession 为主轴，按 `date`（本地日期字符串 YYYY-MM-DD）在内存中 join MorningSession。

**理由**：早晚记录是两次独立写入，用日期字符串做弱关联最简单可靠；跨午夜问题由 date 取「入睡当天」自然解决（凌晨 1 点睡仍记在前一天）。

**已知取舍**：一天多次保存会显示多条，v1 不合并。

## D11. 图标用脚本生成而非引入设计资源（2026-08-16）

**决定**：用 Python 标准库（struct/zlib）直接生成 180/192/512 PNG 图标：深色底 + 暖色月牙。

**理由**：项目零依赖原则；占位图标视觉与 Night 主题一致，后续可整体替换而不影响任何代码。

## D12. 早晚流程都以「终态页」收尾（2026-08-16，第二阶段）

**决定**：夜间保存后整个流程区隐藏，只留「晚安。已经记下了。现在放下手机」加 SleepTown 备用按钮；早晨保存后只留「好。新的一天开始了。」。当天已保存过 NightSession 时，打开 App 直接进入晚安终态。

**理由**：这是「停留时间越短越好」「不让用户继续刷手机」的直接落地——流程完成后界面上不再有任何可玩的东西。终态切换与存储成功与否解耦：即使 IndexedDB 写入失败也进入终态，不让技术问题打断睡前/早晨的动线。

## D13. 夜间触控与视觉的具体阈值（2026-08-16，第二阶段）

**决定**：所有触摸目标 ≥48px（高于 Apple 44pt）；输入框字号固定 16px（防 iOS 聚焦自动缩放）；「开始睡觉」吸底固定在拇指热区、Tab 栏之上；时钟从 2.6rem 缩到 2.1rem 并降级为锚点信息；唯一保留的动画是视图切换 600ms 淡入与 Brain Dump 800ms 淡出；`prefers-reduced-motion` 下全部关闭。

**理由**：第二阶段的核心指标是 30 秒～2 分钟完成流程。吸底主按钮免去滚动，大触摸目标降低夜里的误触，时钟退位避免「看到时间更焦虑」的反效果。

## D14. 早晨页只展示 18 小时内的夜间记录（2026-08-16，数据层回归后）

**决定**：`renderMorning` 只在最近一条 NightSession 距当前不足 18 小时时才展示「昨晚」数据，否则显示「没有记录」占位。

**理由**：数据层测试走通完整读写后发现的真实数据语义问题——若用户断用几天，早晨页会把三天前的记录标注为「昨晚」，造成误导。18 小时覆盖「凌晨入睡 + 睡懒觉」的最长合理间隔。

## D15. 测试依赖不进项目，脚本进 `tests/`（2026-08-16）

**决定**：`tests/db.test.js`（fake-indexeddb，30 项）与 `tests/ui-smoke.test.js`（jsdom，15 项）留在仓库；jsdom / fake-indexeddb 只装在隔离 Node 工作区，通过 `NODE_PATH` 引用。

**理由**：项目保持零 npm 依赖、无构建；同时每轮改动有可重复执行的回归。ui-smoke 在 jsdom 无 IndexedDB 环境下运行，顺带持续验证「存储失败不阻断流程」的容错路径。

## D16. 内容库采用「内容原子管线」+ 双 JSON 数据文件（2026-08-16）

**背景**：外部方案（sleep_ritual_sleep_materials_curated.md）提出管线「原始文章 → 内容原子 → 标签/触发条件 → 夜间干预 → 微行为 → 行为结果」。经评估采纳其骨架，与本项目既有方案（reasonId 匹配、≤80 字、每晚一条）综合。

**采纳**：①素材与产品内容分离，原材料永不直接进夜间页面；②`evidenceLevel`（A–D）逐条证据分级字段；③`tone` 语气字段（calm/warm/sharp/funny/scientific/action）；④种子数据从代码拆为 `data/seed-content.json`（28 条内容原子）+ `data/seed-actions.json`（9 原因微行为），应用启动时 fetch 加载、失败回退 `content.js` 内置兜底；⑤SW 预缓存两个 JSON（v4），离线可用。

**保留本项目做法**：①机器匹配键只用结构化 reasonId（9 个），外部方案的自由中文标签降级为给人看的 `tags`；②字段节制——`useCount`/`actionType` 等预留兼容名但 MVP 不实装；③「行为结果」回流复用已就位的 `nightSessions.contentId`，不建新表。

**否决**：按文件夹组织内容分类（前端不消费文件夹，纯多余）；外部 28 条中涉医学数字的表述维持存疑清单处理，不入库（28 条最终分布 evidenceLevel B×8 / C×20，无 D）。

**环境坑记录**：本机系统代理（HTTP_PROXY）会截断 Node/undici 的 localhost 请求（empty reply），跑测试需 `env -u HTTP_PROXY -u HTTPS_PROXY`；`python -m http.server` 后台运行不稳定，改用 Node 内联静态服务器；ui-smoke 测试端口可用 `SR_PORT` 环境变量指定。

## D23. 夜间内容与原因联动匹配（2026-08-16）

**决定**：打开夜间页先展示通用池内容；选完原因后调用 `renderContentForReasons()`，从命中 `reasons` 且 `enabled` 的内容池中换一条展示。选取规则顺序：enabled 过滤 → modes 含 night → 命中 reasonIds（空 = 通用池）→ 排除最近展示过的 → priority 大的优先 → 同优先级随机。

**理由**：计划核心闭环是"状态 → 内容 → 行为 → 结果"，打开时原因未知只能展示通用内容，选完原因后必须响应式更换，否则内容与场景脱节。

## D24. 内容不连续重复展示（2026-08-16）

**决定**：`shownTonight`（本次会话展示过的 id 集合）+ 最近 7 晚 NightSession 的 `shownContentIds`（兼容旧 `contentId`）合并为排除集；排除后池子为空则回退不过滤（内容库小时避免无内容可显）。

**理由**：计划 §17 要求"同一条内容不要连续多晚重复"。用已入库的 session 数据计算，无需新增字段或额外存储。

## D25. NightSession 字段补齐（2026-08-16）

**决定**：session 新增 `selectedActionId`（act_xxx，来自 seed-actions.json 的 id）、`brainDumpUsed`（布尔，只记"用过"不存内容，隐私价值）、`sleepTownAttempted`（点击开始睡觉即置 true——跳转成功与否无法可靠检测，记录"已尝试"比"已成功"诚实）、`shownContentIds`（数组，保留 `contentId` 兼容旧数据与历史读取）。

**理由**：计划 §12/§15 要求。字段命名 `sleepTownAttempted` 与计划草案的 `sleepTownOpened` 不同，是刻意为之——iOS 自定义 scheme 无成功回调（见 D7/D15），无法验证"已打开"。

## D26. MorningSession 补 wakeAt（2026-08-16）

**决定**：`bindMorningSave` 写入 `wakeAt = new Date().toISOString()`（保留 `createdAt` 兼容）。

**理由**：计划 §16 要求。历史 session 无此字段，读取侧（History）只按需展示，无需迁移。

## D27. 设置页新增内容可带原因（2026-08-16）

**决定**：内容添加表单加"适用原因"多选 chips（9 个 reasonId，不限制数量）；新增内容写入 `reasons: [...]` + `enabled: true`，不选则 `reasons: []` 进通用池。

**理由**：让用户自建内容也能参与原因匹配（计划 §17"如果用户有过去自己写过的 personal 内容，可以适当提高优先级"的数据前提），否则自定义内容永远只能通用展示。

## D28. History 极简趋势（2026-08-16）

**决定**：History 顶部一行文字：`最近 7 天平均晚了 X 分钟，最常见原因：……`（全部按时则写"都按时入睡"），无图表。

**理由**：计划 §14 允许"非常简单的趋势"；措辞保持产品原则——只陈述事实，不评价。

## D29. MVP 闭环测试（2026-08-16）

**决定**：新增 `tests/mvp.test.js`：jsdom + fake-indexeddb 组合（beforeParse 注入 indexedDB 与本地 fetch），端到端验证原因→内容匹配、session 字段完整性（selectedActionId/brainDumpUsed/sleepTownAttempted/shownContentIds）、wakeAt、History 列表与趋势，17 项。

**理由**：ui-smoke 在无 IndexedDB 环境跑（容错路径），新字段与匹配逻辑必须用真实存储验证。至此三套回归 db 30 + ui 17 + mvp 17 = 64 项。

## D30. 晚安页跨天归日 + 手动兜底（2026-08-17）

**决定**：新增 `sleepDate(d)`——将 00:00–04:00 的入睡归入前一天（阈值 `NIGHT_CUTOFF_HOUR = 4`）。`resumeNightState` 用 `sleepDate()` 判断"今睡日是否已睡"；`bindSleepButton` 写入的 `session.date` 改用 `sleepDate()`。`index.html` 晚安终态加「今晚还没睡，回到流程」按钮（`#btn-back-to-night`），`app.js` 新增 `bindBackToNightFlow()` 并在 `init()` 中绑定，重置会话状态后重走睡前流程。`sw.js` 缓存版本 v5 → v6（本次改了 app.js/index.html/css，必须清旧缓存否则已安装的 PWA 继续返回旧脚本）。

**理由**：原实现用 `todayStr()` 存入睡日期，凌晨 0:15 入睡会被记为"今天"，导致第二天全天命中 `last.date === todayStr()` 一直显示晚安页，阻断用户重新进入睡前流程（即本次修复的 bug）。把凌晨前 4 小时归入前一天后，统计上"今晚"语义正确——第二天早上（>04:00）打开时 `sleepDate()` 已回到新日期，不再命中，正常显示睡前流程。手动按钮是防御性兜底：万一仍误显示晚安页，用户可一键重置重走，不依赖时间规则。

**取舍**：04:00 为经验阈值，覆盖绝大多数"熬夜到凌晨才睡"的场景；此后按当天算。与 D10 一致——同一 sleepDate 多次保存仍可能产生多条记录，v1 不合并。自动规则 + 手动兜底双保险，不引入更复杂的时间戳修正。

## D31. sleepDate 边界单测固化（2026-08-17）

**决定**：`js/app.js` IIFE 内新增测试钩子 `window.sleepDate = sleepDate;`（生产逻辑无副作用）；新增 `tests/sleepdate.test.js`，jsdom 加载页面后断言 8 个临界用例——03:59→前一天、04:00→当天、00:00→前一天、23:59→当天、跨月末（03-01 02:00→02-28，2026 非闰年）、跨年末（01-01 03:00→上一年 12-31）、白天正常当晚、钩子已暴露。结果 8/8 通过。

**理由**：本次跨天 bug 的根因正是 `sleepDate` 的日期边界算错；原 64 项测试均为端到端（db/mvp/ui-smoke），不锁定该纯函数的内部数学——若有人把阈值误改，端到端测试在常规时段仍全绿，bug 会悄悄溜回。单测把"凌晨归前一天"这条契约钉死为可自动验证的断言，防回归。钩子挂 `window` 是零构建约束下的最小改动（方案 A），不引入新模块或构建步骤。

**运行**：`SR_PORT=<port> NODE_PATH=<ws>/node_modules node tests/sleepdate.test.js`（需本地服务器提供 index.html 及其 script）。至此四套回归 db 30 + mvp 17 + ui-smoke 17 + sleepdate 8 = 72 项。

## D32. PWA 应用内更新提示（方案 A，2026-08-17）

**决定**：改用「应用内更新横幅 + 用户主动触发」策略，替代「依赖浏览器下拉刷新」。具体：
- `sw.js`：移除 `install` 阶段的 `self.skipWaiting()`（原自动跳过等待），改为让新 SW 进入 `waiting`；新增 `message` 监听，收到 `SKIP_WAITING` 才 `skipWaiting()`；缓存版本 v6 → v7。
- `app.js`：`registerSW()` 重写——监听 `reg.updatefound` / 新 worker 的 `statechange`，当新 SW 状态为 `installed` 且 `navigator.serviceWorker.controller` 存在（即已有旧 SW 在控制页面）时，显示顶部更新横幅 `#update-banner`；横幅「更新」按钮点击 → 向新 worker `postMessage('SKIP_WAITING')`；监听 `controllerchange` → `location.reload()` 拿新壳。暴露 `window.__checkForUpdate = () => reg.update()` 供设置页「检查更新」按钮调用。
- `index.html`：`<body>` 内 `#app` 前加 `#update-banner` 横幅（默认 `hidden`）；设置页「数据」区加 `#btn-check-update` 按钮。
- `css`：`.update-banner` 固定定位（`position: fixed; top:0`，含 `safe-area-inset-top` padding），暖琥珀深底，按钮 ≥48px 触摸目标。

**理由**：iOS 将网站「添加到主屏幕」后以 standalone 全屏打开时，顶部下拉手势被当作页面内橡皮筋滚动，**不触发浏览器刷新**——所有 iOS 独立 PWA 均无下拉刷新入口；且 SW 更新生命周期要求当前页面 reload 才接管，已加载运行的旧 JS 不受 `clients.claim` 影响。二者叠加导致「更新后点进去仍是旧的、又无法手动刷新」。方案 A 在应用内提供更新入口，彻底绕开 standalone 无下拉刷新的限制，且把「何时更新」交给用户（不打断正在进行的流程，如写 Brain Dump）。

**机制要点**：放弃 install 自动 skipWaiting 是关键——否则新 SW 立即激活，`installed` 状态一闪而过，`updatefound` 检测不到稳定 waiting 态，横幅无法可靠显示。改为 waiting + 用户点击触发，是 Workbox 等框架的 prompt 策略标准做法。

**已知遗留**：当前已推送的 v6 sw.js 含自动 skipWaiting，用户手机若仍是旧实例，需**先杀进程重进一次**加载含本方案的新版本（v7）；此后每次更新即自动出现应用内提示。回归 72 项未变（db30+mvp17+ui17+sleepdate8），jsdom 下无 serviceWorker，`registerSW` 提前 return 不受影响。

## D33. 每日一句点击换句（方案 A，2026-08-17）

**决定**：`#night-content` 改为可点击——加 `role="button"` + `tabindex="0"` + `aria-label="点击换一句"`，外层加 `.night-quote-wrap`，右下角加极淡角标 `.quote-hint`（仅 hover / `:focus-visible` 时显现，默认 `opacity:0`、`pointer-events:none`）。新增 `shuffleNightContent()`：取 `DB.getAllContent()` → `exclude = recentlyShownIds() ∪ shownTonight` → `item = pickContent(all, selectedReasons, exclude)`（**用当前 selectedReasons，与选原因后的联动一致**）；池子转空时 `pickContent(all, selectedReasons, null)` 回退不过滤再取；命中则 `showContentItem()`（自然计入 `shownTonight`）并走轻量「淡出(160ms)→换→淡入」。`bindNightContentShuffle()` 绑定 `click` 与 `keydown(Enter/Space)`，在 `init()` 中调用。防抖：`dataset.shuffling` 同步置位、动画结束后清除，避免连点重入。

**理由**：换句机制本就存在（`renderContentForReasons` 选原因后换一条），只是没有「手动随时换」入口；用户想对当前一句不感冒时当场换。点击换句本质是「给已有换句逻辑加一个手动触发点」，而非新增匹配逻辑，故复用 `pickContent` 与去重集，代价极小。

**与原设计的取舍**：
- 不破坏「每晚一句」的稳定感——换句是**用户主动**触发，且只改当晚会话内展示，不污染持久「最近 7 晚」去重（`shownContentIds` 落库的仍是最后一次展示的句）。
- 低刺激原则：`cursor:pointer` + 极淡角标，不引入弹窗/花哨动画；换句仅 0.18s 透明度过渡。
- 与原因联动一致：传 `selectedReasons` 而非 `null`，选了原因后换句仍在「该原因相关句」里换，不退回通用池。
- 可访问性：整句可键盘聚焦（Enter/Space 触发），`aria-label` 告知作用。
- 池子耗尽兜底：一夜把 night 池转完，`pickContent` 回退不过滤会回到某句（「换了个寂寞」），可接受，未加二次 pick 避开同 id。

**回归**：`ui-smoke.test.js` +3 断言（role=button / tabindex=0 / 点击同步置 `shuffling` 标志），总数 17 → 20。全四套 db30+mvp17+ui20+sleepdate8 = 75 项通过。已推送 `0fae2e4..c26206d`。

## D34. 修复 History 夜/晨配错位 + 夜间页早晨回显（2026-08-18）

**Bug（用户反馈）**：早晨写下「今天想说的话」保存后，进记录发现显示的仍是旧早晨内容（甚至前天的）。

**根因**：History 把夜/晨记录按**日期字符串相等**配对——`morningByDate[m.date] = m` 再用 `morningByNightId[n.date]` 查。但两条记录的日期锚点根本不同：
- `nightSession.date = sleepDate()`（睡眠日：23 点睡记成当天）；
- `morningSession.date = todayStr()`（醒来**日历日**）。
早晨（如 8/18 醒）跟随的是 8/17 的夜，二者日期永远不相等 → 今天写的早晨被孤立、永不显示；最新夜间反而命中「日历日恰好等于其睡眠日」的旧早晨（例如 8/17 早晨写的，其实跟的是 8/16 的夜）。旧逻辑即便「看着正常」也差一天。

**修复（配对改时间邻近）**：抽纯函数 `pairMorningToNight(nights, mornings)`——每条早晨挂到「`actualSleepAt ≤ wakeAt` 且间隔 ≤ 18h」的**最近**一条夜间记录，`{ [nightId]: morning }`。History 改用 `morningByNightId[n.id]`。零数据迁移，不依赖任何日期锚点规则。暴露 `window.__pairMorningToNight` 供测试。

**功能 2（夜间页早晨回显）**：用户希望在「每日一句」下方，显示「今天早晨写给自己那句话」，没写则不显示。新增 `#morning-echo`（`index.html`，`.night-quote-wrap` 之后）+ `renderTonightMorningEcho()`：读 `date === todayStr()` 且有 `morningMessage` 的早晨记录，有则显、无则 `hidden`；在 `showView(night)` 与「回到流程」里调用。与既有对称回路呼应：夜间写 `tonight-message` → 早晨页显示「昨晚写给自己的话」（D12 已有）；早晨写 `morning-message` → 夜间页显示「今晨的我」（本决策新增）。

**边界**：回显只在夜间视图出现（每日一句只在夜间视图），符合「今晚回想今晨的自己」语义；白天开 App 进早晨视图本无此句可放，无需处理。`sw.js` 缓存 v8 → v9（改了 app.js/index.html/css，必须清旧缓存）。

**回归**：`ui-smoke.test.js` +6 断言（morning-echo 存在/默认隐藏、pairMorningToNight 暴露、今天早晨→最新夜 id1、旧早晨→前驱夜 id2、孤立早晨不配对），总数 20 → 26。全四套 db30 + mvp17 + ui26 + sleepdate8 = 81 项通过。
