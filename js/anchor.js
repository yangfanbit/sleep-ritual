/* AnchorProvider — 统一「入口来源」判断 + 深链解析
 *
 * 设计目标（见架构文档 Phase 4：Anchor 重定义 / 统一 Night 深链）：
 * 1. 把「用户怎么打开的 App / 从哪进入某个视图」的判断集中到一处，
 *    避免 app.js 里散落各平台（UA / standalone / 推送）的判断逻辑。
 * 2. iOS 不依赖 Shortcut 自动唤起：iOS 上无法可靠检测是否由 Shortcut 拉起，
 *    因此统一用「深链 #/night」作为跨平台入口；来源只能 best-effort 推断。
 * 3. 预留 notification：未来接入 Web Push 时，由 push 事件写入
 *    window.__launchSource = 'notification'，这里直接采用，无需改 app.js。
 *
 * getCurrentSource() 取值（集中定义，禁止臆断）：
 *   home_screen  — 已安装 PWA 且非深链进入（直接点击主屏图标）
 *   deep_link    — 通过一个 Deep Link（如 #/night）进入；不据此臆断为 shortcut
 *   manual       — 非 standalone 浏览器普通打开（外部链接 / 直接访问）
 *   notification — 真实通知点击（仅当 __launchSource 显式注入，如未来 Web Push）
 *   push         — 真实推送（仅当 __launchSource 显式注入）
 *   shortcut     — 仅当 __launchSource 显式注入为 shortcut 才可记录；
 *                  当前 iOS Shortcut 无法可靠识别，绝不根据 standalone+hash 臆断
 *   unknown      — 无法判断（兜底）
 */
(function (global) {
  "use strict";

  const KNOWN_VIEWS = ["night", "morning", "history", "settings"];

  function isStandalone() {
    try {
      // iOS Safari「添加到主屏幕」后 navigator.standalone === true
      if (global.navigator && global.navigator.standalone === true) return true;
      if (global.matchMedia) {
        if (global.matchMedia("(display-mode: standalone)").matches) return true;
        if (global.matchMedia("(display-mode: fullscreen)").matches) return true;
      }
    } catch (e) {
      /* matchMedia 在某些环境可能抛错，忽略即可 */
    }
    return false;
  }

  /* 解析 location.hash，返回 { view, raw }。
     #/night → { view: "night" }；无 hash 或非法 → { view: null }。
     纯函数，不修改 hash，便于测试。 */
  function parseHash(hash) {
    const raw = (hash != null ? hash : global.location.hash || "").replace(/^#\/?/, "");
    if (!raw) return { view: null, raw: "" };
    const seg = raw.split("/")[0];
    const view = KNOWN_VIEWS.indexOf(seg) >= 0 ? seg : null;
    return { view, raw };
  }

  /* 取入口来源。测试钩子 window.__launchSource 优先（也供未来 Web Push 注入）。
     规则：
     - 显式注入（notification / push / shortcut）仅在确实可确认时使用；
     - 有深链 → 至少能确认「从 Deep Link 进入」→ deep_link（不臆断为 shortcut）；
     - 无深链的 standalone → home_screen（主屏图标）；
     - 无深链的非 standalone → manual。
     来源只是数据记录，不影响任何业务流程。 */
  function getCurrentSource() {
    if (global.__launchSource && typeof global.__launchSource === "string") {
      return global.__launchSource;
    }
    const link = parseHash();
    const deep = !!link.view;
    if (!deep) {
      // 无深链：standalone → 主屏图标；非 standalone → 浏览器普通打开
      return isStandalone() ? "home_screen" : "manual";
    }
    // 有深链：确认从一个 Deep Link 入口进入，但不能据此臆断为 iOS Shortcut
    return "deep_link";
  }

  /* 消费深链：返回目标视图，并清理 hash 避免刷新重复触发。 */
  function consumeDeepLink() {
    const link = parseHash();
    if (link.view) clearHash();
    return link.view;
  }

  /* 清理 hash，使刷新后走默认路由（不重复强制进入深链视图）。 */
  function clearHash() {
    try {
      if (global.history && global.history.replaceState) {
        global.history.replaceState(
          null,
          "",
          global.location.pathname + global.location.search
        );
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  const AnchorProvider = {
    KNOWN_VIEWS,
    isStandalone,
    parseHash,
    getCurrentSource,
    consumeDeepLink,
    clearHash,
  };

  global.AnchorProvider = AnchorProvider;
})(window);
