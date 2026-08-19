/* ============================================================
   Sleep Ritual — 日期工具（统一本地日期 / 睡眠日 / 安全格式化）
   所有业务层的时间计算都走这里，禁止在别处自行 slice(0,10) 或重复实现。

   四种概念（务必区分）：
   - Calendar Date  日历日（今天）：todayStr()
   - Local Date     本地日期（由 ISO 时间戳按本地时区取 YYYY-MM-DD）：getLocalDate()
   - Sleep Date     睡眠日：00:00–03:59 归入前一天，04:00 起算当天：sleepDate()
   - Timestamp      ISO 时间戳（带时分秒与时区）

   时区：全程用原生 Date 的本地方法，不引入 timezone 库。
   ============================================================ */

(function (global) {
  "use strict";

  const NIGHT_CUTOFF_HOUR = 4; // 00:00–03:59 入睡算「前一天」的睡眠日

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  /* Calendar Date：本地「今天」YYYY-MM-DD */
  function todayStr(d = new Date()) {
    const date = d instanceof Date ? d : new Date(d);
    return (
      date.getFullYear() +
      "-" +
      pad2(date.getMonth() + 1) +
      "-" +
      pad2(date.getDate())
    );
  }

  /* Local Date：由 ISO 时间戳（或 Date）按「本地时区」取 YYYY-MM-DD。
     不使用 iso.slice(0,10)（那是 UTC，会跨时区错位）。 */
  function getLocalDate(ts) {
    const date = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(date.getTime())) return null;
    return todayStr(date);
  }

  /* Sleep Date：把凌晨 0–3:59 的入睡归入前一天。
     返回本地 YYYY-MM-DD。与 NightSession.date / Event.date 统一语义。 */
  function sleepDate(d = new Date(), cutoff = NIGHT_CUTOFF_HOUR) {
    const date = d instanceof Date ? new Date(d) : new Date(d);
    if (date.getHours() < cutoff) {
      date.setDate(date.getDate() - 1);
    }
    return todayStr(date);
  }

  /* 安全时间格式化：把 ISO 时间戳格式化为 HH:MM。
     对 undefined / null / "" / NaN / Invalid Date → 返回 fallback（默认 "--:--"）。 */
  function formatTime(ts, fallback = "--:--") {
    if (ts == null || ts === "") return fallback;
    const date = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(date.getTime())) return fallback;
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  /* 安全日期时间格式化（用于编辑框回填）：YYYY-MM-DDTHH:MM（本地，datetime-local 友好）。 */
  function formatLocalInput(ts, fallback = "") {
    if (ts == null || ts === "") return fallback;
    const date = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(date.getTime())) return fallback;
    return (
      todayStr(date) +
      "T" +
      pad2(date.getHours()) +
      ":" +
      pad2(date.getMinutes())
    );
  }

  /* 解析 datetime-local 输入（"YYYY-MM-DDTHH:MM"）→ ISO 字符串；无效返回 null。 */
  function parseLocalInput(val) {
    if (!val) return null;
    const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, h, mi] = m.map(Number);
    const date = new Date(y, mo - 1, d, h, mi, 0, 0);
    if (isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  /* 校验 YYYY-MM-DD 是否合法日历日。 */
  function isValidDateStr(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, mo, d] = s.split("-").map(Number);
    const date = new Date(y, mo - 1, d);
    return (
      date.getFullYear() === y &&
      date.getMonth() + 1 === mo &&
      date.getDate() === d
    );
  }

  /* 校验 HH:MM 是否合法。 */
  function isValidHHMM(s) {
    if (typeof s !== "string" || !/^\d{1,2}:\d{2}$/.test(s)) return false;
    const [h, m] = s.split(":").map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }

  const DateUtils = {
    NIGHT_CUTOFF_HOUR,
    pad2,
    todayStr,
    getLocalDate,
    sleepDate,
    formatTime,
    formatLocalInput,
    parseLocalInput,
    isValidDateStr,
    isValidHHMM,
  };

  global.DateUtils = DateUtils;
})(window);
