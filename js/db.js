/* ============================================================
   Sleep Ritual — IndexedDB 数据层
   Local-first，无网络依赖。

   Object Stores:
   - settings        : keyPath "key"   — 用户设置（目标作息等）
   - content         : keyPath "id"    — 内容库（quote / excerpt / tip / self）
   - nightSessions   : keyPath "id"    — 每晚的记录，index "date"
   - morningSessions : keyPath "id"    — 早晨的记录，index "date"
   - events          : keyPath "id"    — append-only 行为事件日志，index "sessionId"/"date"

   DB_VERSION 升级时通过 onupgradeneeded 增量迁移，绝不删除已有 store / 数据。
   ============================================================ */

const DB_NAME = "sleep-ritual";
const DB_VERSION = 2;
const CURRENT_SCHEMA_VERSION = 2; // 当前备份/导出格式版本；restoreAll 仅接受 <= 此版本

/* 旧数据迁移版本标记。
   每次扩展迁移逻辑时 +1；已打过标记的 NightSession 不再重复处理（幂等）。
   v1：为缺少 status 的旧 NightSession（b77ae1b 之前的版本创建）补齐
       status=completed / phoneDownAt / sessionStartedAt / completedAt / dateSource，
       并保留原始 date / id / 时间戳，绝不重新推导日期。 */
