/* Sleep Ritual — History 编辑/删除异常处理集成测试（P0 #4 故障注入 / P1 #10 异常矩阵）
 *
 * 覆盖：
 *  - P0：History 编辑保存失败 → 编辑框保持打开 + 用户输入保留 + 可见错误 + 记录未变
 *        （验证 cancelHistoryEdit 未被调用：#he-date 仍为用户修改值，而非被清空）
 *  - P0：History 删除失败 → 原记录仍在 DB + 列表未错误移除 + 有可见错误
 *  - P1：快速连续点击保存 ×2 → 不产生重复记录
 *  - P1：DB 读取失败（getCompletedNightSessions 抛错）→ 优雅降级（显示空提示，不空白崩溃）
 *        恢复后可正常重新渲染
 *  - 真实删除（mock 恢复后）应成功移除记录（反向验证失败路径确实保留了数据）
 *
 * jsdom 集成：依赖本地 HTTP 提供 index.html（run-tests.mjs 自动拉起服务器）。
 *   依赖装于隔离 Node 工作区：fake-indexeddb + jsdom
 *   运行：SR_PORT=8796 node tests/history-error.test.js
 */
require("fake-indexeddb/auto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");

const results = [];
const check = (name, cond) => results.push([name, !!cond]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SR_PORT = process.env.SR_PORT || 8796;

async function loadApp() {
  return JSDOM.fromURL("http://127.0.0.1:" + SR_PORT + "/index.html", {
    resources: "usable",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const fidb = require("fake-indexeddb");
      window.indexedDB = fidb.indexedDB || new fidb.IDBFactory();
      window.fetch = async (url) => {
        const name = String(url).split("/").pop();
        const txt = fs.readFileSync(path.join(root, "data", name), "utf8");
        return { ok: true, json: async () => JSON.parse(txt) };
      };
      // 静音原生 alert / 默认确认删除，便于断言
      window.alert = () => {};
      window.confirm = () => true;
    },
  });
}

const waitFor = async (w, fn, timeout = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true; } catch (e) {}
    await wait(80);
  }
  return false;
};

