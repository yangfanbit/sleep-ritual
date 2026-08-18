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

  async getRecentNightSessions(limit = 30) {
    const db = await this.ready();
    const all = await reqToPromise(
      db.transaction("nightSessions", "readonly").objectStore("nightSessions").getAll()
    );
    return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
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

  /* ---------- events（append-only 行为日志） ---------- */

  /* event: { sessionId?, date?, type, timestamp?, payload? }
     返回自动生成的 id（供 UI / 测试关联）。 */
  async addEvent(event) {
    const db = await this.ready();
    const ev = {
      sessionId: event.sessionId != null ? event.sessionId : null,
      date: event.date != null ? event.date : todayStr(),
      type: event.type,
      timestamp: event.timestamp != null ? event.timestamp : new Date().toISOString(),
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
      schemaVersion: 2,
      version: 2,
      exportedAt: new Date().toISOString(),
      settings,
      content,
      nightSessions,
      morningSessions,
      events,
    };
  },

  async importAll(data) {
    if (!data || data.app !== "sleep-ritual") {
      throw new Error("不是 Sleep Ritual 的备份文件");
    }
    const db = await this.ready();
    const putAll = (storeName, rows) =>
      rows && rows.length
        ? tx(db, storeName, "readwrite", (s) => rows.forEach((r) => s.put(r)))
        : Promise.resolve();
    // 兼容旧版备份（无 events / schemaVersion）：缺失字段以空/默认值兜底
    await putAll("settings", data.settings);
    await putAll("content", data.content);
    await putAll("nightSessions", data.nightSessions);
    await putAll("morningSessions", data.morningSessions);
    await putAll("events", data.events || []);
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