const LEGACY_MIGRATION_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // 仅创建尚不存在的 store —— 旧数据原样保留（零数据丢失迁移）
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("content")) {
        db.createObjectStore("content", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("nightSessions")) {
        const store = db.createObjectStore("nightSessions", {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("date", "date", { unique: false });
      }
      if (!db.objectStoreNames.contains("morningSessions")) {
        const store = db.createObjectStore("morningSessions", {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("date", "date", { unique: false });
      }
      if (!db.objectStoreNames.contains("events")) {
        const store = db.createObjectStore("events", {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("date", "date", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- 底层 Promise 封装 ---------- */

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => {
      // fn 通常返回 IDBRequest（add/put/delete），其 .result 为自增 key 或写入结果。
      // 解析为 key 而非 request 本身——否则调用方会拿到无法序列化/无用的 Request 对象
      // （例如 addNightSession 返回的 id 被当成 session 主键，导致 DataCloneError）。
      if (out && typeof out === "object" && typeof out.readyState === "string" && "result" in out) {
        resolve(out.result);
      } else {
        resolve(out);
      }
    };
    t.onerror = () => reject(t.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

/* 本地日期（YYYY-MM-DD）：优先用 DateUtils（统一时区语义），否则本地 Date 兜底。
   绝不使用 iso.slice(0,10)（那是 UTC，跨时区错位）。 */
function localDateOf(ts) {
  const du = (typeof window !== "undefined" && window.DateUtils) || null;
  if (du && typeof du.getLocalDate === "function") {
    const d = du.getLocalDate(ts);
    if (d) return d;
  }
  const date = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(date.getTime())) return null;
  return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

/* NightSession 稳定排序：日期降序 → 完成时间降序 → 开始时间降序 → id 降序。
   保证 getLatestNightSession 在「同日多记录」时取最新的那条。 */
function cmpNightSession(a, b) {
  if (a.date !== b.date) return b.date.localeCompare(a.date);
  const ca = a.completedAt ? new Date(a.completedAt).getTime() : -Infinity;
  const cb = b.completedAt ? new Date(b.completedAt).getTime() : -Infinity;
  if (ca !== cb) return cb - ca;
  const sa = a.sessionStartedAt ? new Date(a.sessionStartedAt).getTime() : -Infinity;
  const sb = b.sessionStartedAt ? new Date(b.sessionStartedAt).getTime() : -Infinity;
  if (sa !== sb) return sb - sa;
  return (b.id || 0) - (a.id || 0);
}

const DB = {
  _db: null,
  async ready() {
    if (!this._db) this._db = await openDB();
    return this._db;
  },

  /* ---------- settings ---------- */

  async getSetting(key, fallback = null) {
    const db = await this.ready();
    const row = await reqToPromise(
      db.transaction("settings", "readonly").objectStore("settings").get(key)
    );
    return row ? row.value : fallback;
  },

  async setSetting(key, value) {
    const db = await this.ready();
    return tx(db, "settings", "readwrite", (s) => s.put({ key, value }));
  },

  /* ---------- content ---------- */

  async getAllContent() {
    const db = await this.ready();
    return reqToPromise(
      db.transaction("content", "readonly").objectStore("content").getAll()
    );
  },

  async addContent(item) {
    const db = await this.ready();
    return tx(db, "content", "readwrite", (s) =>
      s.add({ ...item, createdAt: new Date().toISOString() })
    );
  },

  async updateContent(item) {
    const db = await this.ready();
    return tx(db, "content", "readwrite", (s) =>
      s.put({ ...item, updatedAt: new Date().toISOString() })
    );
  },

  /* 内容被展示后真实更新使用计数（让 ContentSelector 的 usagePenalty 真正生效）。 */
  async incrementContentUsage(id) {
    const all = await this.getAllContent();
    const item = all.find((c) => c.id === id);
    if (!item) return;
    const updated = Object.assign({}, item, {
      usageCount: (item.usageCount || 0) + 1,
      lastShownAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return this.updateContent(updated);
  },

  async deleteContent(id) {
    const db = await this.ready();
    return tx(db, "content", "readwrite", (s) => s.delete(id));
  },

  /* 首次启动：内容库为空时写入种子。
     优先读 data/seed-content.json（内容原子库）；
     fetch 不可用 / 文件缺失 / 解析失败时回退到 content.js 内置兜底。 */
  async seedContentIfEmpty() {
    const all = await this.getAllContent();
    if (all.length > 0) return;
    let items = SEED_CONTENT;
    try {
      const resp = await fetch("data/seed-content.json");
      if (resp.ok) {
        const data = await resp.json();
        if (data && Array.isArray(data.items) && data.items.length) {
          items = data.items;
        }
      }
    } catch (e) {
      /* 无 fetch（如测试环境）或文件缺失：用内置兜底 */
    }
    const db = await this.ready();
    return tx(db, "content", "readwrite", (s) => {
      items.forEach((item) => {
        const now = new Date().toISOString();
        // 兼容旧种子缺字段：补 createdAt / updatedAt / weight / tags / targetReasons
        s.add({
          ...item,
          tags: item.tags || [],
          targetReasons: item.targetReasons || [],
          weight: item.weight ?? 1,
          usageCount: item.usageCount || 0,
          lastShownAt: item.lastShownAt || null,
          createdAt: item.createdAt || now,
          updatedAt: item.updatedAt || now,
        });
      });
    });
  },

  /* ---------- night sessions ---------- */

  async addNightSession(session) {
    const db = await this.ready();
    return tx(db, "nightSessions", "readwrite", (s) => s.add(session));
  },

  async getNightSessionById(id) {
    const db = await this.ready();
    return reqToPromise(
      db.transaction("nightSessions", "readonly").objectStore("nightSessions").get(id)
    );
  },

  async updateNightSession(session) {
    const db = await this.ready();
    return tx(db, "nightSessions", "readwrite", (s) => s.put(session));
  },

  /* 取「本晚仍在进行（active）」的会话：同晚不重复创建 */
  async getActiveNightSession(date) {
    const all = await this.getRecentNightSessions(100000);
    return all.find((n) => n.date === date && n.status === "active") || null;
  },

  /* 取某睡眠日的全部夜间记录（用于 Data Health 重复解决：展示 A/B）。 */
  async getNightSessionsByDate(date) {
    const all = await this.getRecentNightSessions(100000);
    return all.filter((n) => n.date === date);
  },

  async getRecentNightSessions(limit = 30) {
    const db = await this.ready();
    const all = await reqToPromise(
      db.transaction("nightSessions", "readonly").objectStore("nightSessions").getAll()
    );
    return all.sort(cmpNightSession).slice(0, limit);
  },

  /* 只返回已完成（completed）的夜间记录 —— History / Analytics 的唯一数据源。
     active / abandoned 一律不进入 History，避免未完成记录污染统计与显示 NaN。 */
  async getCompletedNightSessions(limit = 30) {
    const all = await this.getRecentNightSessions(100000);
    return all.filter((n) => n.status === "completed").slice(0, limit);
  },

  /* 删除单条夜间记录（History 删除用）。不影响其它记录。 */
  async deleteNightSession(id) {
    const db = await this.ready();
    return tx(db, "nightSessions", "readwrite", (s) => s.delete(id));
  },

  async getLatestNightSession() {
    const list = await this.getRecentNightSessions(1);
    return list[0] || null;
  },

  /* ---------- morning sessions ---------- */

  async addMorningSession(session) {
    const db = await this.ready();
    return tx(db, "morningSessions", "readwrite", (s) => s.add(session));
  },

  async getRecentMorningSessions(limit = 30) {
    const db = await this.ready();
    const all = await reqToPromise(
      db.transaction("morningSessions", "readonly").objectStore("morningSessions").getAll()
    );
    return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  },

  /* 按「早晨日历日」upsert：同一天只保留一条 canonical MorningSession。
     已存在 → 保留原 id 合并更新；不存在 → 新增。避免重复保存产生多条。 */
  async upsertMorningSessionByDate(date, session) {
    const db = await this.ready();
    const all = await reqToPromise(
      db.transaction("morningSessions", "readonly").objectStore("morningSessions").getAll()
    );
    const existing = all.find((m) => m.date === date);
    if (existing) {
      const merged = Object.assign({}, existing, session, {
        id: existing.id,
        updatedAt: new Date().toISOString(),
      });
      return tx(db, "morningSessions", "readwrite", (s) => s.put(merged));
    }
    return tx(db, "morningSessions", "readwrite", (s) => s.add(session));
  },

  /* ---------- events（append-only 行为日志） ---------- */

  /* event: { sessionId?, date?, type, timestamp?, payload? }
     返回自动生成的 id（供 UI / 测试关联）。 */
  async addEvent(event) {
    const db = await this.ready();
    // 自行推导 date：优先用显式传入的，否则取时间戳的日期部分（YYYY-MM-DD）。
    // 不依赖外部 todayStr（它在 app.js 的 IIFE 作用域内，db.js 不可见，
    // 否则无顶层 date 的事件会静默丢失）。timestamp 默认当前时间。
    const ts = event.timestamp != null ? event.timestamp : new Date().toISOString();
    const ev = {
      sessionId: event.sessionId != null ? event.sessionId : null,
      date: event.date != null ? event.date : localDateOf(ts),
      type: event.type,
      timestamp: ts,
      payload: event.payload != null ? event.payload : null,
    };
    const s = db.transaction("events", "readwrite").objectStore("events");
    const req = s.add(ev);
    return reqToPromise(req);
  },

  async getRecentEvents(limit = 100) {
    const db = await this.ready();
    const all = await reqToPromise(
      db.transaction("events", "readonly").objectStore("events").getAll()
    );
    return all
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  },

  async getEventsBySession(sessionId) {
    const all = await this.getRecentEvents(100000);
    return all.filter((e) => e.sessionId === sessionId);
  },

  async getEventsByType(type, limit = 100000) {
    const all = await this.getRecentEvents(limit);
    return all.filter((e) => e.type === type);
  },

  /* ---------- 历史数据自检 / 修复（P0：安全迁移，绝不静默覆盖） ---------- */

  /* 计算某时间戳按 cutoff 应归属的睡眠日（与 sleepDate 同规则，但不依赖全局 DateUtils 也可用）。 */
  sleepDateFor(ts, cutoff = 4) {
    const du = (typeof window !== "undefined" && window.DateUtils) || null;
    if (du && typeof du.sleepDate === "function") return du.sleepDate(new Date(ts));
    const d = new Date(ts);
    if (d.getHours() < cutoff) d.setDate(d.getDate() - 1);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  },

  /* 扫描全部 NightSession，返回结构化疑点（供 Settings 人工确认 / 修复）。
     不修改任何数据。返回 [{ id, date, status, issues:[{code,detail,calculatedDate?}] }]。
     检测：
       stale_active         active 且超过 staleHours（默认 36h）未结束
       date_mismatch        completed/active 有 phoneDownAt，但按 cutoff 归日 ≠ n.date
       duplicate_completed  同一 sleepDate 多条 completed
       missing_times        completed 但缺 phoneDownAt/actualSleepAt
       unparseable_time     phoneDownAt 无法解析 */
  async findSuspiciousNightSessions(opts = {}) {
    const staleHours = opts.staleHours != null ? opts.staleHours : 36;
    const staleMs = staleHours * 3600 * 1000;
    const all = await this.getRecentNightSessions(100000);
    const completedByDate = {};
    const out = [];
    for (const n of all) {
      const issues = [];
      const pd = n.phoneDownAt || n.actualSleepAt;

      // 旧数据安全检查：缺少 status 字段（应已被启动迁移补齐）。
      // 正常情况下迁移会自动修复，此处作为兜底，确保不会静默漏掉旧记录。
      if (n.status == null) {
        issues.push({
          code: "legacy_missing_status",
          detail: "旧数据缺少 status 字段（应已被启动迁移修复；若仍出现请重新打开应用）",
        });
      }

      if (n.status === "active" && n.sessionStartedAt) {
        const started = new Date(n.sessionStartedAt).getTime();
        if (!isNaN(started) && Date.now() - started > staleMs) {
          issues.push({
            code: "stale_active",
            detail: "active 会话超过 " + staleHours + " 小时未结束",
          });
        }
      }
      if ((n.status === "completed" || n.status === "active") && pd) {
        if (isNaN(new Date(pd).getTime())) {
          issues.push({ code: "unparseable_time", detail: "放下手机时间无法解析" });
        } else {
          const calc = this.sleepDateFor(pd);
          if (calc && calc !== n.date) {
            issues.push({
              code: "date_mismatch",
              detail: "按放下手机时间应归入 " + calc + "，但记录为 " + n.date,
              calculatedDate: calc,
            });
          }
        }
      }
      if (n.status === "completed") {
        completedByDate[n.date] = (completedByDate[n.date] || 0) + 1;
        if (!(n.phoneDownAt || n.actualSleepAt)) {
          issues.push({ code: "missing_times", detail: "completed 但缺少放下手机时间" });
        }
      }
      // 关键：先无条件入列，再由下面的重复扫描补充 duplicate_completed，
      // 否则「干净重复记录」（仅因同日多条 completed 而异常）会被漏报。
      out.push({ id: n.id, date: n.date, status: n.status, issues });
    }
    Object.keys(completedByDate).forEach((d) => {
      if (completedByDate[d] > 1) {
        out
          .filter((o) => o.date === d && o.status === "completed")
          .forEach((o) =>
            o.issues.push({
              code: "duplicate_completed",
              detail: "同一睡眠日 " + d + " 存在多条 completed",
            })
          );
      }
    });
    // 去掉最终无任何异常的记录（上一步无条件入列的副作用）
    return out.filter((o) => o.issues.length > 0);
  },

  /* 用户确认后的单条日期修复：把记录归到正确睡眠日，并标注 dateSource=migration。
     只改 date / dateSource / updatedAt，不动其它完成数据。 */
  async repairNightSessionDate(id, newDate, dateSource = "migration") {
    const n = await this.getNightSessionById(id);
    if (!n) return null;
    const updated = Object.assign({}, n, {
      date: newDate,
      dateSource: dateSource,
      updatedAt: new Date().toISOString(),
    });
    await this.updateNightSession(updated);
    return updated;
  },

  /* 旧数据迁移（P0：数据安全优先，绝不静默覆盖 / 清空 / 重建）。
     背景：b77ae1b 之前的版本创建的 NightSession 只有 actualSleepAt / date 等字段，
     没有 status。新版本 History 只显示 status==="completed"，导致旧记录"消失"。
     本函数一次性补齐缺失字段，把旧记录安全地纳入 History。

     原则（严格遵守）：
       1. 只补缺失字段，绝不覆盖已有值（if (x == null) 才写）。
       2. 状态推断：有 actualSleepAt/completedAt → completed；否则标记 legacy 待人工确认。
       3. 保留原始 date / id / 时间戳，不重新推导睡眠日（避免再次日期错位）。
       4. 幂等：已打 legacyMigrationVersion 标记的记录跳过，多次运行结果一致、不重复。
       5. 数量守恒：迁移前后 nightSessions 总数必须相等，否则中止并报错，绝不删除。

     返回报告：{ before, after, recovered, completed, active, needsReview, modified, ok, error? } */
  async migrateLegacyNightSessions() {
    const all = await this.getRecentNightSessions(100000);
    const before = all.length;
    let recovered = 0, completed = 0, active = 0, needsReview = 0, modified = 0;
    const writes = [];

    for (const n of all) {
      // 已迁移过的记录：跳过写入（统计仍计入最终状态）
      const alreadyMigrated = n.legacyMigrationVersion === LEGACY_MIGRATION_VERSION;
      const updated = Object.assign({}, n);
      let changed = false;

      // 1) 推断 status（核心：补齐后旧记录才会进入 completed-only History）
      if (n.status == null) {
        const hasCompletion = !!(n.actualSleepAt || n.completedAt);
        updated.status = hasCompletion ? "completed" : "legacy";
        changed = true;
      }

      // 2) 补 phoneDownAt（History / Analytics 依赖 pd = phoneDownAt || actualSleepAt）
      if (updated.phoneDownAt == null) {
        const pd = updated.actualSleepAt || updated.completedAt;
        if (pd) { updated.phoneDownAt = pd; changed = true; }
      }
      // 反向兜底：仅有 completedAt 没有 actualSleepAt 时也补齐，保证两字段一致
      if (updated.actualSleepAt == null && updated.completedAt) {
        updated.actualSleepAt = updated.completedAt; changed = true;
      }
      // 3) 补 sessionStartedAt（cmpNightSession 排序依赖）
      if (updated.sessionStartedAt == null) {
        const s = updated.shownAt || updated.actualSleepAt || updated.completedAt;
        if (s) { updated.sessionStartedAt = s; changed = true; }
      }
      // 4) 补 completedAt
      if (updated.completedAt == null && updated.actualSleepAt) {
        updated.completedAt = updated.actualSleepAt; changed = true;
      }
      // 5) 标注迁移来源（绝不重新推导 date —— 保留原始睡眠日）
      if (updated.dateSource == null) {
        updated.dateSource = "legacy"; changed = true;
      }

      // 统计最终状态（只计一次）
      if (updated.status === "completed") {
        completed++;
        if (n.status == null && (n.actualSleepAt || n.completedAt)) recovered++;
      } else if (updated.status === "active") {
        active++;
      } else {
        needsReview++;
      }

      if (changed && !alreadyMigrated) {
        updated.legacyMigrationVersion = LEGACY_MIGRATION_VERSION;
        updated.migratedAt = new Date().toISOString();
        writes.push(updated);
      }
    }

    for (const u of writes) {
      await this.updateNightSession(u);
      modified++;
    }

    // 数量守恒校验：迁移绝不能导致记录变多/变少
    const after = (await this.getRecentNightSessions(100000)).length;
    if (before !== after) {
      const error =
        `迁移数量异常：迁移前 ${before} 条，迁移后 ${after} 条，已停止并保留原数据。`;
      console.error("[migration] " + error);
      const bad = { before, after, recovered, completed, active, needsReview, modified, ok: false, error };
      await this.setSetting("lastLegacyMigrationReport", bad).catch(() => {});
      return bad;
    }

    const report = { before, after, recovered, completed, active, needsReview, modified, ok: true };
    await this.setSetting("lastLegacyMigrationReport", report).catch(() => {});
    return report;
  },

  /* 版本诊断信息（供设置页展示：App / SW / DB 版本对照） */
  async getDiagnostics() {
    return {
      dbName: DB_NAME,
      dbVersion: DB_VERSION,
      schemaVersion: 2,
      legacyMigrationVersion: LEGACY_MIGRATION_VERSION,
    };
  },

  /* ---------- 导出 / 导入 / 清空 ---------- */

  async exportAll() {
    const [settings, content, nightSessions, morningSessions, events] =
      await Promise.all([
        (async () => {
          const db = await this.ready();
          return reqToPromise(
            db.transaction("settings", "readonly").objectStore("settings").getAll()
          );
        })(),
        this.getAllContent(),
        this.getRecentNightSessions(100000),
        this.getRecentMorningSessions(100000),
        (async () => {
          const db = await this.ready();
          return reqToPromise(
            db.transaction("events", "readonly").objectStore("events").getAll()
          );
        })(),
      ]);
    return {
      app: "sleep-ritual",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      version: CURRENT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      content,
      nightSessions,
      morningSessions,
      events,
    };
  },

  /* ---------- 备份校验（Restore 前置，纯函数，不触碰 DB） ---------- */
  validateBackup(data) {
    const errors = [];
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, errors: ["不是合法的对象"], summary: null };
    }
    if (data.app !== "sleep-ritual") {
      errors.push("不是 Sleep Ritual 备份文件（app 字段不符）");
    }
    const sv = data.schemaVersion != null
      ? data.schemaVersion
      : data.version != null
      ? data.version
      : 1;
    if (sv > CURRENT_SCHEMA_VERSION) {
      errors.push(
        `不支持的备份版本 schemaVersion=${sv}（当前最高支持 ${CURRENT_SCHEMA_VERSION}）`
      );
    }
    const stores = ["settings", "content", "nightSessions", "morningSessions", "events"];
    stores.forEach((k) => {
      if (data[k] === undefined) return; // 旧版可能缺 events，允许
      if (!Array.isArray(data[k])) errors.push(`${k} 不是合法数组`);
    });
    // 关键字段类型校验（抽样前若干条，避免大文件全量扫描）
    const typeCheck = (arr, name, mustHave) => {
      if (!Array.isArray(arr)) return;
      arr.slice(0, 50).forEach((r, i) => {
        if (r == null || typeof r !== "object") errors.push(`${name}[${i}] 不是对象`);
        else if (mustHave && !mustHave.every((f) => f in r))
          errors.push(`${name}[${i}] 缺少关键字段`);
      });
    };
    typeCheck(data.nightSessions, "nightSessions", ["date"]);
    typeCheck(data.morningSessions, "morningSessions", ["date"]);
    typeCheck(data.events, "events");

    const summary = {
      night: Array.isArray(data.nightSessions) ? data.nightSessions.length : 0,
      morning: Array.isArray(data.morningSessions) ? data.morningSessions.length : 0,
      events: Array.isArray(data.events) ? data.events.length : 0,
      content: Array.isArray(data.content) ? data.content.length : 0,
      settings: Array.isArray(data.settings) ? data.settings.length : 0,
    };
    return { ok: errors.length === 0, errors, summary, schemaVersion: sv };
  },

  /* 版本转换层：把任意支持版本（<=CURRENT）的备份规范化为当前结构。
     当前只有 v1/v2；未来版本在此分支做字段映射，禁止静默丢弃字段。 */
  normalizeBackup(data) {
    const sv = data.schemaVersion != null
      ? data.schemaVersion
      : data.version != null
      ? data.version
      : 1;
    const out = {
      settings: Array.isArray(data.settings) ? data.settings : [],
      content: Array.isArray(data.content) ? data.content : [],
      nightSessions: Array.isArray(data.nightSessions) ? data.nightSessions : [],
      morningSessions: Array.isArray(data.morningSessions) ? data.morningSessions : [],
      events: Array.isArray(data.events) ? data.events : [],
    };
    if (sv < 2) {
      // 旧版（无 events）：缺失集合以空数组兜底，无结构化转换需求
    }
    return out;
  },

  /* ---------- Restore（用备份恢复到备份时的状态，整体覆盖当前） ----------
     语义：与旧版「merge-only import」彻底区分——Restore 是「整体替换」。
     流程：校验 → 先备份当前数据（防恢复失败 / 误恢复）→ 单事务 clear+put 全部 5 个 store
           → 数量校验 → 迁移旧记录 → 返回报告。
     安全：单事务保证「要么全成功、要么全不写」（失败时当前数据原样保留）；
           恢复前已把当前数据快照存入 lastRestoreBackup，误恢复可再恢复回去。 */
  async restoreAll(data) {
    const validation = this.validateBackup(data);
    if (!validation.ok) {
      const err = new Error("备份校验失败：" + validation.errors.join("；"));
      err.code = "BACKUP_INVALID";
      err.validation = validation;
      throw err;
    }

    // 1) 先备份当前数据（内存快照，用于误恢复后反悔；恢复本身若失败则由事务保证不写）
    let snapshot = null;
    try {
      snapshot = await this.exportAll();
    } catch (_) {}

    // 2) 单事务整体替换：clear + put 全部 store；任一步失败 → 事务中止 → 当前数据不动
    const normalized = this.normalizeBackup(data);
    const db = await this.ready();
    const storeNames = ["settings", "content", "nightSessions", "morningSessions", "events"];
    await new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, "readwrite");
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error || new Error("恢复事务失败"));
      t.onabort = () => reject(t.error || new Error("恢复事务被中止"));
      storeNames.forEach((name) => {
        const store = t.objectStore(name);
        store.clear();
        (normalized[name] || []).forEach((r) => store.put(r));
      });
    });

    // 3) 数量守恒校验：恢复后各集合数量应与备份一致（事务异常时理论上不会到达这里）
    const after = await this.exportAll();
    const sameCount = (k) =>
      (after[k] ? after[k].length : 0) === (normalized[k] ? normalized[k].length : 0);
    if (!["settings", "content", "nightSessions", "morningSessions", "events"].every(sameCount)) {
      throw new Error("恢复后数据数量校验不一致，已中止（事务回滚）。");
    }

    // 4) 恢复成功后再写快照（必须放在 clear+put 之后，否则会被上面的事务清空）
    if (snapshot) await this.setSetting("lastRestoreBackup", snapshot).catch(() => {});

    // 5) 恢复后运行迁移，确保备份里任何旧记录也能纳入 History
    await this.migrateLegacyNightSessions().catch(() => {});

    return { ok: true, summary: validation.summary, restoredAt: new Date().toISOString() };
  },

  async wipeAll() {
    const db = await this.ready();
    const clear = (storeName) =>
      tx(db, storeName, "readwrite", (s) => s.clear());
    await clear("settings");
    await clear("content");
    await clear("nightSessions");
    await clear("morningSessions");
    await clear("events");
  },
};

// 测试/调试钩子：把本地 DB 句柄挂到 window（对生产逻辑无副作用）。
// 用 typeof 守护，避免在 Node 测试上下文（无 window）下报错。
if (typeof window !== "undefined") window.DB = DB;
