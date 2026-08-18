/* Sleep Ritual UI 无头冒烟测试（jsdom，经本地服务器加载真实文件）
 *
 * 运行方式：
 *   1. 项目根目录起服务：python -m http.server 8788
 *   2. npm install jsdom   # 在隔离工作区
 *   3. NODE_PATH=<工作区>/node_modules node tests/ui-smoke.test.js
 *
 * 注：jsdom 无 IndexedDB，存储写入会走 catch 分支——
 *     这同时验证了"存储失败不阻断流程"的容错设计。
 */
const { JSDOM } = require("jsdom");

(async () => {
  const port = process.env.SR_PORT || 8788;
  const dom = await JSDOM.fromURL("http://127.0.0.1:" + port + "/index.html", {
    resources: "usable",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  const results = [];
  const check = (name, cond) => results.push([name, !!cond]);

  await new Promise((r) => setTimeout(r, 1200)); // 等脚本与 DOMContentLoaded

  // 17 点打开 → 默认夜间
  check("night view active", $("#view-night").classList.contains("is-active"));
  check("morning-echo present", !!$("#morning-echo"));
  check("morning-echo hidden by default", $("#morning-echo").hidden === true);

  const chips = $$("#reason-list .chip");
  check("9 reason chips rendered", chips.length === 9);

  chips[0].click();
  chips[1].click();
  chips[2].click();
  check("max 2 reasons enforced", $$("#reason-list .chip.is-on").length === 2);
  check(
    "behavior tip visible",
    !$("#behavior-tip").hidden && $("#behavior-tip-text").textContent.length > 0
  );
  chips[0].click();
  check("deselect works", $$("#reason-list .chip.is-on").length === 1);

  // Brain Dump：淡出后清空
  const dump = $("#braindump-input");
  dump.value = "甩不掉的念头";
  $("#braindump-clear").click();
  await new Promise((r) => setTimeout(r, 1000));
  check("braindump cleared without saving", dump.value === "");

  // 睡觉流程 → 晚安终态
  $("#tonight-message").value = "明天见";
  $("#btn-sleep").click();
  await new Promise((r) => setTimeout(r, 200));
  check("goodnight state shown", !$("#night-goodnight").hidden);
  check("night flow hidden", $("#night-flow").hidden);
  check("sleep bar hidden", $(".sleep-bar").hidden);
  check("sleeptown backup button visible", !$("#btn-sleeptown").hidden);

  // SleepTown 唤起失败兜底：jsdom 不会跳转，页面保持可见，
  // 2.2 秒后应出现手动提示
  await new Promise((r) => setTimeout(r, 2500));
  check("sleeptown fallback hint shown", !$("#sleeptown-hint").hidden);

  // 切到早晨
  $$(".tab").find((t) => t.dataset.view === "morning").click();
  await new Promise((r) => setTimeout(r, 200));
  check("morning view active", $("#view-morning").classList.contains("is-active"));
  check(
    "theme-color switched",
    $("#meta-theme-color").getAttribute("content") === "#f6f2e9"
  );

  // 早晨流程 → 终态
  $$(".mood")[0].click();
  $("#morning-message").value = "今天加油";
  $("#btn-morning-save").click();
  await new Promise((r) => setTimeout(r, 200));
  check("morning done state shown", !$("#morning-done").hidden);
  check("morning flow hidden", $("#morning-flow").hidden);

  // 切回夜间，主题还原
  $$(".tab").find((t) => t.dataset.view === "night").click();
  await new Promise((r) => setTimeout(r, 200));
  check("night view active again", $("#view-night").classList.contains("is-active"));
  check(
    "theme-color restored",
    $("#meta-theme-color").getAttribute("content") === "#000000"
  );

  // 「每日一句」点击换句：可访问属性 + 点击同步触发换句流程
  const nc = $("#night-content");
  check("night-content role=button", nc.getAttribute("role") === "button");
  check("night-content tabindex=0", nc.getAttribute("tabindex") === "0");
  nc.dispatchEvent(new window.Event("click", { bubbles: true }));
  check("click triggers shuffle (flag set sync)", nc.dataset.shuffling === "1");

  // 夜/晨配对：验证修复后"今天写的早晨"挂到正确的夜间记录（不再显示旧内容）
  const pair = window.__pairMorningToNight;
  check("pairMorningToNight exposed", typeof pair === "function");
  if (typeof pair === "function") {
    const nights = [
      { id: 1, date: "2026-08-17", actualSleepAt: "2026-08-17T23:00:00.000Z" },
      { id: 2, date: "2026-08-16", actualSleepAt: "2026-08-16T23:00:00.000Z" },
    ];
    const mornings = [
      { date: "2026-08-18", wakeAt: "2026-08-18T06:00:00.000Z", morningMessage: "今天写" },
      { date: "2026-08-17", wakeAt: "2026-08-17T06:00:00.000Z", morningMessage: "旧内容" },
    ];
    const map = pair(nights, mornings);
    check("today morning pairs to latest night (id1)", map[1] && map[1].morningMessage === "今天写");
    check("old morning pairs to prior night (id2)", map[2] && map[2].morningMessage === "旧内容");
    // 孤立早晨（无前驱夜间）→ 不进 map
    const orphan = pair(
      [{ id: 9, date: "2026-08-20", actualSleepAt: "2026-08-20T23:00:00.000Z" }],
      [{ date: "2026-08-18", wakeAt: "2026-08-18T06:00:00.000Z", morningMessage: "X" }]
    );
    check("orphan morning not paired", Object.keys(orphan).length === 0);
  }

  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(
    fail ? "\n" + fail + " failed" : "\nall " + results.length + " checks passed"
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exit(1);
});
