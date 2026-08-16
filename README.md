# Sleep Ritual

一个运行在 iPhone 上的个人睡前行为干预 PWA。

不是睡眠记录 App，是"睡前行为干预器"。核心逻辑：

**Anchor → Buffer → Transition**

到了设定的睡前时间，通过 iPhone Shortcut 打开它 → 不催促睡觉，先理解"我为什么现在还不想睡" → 用一个极低成本的行为替代完成缓冲 → 写一句给明天的自己 → 放下手机，进入 SleepTown 执行真正的睡眠。

- Sleep Ritual 负责心理和行为干预
- SleepTown 负责睡眠执行和闹钟

## 边界

本项目完全独立于个人博客（yfnwu.com / Gridea Pro）。不读、不改、不依赖博客的任何代码和部署方式。未来独立部署到 `https://sleep.yfnwu.com/`。

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

iPhone 真机调试：让 iPhone 和电脑在同一局域网，访问 `http://<电脑局域网IP>:8080`，然后通过 Safari「添加到主屏幕」以 standalone 模式运行。

## 目录结构

```
index.html            入口，四个视图容器 + 底部导航
css/styles.css        全局样式（Night 深色 / Morning 明亮两套视觉）
js/content.js         原因选项、行为替代规则表、初始内容库种子
js/db.js              IndexedDB 数据层（settings / content / 两类 session）
js/app.js             视图路由 + 全部交互逻辑
manifest.webmanifest  PWA 清单
sw.js                 Service Worker（离线缓存）
assets/icons/         PWA / Apple touch 图标
docs/PRD.md           产品需求文档
docs/DECISIONS.md     关键技术决策记录
tests/                无头回归测试（jsdom + fake-indexeddb，不进构建）
```

## 测试

```bash
# 依赖装在隔离 Node 工作区，不进入项目
npm install jsdom fake-indexeddb

# 数据层回归（30 项）：种子/设置/两类 session/导出/导入往返/清空重播种
NODE_PATH=<工作区>/node_modules node tests/db.test.js

# UI 冒烟（17 项）：需先在项目根目录起服务 python -m http.server 8788
NODE_PATH=<工作区>/node_modules node tests/ui-smoke.test.js

# MVP 闭环（17 项）：原因→内容匹配 / session 字段完整性 / History 趋势
NODE_PATH=<工作区>/node_modules node tests/mvp.test.js
```

注：Windows 本机若有系统代理，Node 访问 localhost 可能被截断，测试前加 `env -u HTTP_PROXY -u HTTPS_PROXY`（UI 冒烟与 MVP 测试经本地服务器加载页面）。

## 数据

全部数据只存在本机 IndexedDB。设置页提供 JSON 导出/导入做备份和迁移。

## 设计约束（不可违反）

1. 单次使用 30 秒 ~ 2 分钟，越短越好
2. 不做无限滚动、不做内容流、不做复杂日记
3. 不用羞辱式反馈，不出现「失败」「断签」「重新开始」
4. 夜间界面低刺激：深黑底、柔和灰文字、少动画、低信息密度
5. 内容只是干预入口，每晚只展示一条