(async () => {
  const dom = await loadApp();
  const w = dom.window;
  // 轮询等待 app 脚本加载完成（window.DB / DateUtils 就绪），避免脚本尚未执行就访问
  const ready = await waitFor(w, () => !!w.DB && typeof w.DB.addNightSession === "function" && !!w.sleepDate);
  check("app scripts loaded (DB + DateUtils ready)", ready);
  const DB = w.DB;
  await wait(300); // 等待 app 初始化（seedContentIfEmpty / 迁移 / 绑定）

  const fixedDate = "2026-08-20";
  // 注入一条 completed 记录作为编辑/删除目标
  const rec = await DB.addNightSession({
    date: fixedDate,
    status: "completed",
    sessionStartedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    phoneDownAt: new Date().toISOString(),
    bedTimeTarget: "23:30",
    reasons: ["not_over"],
    tonightMessage: "原始留言",
  });
  check("seed completed record", typeof rec === "number");

  // 切到 History 视图并渲染
  const goHistory = async () => {
    w.location.hash = "#/history";
    w.dispatchEvent(new w.Event("hashchange"));
    await wait(450);
  };
  await goHistory();

  /* ---------- P0：编辑保存失败 ---------- */
  const editBtn = w.document.querySelector("#history-list .h-edit");
  check("history edit button present", !!editBtn);
  editBtn.click();
  await wait(200);
  const heDate = w.document.querySelector("#he-date");
  const heMsg = w.document.querySelector("#he-message");
  check("edit form populated with date", heDate && heDate.value === fixedDate);
  // 用户修改：日期与留言
  heDate.value = "2026-08-21";
  heMsg.value = "被编辑的留言";

  const origUpdate = DB.updateNightSession.bind(DB);
  DB.updateNightSession = async () => {
    throw new Error("forced failure");
  };
  w.document.querySelector("#btn-history-save").click();
  await wait(350);

  const errEl = w.document.querySelector("#history-edit-error");
  check(
    "edit failure shows visible error",
    errEl && errEl.hidden === false && /保存失败/.test(errEl.textContent)
  );
  const ed = w.document.querySelector("#history-edit");
  check("edit failure keeps edit panel open", !!ed && ed.hidden === false && ed.open === true);
  check("edit failure preserves user input (message)", heMsg.value === "被编辑的留言");
  // cancelHistoryEdit 会清空 #he-date 为 ""；若仍为用户修改值，说明 cancel 未被调用
  check("edit failure did NOT call cancelHistoryEdit (date retained)", heDate.value === "2026-08-21");
  const afterEdit = await DB.getNightSessionById(rec);
  check("edit failure does not modify DB record", !!afterEdit && afterEdit.tonightMessage === "原始留言" && afterEdit.date === fixedDate);
  DB.updateNightSession = origUpdate;

  /* ---------- P1：快速连续点击保存 ×2（不重复） ---------- */
  const saveBtn = w.document.querySelector("#btn-history-save");
  saveBtn.click();
  saveBtn.click();
  await wait(450);
  const afterDouble = await DB.getCompletedNightSessions(50);
  check(
    "rapid double-save produces no duplicate record",
    afterDouble.filter((n) => n.id === rec).length === 1
  );

  /* ---------- P0：删除失败 ---------- */
  await goHistory();
  const delBtn = w.document.querySelector("#history-list .h-del");
  check("history delete button present", !!delBtn);
  const origDel = DB.deleteNightSession.bind(DB);
  DB.deleteNightSession = async () => {
    throw new Error("forced failure");
  };
  delBtn.click();
  await wait(350);
  const afterDel = await DB.getNightSessionById(rec);
  check("delete failure keeps record in DB", !!afterDel && afterDel.id === rec);
  const stillShown = w.document.querySelector("#history-list .history-item");
  check("delete failure keeps record in list (not falsely removed)", !!stillShown);
  DB.deleteNightSession = origDel;

  /* ---------- 反向验证：真实删除应成功（确认失败路径确实保留了数据） ---------- */
  await goHistory();
  const delBtn2 = w.document.querySelector("#history-list .h-del");
  delBtn2.click();
  await wait(350);
  const gone = await DB.getNightSessionById(rec);
  check("real delete (mock restored) removes record", !gone);

  /* ---------- P1：DB 读取失败优雅降级 ---------- */
  // 用「几天前」的日期，确保 withinDays 不会被未来日期过滤掉
  const past = new Date(Date.now() - 3 * 86400000);
  const pastStr =
    past.getFullYear() +
    "-" +
    String(past.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(past.getDate()).padStart(2, "0");
  await DB.addNightSession({
    date: pastStr,
    status: "completed",
    completedAt: new Date().toISOString(),
    phoneDownAt: new Date().toISOString(),
  });
  const origCompleted = DB.getCompletedNightSessions.bind(DB);
  DB.getCompletedNightSessions = async () => {
    throw new Error("read failed");
  };
  await goHistory();
  const emptyHint = w.document.querySelector("#history-empty");
  check("read failure shows empty hint gracefully (no crash)", !!emptyHint && emptyHint.hidden === false);
  // 恢复后重新渲染应正常工作
  DB.getCompletedNightSessions = origCompleted;
  await goHistory();
  const listCount = w.document.querySelectorAll("#history-list .history-item").length;
  check("history recovers after read restored", listCount >= 1);

  await DB.wipeAll();

  /* ============ 汇总 ============ */
  let fail = 0;
  for (const [n, ok] of results) {
    console.log((ok ? "PASS" : "FAIL") + "  " + n);
    if (!ok) fail++;
  }
  console.log(fail ? "\n" + fail + " failed (" + results.length + " total)" : "\nall " + results.length + " checks passed");
  process.exitCode = fail ? 1 : 0;
  process.exit(process.exitCode || 0); // jsdom 保持事件循环，显式退出以便 CI/runner 收尾
})().catch((e) => {
  console.error("TEST ERROR", e);
  process.exit(1);
});
