/* Sleep Ritual — sleepDate() 边界单测（jsdom + fake-indexeddb）
 *
 * 固化「凌晨入睡归前一天」的日期边界，覆盖：
 * - 临界点两侧（03:59 → 昨天 / 04:00 → 今天）
 * - 午夜、深夜正常当晚
 * - 跨月末（03-01 02:00 → 02-28，2026 非闰年）
 * - 跨年末（01-01 03:00 → 上一年 12-31）
 *
 * 运行方式（需本地服务器提供 index.html 及其 script）：
 *   python -m http.server 8788
 *   SR_PORT=8788 NODE_PATH=<工作区>/node_modules node tests/sleepdate.test.js
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
      // 注入可用 IndexedDB 与本地 fetch，让 app.js 初始化不崩、sleepDate 钩子照常挂载
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
  const results = [];
  const check = (name, cond) => results.push([name, !!cond]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await wait(1500); // 等脚本执行、sleepDate 钩子挂载

  const sleepDate = window.sleepDate;
  const at = (y, mo, d, h, m) => new Date(y, mo - 1, d, h, m, 0, 0);

  check("sleepDate 已暴露到 window", typeof sleepDate === "function");
  check("03:59 → 前一天 (08-16)", sleepDate(at(2026, 8, 17, 3, 59)) === "2026-08-16");
  check("04:00 → 当天 (08-17)", sleepDate(at(2026, 8, 17, 4, 0)) === "2026-08-17");
  check("00:00 → 前一天 (08-16)", sleepDate(at(2026, 8, 17, 0, 0)) === "2026-08-16");
  check("23:59 → 当天 (08-17)", sleepDate(at(2026, 8, 17, 23, 59)) === "2026-08-17");
  check("跨月末 03-01 02:00 → 02-28", sleepDate(at(2026, 3, 1, 2, 0)) === "2026-02-28");
  check("跨年末 01-01 03:00 → 12-31", sleepDate(at(2026, 1, 1, 3, 0)) === "2025-12-31");
  check("白天 12:30 → 当天 (08-17)", sleepDate(at(2026, 8, 17, 12, 30)) === "2026-08-17");

  let pass = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS  " : "FAIL  ") + n);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
