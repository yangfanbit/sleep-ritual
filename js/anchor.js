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
 * getCurrentSource() 取值：
 *   home_screen  — 已安装 PWA（display-mode: standalone / iOS navigator.standalone）
 *   shortcut     — 经深链进入且处于 standalone（最可能是主屏快捷方式 / 书签深链）
 *   manual       — 浏览器普通打开、或深链但非 standalone（外部链接 / 书签）
 *   notification — 未来 Web Push 拉起（当前实现不会返回，除非注入 __launchSource）
 *   unknown      — 无法判断
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

  /* 取入口来源。测试钩子 window.__launchSource 优先（也供未来 Web Push 注入）。 */
  function getCurrentSource() {
    if (global.__launchSource && typeof global.__launchSource === "string") {
      return global.__launchSource;
    }
    const link = parseHash();
    const deep = !!link.view;
    if (isStandalone()) {
      // standalone 下经深链进入 → 最可能是主屏快捷方式 / 书签深链
      return deep ? "shortcut" : "home_screen";
    }
    // 非 standalone：浏览器普通打开为 manual；深链也视为 manual（外部链接）
    return "manual";
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
