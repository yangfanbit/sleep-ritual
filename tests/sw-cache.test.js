/* Service Worker 缓存策略静态分析测试
 *
 * 真 SW 生命周期需要浏览器环境，无法在 Node 完整模拟。
 * 本测试对 sw.js 做静态分析，验证 Bug 3（SW 缓存导致手机没更新）的关键防护：
 *   - cache version 已 bump（旧版本号必须不存在）
 *   - App Shell 预缓存覆盖所有 JS 模块（避免离线缺模块崩溃）
 *   - activate 时删除旧 cache（旧版本不会复活）
 *   - activate 时 clients.claim（新 SW 立即接管）
 *   - 向客户端广播 cache 版本（供设置页版本诊断）
 *   - date-utils.js 在加载顺序首位（其余模块依赖它）
 *
 * 运行：node tests/sw-cache.test.js（无外部依赖）
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const swSrc = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(root, "index.html"), "utf8");

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

/* ---- cache version 已 bump 到 v16，旧 v15 不残留 ---- */
check("CACHE 已升到 v16", /sleep-ritual-v16/.test(swSrc));
check("旧 v15 已移除（避免误用）", !/sleep-ritual-v15\b/.test(swSrc));

/* ---- App Shell 预缓存覆盖全部 JS 模块 ---- */
const requiredShell = [
  "js/date-utils.js",
  "js/content.js",
  "js/db.js",
  "js/anchor.js",
  "js/content-selector.js",
  "js/analytics.js",
  "js/behavior-profile.js",
  "js/app.js",
];
for (const f of requiredShell) {
  check("SW 预缓存 " + f, swSrc.includes('"./' + f + '"'));
}

/* ---- activate 删除旧 cache + clients.claim（保证新版本接管，离线能力保留） ---- */
check("activate 过滤非当前 cache", swSrc.includes("keys.filter((k) => k !== CACHE)"));
check("activate 删除旧 cache", swSrc.includes("caches.delete(k)"));
check("activate 调用 clients.claim", /self\.clients\.claim\(\)/.test(swSrc));

/* ---- 向客户端广播 cache 版本（版本诊断依赖） ---- */
check("activate 广播 SW_CACHE_VERSION", /SW_CACHE_VERSION/.test(swSrc));
check("响应 GET_CACHE_VERSION 查询", /GET_CACHE_VERSION/.test(swSrc));

/* ---- index.html: date-utils.js 在加载首位（其余模块依赖 window.DateUtils） ---- */
const duIdx = htmlSrc.indexOf('js/date-utils.js');
const appIdx = htmlSrc.indexOf('js/app.js');
const dbIdx = htmlSrc.indexOf('js/db.js');
check("date-utils.js 在 index.html 中", duIdx > -1);
check("date-utils.js 先于 db.js 加载", duIdx > -1 && dbIdx > -1 && duIdx < dbIdx);
check("date-utils.js 先于 app.js 加载", duIdx > -1 && appIdx > -1 && duIdx < appIdx);

/* ---- index.html: 版本诊断容器存在 ---- */
check("index.html 含 #version-diagnostics", htmlSrc.includes('id="version-diagnostics"'));

/* ---- app.js: 注册后主动询问 SW 版本 + 监听 SW_CACHE_VERSION ---- */
const appSrc = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
check("app.js 监听 SW_CACHE_VERSION", appSrc.includes("SW_CACHE_VERSION"));
check("app.js 主动询问 GET_CACHE_VERSION", appSrc.includes("GET_CACHE_VERSION"));
check("app.js 含 APP_VERSION", appSrc.includes("APP_VERSION"));
check("app.js 含 renderVersionDiagnostics", appSrc.includes("renderVersionDiagnostics"));

/* ---- db.js: 迁移函数 + 数量守恒校验 ---- */
const dbSrc = fs.readFileSync(path.join(root, "js/db.js"), "utf8");
check("db.js 含 migrateLegacyNightSessions", dbSrc.includes("migrateLegacyNightSessions"));
check("db.js 含 LEGACY_MIGRATION_VERSION", dbSrc.includes("LEGACY_MIGRATION_VERSION"));
check("db.js 迁移含数量守恒校验", /before\s*!==\s*after/.test(dbSrc));
check("db.js 含 legacy_missing_status 检测", dbSrc.includes("legacy_missing_status"));
check("db.js 含 getDiagnostics", dbSrc.includes("getDiagnostics"));

/* ---- app.js: 编辑按钮修复（hidden=false + scrollIntoView） ---- */
check("app.js startEditHistory 设 ed.hidden=false", appSrc.includes("ed.hidden = false"));
check("app.js startEditHistory scrollIntoView", appSrc.includes("scrollIntoView"));

/* ---- app.js: 数据自检 loading 反馈 ---- */
check("app.js 数据自检有 loading 文案", appSrc.includes("正在扫描"));

/* ---- 输出 ---- */
let fail = 0;
for (const [n, ok] of results) {
  console.log((ok ? "PASS" : "FAIL") + "  " + n);
  if (!ok) fail++;
}
console.log(fail ? "\n" + fail + " failed (" + results.length + " total)" : "\nall " + results.length + " checks passed");
process.exitCode = fail ? 1 : 0;
