#!/usr/bin/env node
/**
 * Sleep Ritual 统一测试运行器（无构建、零产品依赖）
 *
 * 用法：
 *   node tools/run-tests.mjs all     # 先 unit 后 smoke（= npm test）
 *   node tools/run-tests.mjs unit    # 纯 Node 套件（无需服务器，最快）
 *   node tools/run-tests.mjs smoke   # jsdom 集成/冒烟套件（自动拉起本地静态服务器）
 *
 * 设计要点：
 *   - 全部套件相对仓库根定位，Windows/macOS/Linux/Codex/GitHub Actions 通用。
 *   - smoke 套件依赖本地 HTTP 提供 index.html（jsdom.fromURL 需真实 HTTP），
 *     故本运行器临时拉起 .dev-server.mjs，跑完统一关闭。
 *   - 依赖（fake-indexeddb / jsdom）经 package.json devDependencies 安装到本地
 *     node_modules，无需任何外部 NODE_PATH。
 *   - 每个套件是独立进程：捕获 stdout/stderr，解析 PASS/FAIL，汇总后整体退出码
 *     反映成败（供 CI 判定）。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEV_SERVER = join(ROOT, ".dev-server.mjs");

// 套件分类（相对仓库根）
const UNIT = [
  "tests/db.test.js",
  "tests/date-unify.test.js",
  "tests/restore.test.js",
  "tests/regression.test.js",
  "tests/trends.test.js",
  "tests/duplicate.test.js",
  "tests/personalize.test.js",
  "tests/legacy-migration.test.js",
  "tests/sw-cache.test.js",
  "tests/db-reliability.test.js",
];
const SMOKE = [
  "tests/sleepdate.test.js",
  "tests/mvp.test.js",
  "tests/xss.test.js",
  "tests/morning.test.js",
  "tests/ui-smoke.test.js",
  "tests/architecture.test.js",
  "tests/history-error.test.js",
];

const SR_PORT = process.env.SR_PORT || "8796"; // 避开常见端口，便于并行

function pick(category) {
  if (category === "unit") return UNIT;
  if (category === "smoke") return SMOKE;
  return [...UNIT, ...SMOKE]; // all
}

function startServer() {
  const child = spawn(
    process.execPath,
    [DEV_SERVER],
    { cwd: ROOT, env: { ...process.env, SR_PORT }, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function waitForServer(timeoutMs = 15000) {
  const url = `http://127.0.0.1:${SR_PORT}/index.html`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (_) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("dev server 未在超时内就绪");
}

function runSuite(file) {
  return new Promise((resolve) => {
    const env = { ...process.env, SR_PORT };
    const child = spawn(process.execPath, [join(ROOT, file)], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ file, code, out }));
    child.on("error", (e) => resolve({ file, code: -1, out: String(e) }));
  });
}

function parseResult({ file, code, out }) {
  const failed = /FAIL\b/.test(out) || /failed \(/.test(out) || /\bfailed\b/.test(out);
  const passedLine = (out.match(/(\d+)\s+checks? passed/) ||
    out.match(/(\d+)\/(\d+) checks passed/) ||
    out.match(/all (\d+) checks passed/));
  let total = 0;
  let passed = 0;
  if (passedLine) {
    if (passedLine[2]) {
      passed = Number(passedLine[1]);
      total = Number(passedLine[2]);
    } else {
      total = Number(passedLine[1]);
      passed = total;
    }
  }
  const failedCount = (out.match(/(\d+) failed/g) || []).reduce(
    (a, m) => a + Number(m.replace(/\D/g, "")),
    0
  );
  // 退出码非 0 或输出含 FAIL/失败 即判失败
  const ok = code === 0 && !failed && failedCount === 0 && total > 0;
  return { file, code, total, passed, failedCount, ok, out };
}

async function main() {
  const category = process.argv[2] || "all";
  const suites = pick(category);
  let server = null;

  if (category === "smoke" || category === "all") {
    if (!existsSync(DEV_SERVER)) {
      console.error("缺少 .dev-server.mjs，无法运行 smoke 套件");
      process.exit(1);
    }
    server = startServer();
    try {
      await waitForServer();
    } catch (e) {
      console.error(e.message);
      server.kill("SIGTERM");
      process.exit(1);
    }
  }

  let grandTotal = 0;
  let grandPassed = 0;
  let anyFail = false;
  const rows = [];

  for (const file of suites) {
    const r = parseResult(await runSuite(file));
    grandTotal += r.total;
    grandPassed += r.passed;
    if (!r.ok) anyFail = true;
    const status = r.ok ? "PASS" : "FAIL";
    const detail = r.total
      ? `${r.passed}/${r.total}`
      : `exit=${r.code}`;
    rows.push(`  [${status}] ${file}  (${detail})`);
    // 失败时把该套件输出回显，便于排查
    if (!r.ok) {
      console.log(`\n----- ${file} 输出 -----`);
      console.log(r.out.trim());
      console.log(`------------------------`);
    }
  }

  if (server) server.kill("SIGTERM");

  console.log("\n测试汇总（" + category + "）：");
  for (const row of rows) console.log(row);
  console.log(
    `\n总计：${grandPassed}/${grandTotal} 通过` +
      (anyFail ? "  ❌ 存在失败" : "  ✅ 全部通过")
  );

  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error("运行器错误", e);
  process.exit(1);
});
