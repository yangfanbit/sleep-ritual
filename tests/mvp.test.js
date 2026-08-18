/* Sleep Ritual MVP 核心闭环无头测试（jsdom + fake-indexeddb）
 *
 * 覆盖：
 * - 原因 → 内容匹配（选「想继续刷手机」应命中对应标签内容）
 * - NightSession 新字段：selectedActionId / brainDumpUsed / sleepTownAttempted / shownContentIds
 * - MorningSession 新字段：wakeAt
 * - History 列表 + 极简趋势
 *
 * 运行方式：
 *   1. 项目根目录起服务：python -m http.server 8788
 *   2. NODE_PATH=<工作区>/node_modules node tests/mvp.test.js   （需 jsdom + fake-indexeddb）
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

(async () => {
  const port = process.env.SR_PORT || 8788;
  const dom = await JSDOM.fromURL("http://127.0.0.1:" + port + "/index.html", {
    resources: "usable",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // 注入真实可用的 IndexedDB 与本地 fetch（读 data/*.json）
      const fidb = require("fake-indexeddb");
      window.indexedDB = fidb.indexedDB || new fidb.IDBFactory();
      window.fetch = async (url) => {
        const name = String(url).split("/").pop();
        const txt = fs.readFileSync(path.join(ROOT, "data", name), "utf8");
        return { ok: true, json: async () => JSON.parse(txt) };
      };
    },
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  const results = [];
  const check = (name, cond) => results.push([name, !!cond]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalDB = (expr) => window.eval(expr);

  await wait(1500); // 等脚本初始化 + JSON 播种

  /* 1. 打开夜间页：展示一条内容 */
  check(
    "night content shown",
    $("#night-content").textContent.trim().length > 0
  );

  /* 2. 注入一条「刷手机」专属的高优先级测试内容（保证匹配确定性） */
  await evalDB(
    `DB.addContent({id:'t001',type:'quote',text:'MVP测试-刷手机专属',reasons:['keep_scrolling'],modes:['night'],enabled:true,priority:10})`
  );

  /* 3. 点「想继续刷手机」（chips 顺序见 content.js REASONS，index 1）→ 内容切换 */
  const chips = $$("#reason-list .chip");
  chips[1].click();
  await wait(400);
  check(
    "content switched to reason-matched",
    $("#night-content").textContent.includes("MVP测试-刷手机专属")
  );

  /* 4. 行为提示出现 */
  check("behavior tip shown", !$("#behavior-tip").hidden);

  /* 5. 用一次 Brain Dump（点「丢掉」，内容不保存） */
  const dump = $("#braindump-input");
  dump.value = "脑子里的一堆事";
  $("#braindump-clear").click();
  await wait(950);
  check("braindump cleared", dump.value === "");

  /* 6. 保存 NightSession 并断言字段完整性 */
  $("#tonight-message").value = "明天继续";
  $("#btn-sleep").click();
  await wait(300);
  const s = await evalDB(
    `DB.getLatestNightSession().then(n=>({
      reasons: n.reasons,
      selectedActionId: n.selectedActionId,
      brainDumpUsed: n.brainDumpUsed,
      sleepTownAttempted: n.sleepTownAttempted,
      shownContentIds: n.shownContentIds,
      contentId: n.contentId,
      tonightMessage: n.tonightMessage,
      actualSleepAt: !!n.actualSleepAt,
      bedTimeTarget: !!n.bedTimeTarget,
    }))`
  );
  check(
    "session.reasons recorded",
    s.reasons && s.reasons.includes("keep_scrolling")
  );
  check(
    "session.selectedActionId recorded",
    s.selectedActionId === "act_keep_scrolling"
  );
  check("session.brainDumpUsed true", s.brainDumpUsed === true);
  check("session.sleepTownAttempted true", s.sleepTownAttempted === true);
  check(
    "session.shownContentIds array",
    Array.isArray(s.shownContentIds) && s.shownContentIds.includes("t001")
  );
  check("session legacy contentId kept", s.contentId === "t001");
  check("session.tonightMessage kept", s.tonightMessage === "明天继续");
  check(
    "session.actualSleepAt + bedTimeTarget",
    s.actualSleepAt && s.bedTimeTarget
  );

  /* 7. 早晨保存 → wakeAt 记录 */
  $$(".tab").find((t) => t.dataset.view === "morning").click();
  await wait(400);
  check(
    "morning shows last bedtime",
    $("#morning-bedtime").textContent !== "--:--"
  );
  $$(".mood")[2].click();
  $("#morning-message").value = "今天也要好好的";
  $("#btn-morning-save").click();
  await wait(300);
  const m = await evalDB(
    `DB.getRecentMorningSessions(1).then(l=>l[0]?{
      wakeAt: !!l[0].wakeAt,
      mood: l[0].mood,
      message: l[0].morningMessage,
    }:null)`
  );
  check("morning.wakeAt recorded", !!m && m.wakeAt);
  check(
    "morning mood+message kept",
    !!m && m.mood === "sleepy" && m.message === "今天也要好好的"
  );

  /* 8. History：列表 + 极简趋势 */
  $$(".tab").find((t) => t.dataset.view === "history").click();
  await wait(500);
  check("history list rendered", $$(".history-item").length >= 1);
  check(
    "history trend visible",
    !$("#history-trend").hidden &&
      $("#history-trend").textContent.includes("最常见原因")
  );

  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(
    fail ? "\n" + fail + " failed" : "\nall " + results.length + " checks passed"
  );
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exitCode = 1;
});
