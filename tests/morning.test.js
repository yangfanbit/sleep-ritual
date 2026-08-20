/* Sleep Ritual — Morning 保存失败反馈专项测试（jsdom + fake-indexeddb 集成）
 *
 * 覆盖要求：
 *  - 保存成功 → 进入成功终态、输入清空、DB 写入 1 条
 *  - 保存失败 → 不进入成功终态、显示错误、保留输入、DB 不变
 *  - 失败后重试 → 成功、不重复
 *  - 重复保存不产生重复记录（upsertByDate 幂等）
 *
 * 运行（需本地服务器提供 index.html）：
 *   SR_PORT=8795 NODE_PATH=<工作区>/node_modules \
 *     HTTP_PROXY= HTTPS_PROXY= node tests/morning.test.js
 */
const { JSDOM } = require("jsdom");
const fake = require("fake-indexeddb");
const { IDBKeyRange } = require("fake-indexeddb");

const results = [];
const check = (name, cond) => results.push([name, !!cond]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = await JSDOM.fromURL("http://127.0.0.1:" + (process.env.SR_PORT || 8795) + "/index.html", {
    resources: "usable",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.indexedDB = fake.indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      if (!window.URL.createObjectURL) window.URL.createObjectURL = () => "blob:x";
      if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};
    },
  });
  const { window } = dom;
  await sleep(1800);

  const DB = window.DB;
  const $ = (s) => window.document.querySelector(s);
  const clickTab = (v) =>
    window.document.querySelectorAll(".tab").forEach((t) => {
      if (t.dataset.view === v) t.click();
    });

  await DB.ready();
  await DB.wipeAll();
  const today = window.DateUtils.todayStr();

  /* ===== 1) 保存成功 ===== */
  clickTab("morning");
  await sleep(200);
  window.document.querySelectorAll(".mood")[0].click();
  $("#morning-message").value = "今天加油";
  $("#btn-morning-save").click();
  await sleep(300);
  check("success: morning-done shown", !$("#morning-done").hidden);
  check("success: morning-flow hidden", $("#morning-flow").hidden);
  check("success: input cleared", $("#morning-message").value === "");
  let m = (await DB.getRecentMorningSessions(50)).filter((x) => x.date === today);
  check("success: exactly one morning saved", m.length === 1);
  check("success: message persisted", m[0] && m[0].morningMessage === "今天加油");

  /* ===== 2) upsert 幂等（重复保存不产生重复） ===== */
  await DB.wipeAll();
  await DB.upsertMorningSessionByDate(today, { date: today, mood: "ok" });
  await DB.upsertMorningSessionByDate(today, { date: today, mood: "good" });
  m = (await DB.getRecentMorningSessions(50)).filter((x) => x.date === today);
  check("upsert keeps one per day (no duplicate)", m.length === 1 && m[0].mood === "good");

  /* ===== 3) 保存失败：真实反馈，不谎报成功 ===== */
  await DB.wipeAll();
  const realUpsert = DB.upsertMorningSessionByDate.bind(DB);
  DB.upsertMorningSessionByDate = async () => {
    throw new Error("fake db failure");
  };
  clickTab("morning");
  await sleep(150);
  window.document.querySelectorAll(".mood")[0].click();
  $("#morning-message").value = "这次应保存失败";
  $("#btn-morning-save").click();
  await sleep(300);
  check("failure: morning-done NOT shown", $("#morning-done").hidden === true);
  check("failure: error visible", !$("#morning-save-error").hidden);
  check("failure: input preserved", $("#morning-message").value === "这次应保存失败");
  check("failure: no morning saved", (await DB.getRecentMorningSessions(50)).filter((x) => x.date === today).length === 0);

  /* ===== 4) 失败后重试：成功且不重复 ===== */
  DB.upsertMorningSessionByDate = realUpsert;
  $("#btn-morning-save").click();
  await sleep(300);
  check("retry: morning-done shown", !$("#morning-done").hidden);
  check("retry: exactly one morning saved", (await DB.getRecentMorningSessions(50)).filter((x) => x.date === today).length === 1);
  check("retry: error hidden", $("#morning-save-error").hidden === true);

  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(fail ? "\n" + fail + " failed (" + results.length + " checks)" : "\nall " + results.length + " checks passed");
  process.exit(0);
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exit(1);
});
