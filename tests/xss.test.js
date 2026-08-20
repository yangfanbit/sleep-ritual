/* Sleep Ritual — XSS 防护专项测试（jsdom + fake-indexeddb 集成）
 *
 * 覆盖要求：
 *  - escapeHTML 正确转义 < > & " '
 *  - History 中用户输入的 morningMessage 以纯文本渲染，绝不生成 <script>/<img> 元素
 *  - <script>alert(1)</script> 与 <img src=x onerror=alert(1)> 只作为文本显示
 *
 * 运行（需本地服务器提供 index.html）：
 *   SR_PORT=8795 NODE_PATH=<工作区>/node_modules \
 *     HTTP_PROXY= HTTPS_PROXY= node tests/xss.test.js
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

  /* ===== escapeHTML 纯函数 ===== */
  check("escapeHTML defined", typeof window.escapeHTML === "function");
  check("escapeHTML escapes <script>", window.escapeHTML("<script>alert(1)</script>") === "&lt;script&gt;alert(1)&lt;/script&gt;");
  check("escapeHTML escapes <img onerror>", window.escapeHTML('<img src=x onerror=alert(1)>') === "&lt;img src=x onerror=alert(1)&gt;");
  check("escapeHTML escapes & and quotes", window.escapeHTML(`a&b"c'd`) === "a&amp;b&quot;c&#39;d");

  /* ===== 历史记录中 morningMessage 的 XSS 渲染 ===== */
  const DB = window.DB;
  await DB.ready();
  await DB.wipeAll();
  const malicious = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const nid = await DB.addNightSession({
    date: "2026-08-20", status: "completed",
    actualSleepAt: "2026-08-20T23:00:00.000Z", phoneDownAt: "2026-08-20T23:00:00.000Z",
    sessionStartedAt: "2026-08-20T22:30:00.000Z", completedAt: "2026-08-20T23:00:00.000Z",
    bedTimeTarget: "23:30", reasons: [],
  });
  await DB.addMorningSession({
    date: "2026-08-21", mood: "good", morningMessage: malicious,
    wakeAt: "2026-08-21T06:00:00.000Z", createdAt: "2026-08-21T06:00:00.000Z", updatedAt: "2026-08-21T06:00:00.000Z",
  });

  // 切到 History 视图（触发 renderHistory）
  window.document.querySelectorAll(".tab").forEach((t) => {
    if (t.dataset.view === "history") t.click();
  });
  await sleep(400);

  const list = window.document.querySelector("#history-list");
  check("history list rendered", !!list && list.children.length > 0);
  // 恶意字符串应以纯文本出现
  check("malicious string present as text", list && list.textContent.includes(malicious));
  // 绝不能真正创建 <script> / <img> 元素
  check("no <script> element injected", list && list.querySelector("script") === null);
  check("no <img> element injected", list && list.querySelector("img") === null);

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
