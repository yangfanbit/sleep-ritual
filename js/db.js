/* ============================================================
   Sleep Ritual — IndexedDB 数据层
   Local-first，无网络依赖。

   Object Stores:
   - settings        : keyPath "key"   — 用户设置（目标作息等）
   - content         : keyPath "id"    — 内容库（quote / excerpt / tip / self）
   - nightSessions   : keyPath "id"    — 每晚的记录，index "date"
   - morningSessions : keyPath "id"    — 早晨的记录，index "date"
   ============================================================ */

const DB_NAME = "sleep-ritual";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
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
    t.oncomplete = () => resolve(out && out.__result !== undefined ? out.__result : out);
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
      items.forEach((item) =>
        s.add({ ...item, createdAt: new Date().toISOString() })
      );
    });
  },

  /* ---------- night sessions ---------- */

  async addNightSession(session) {
    const db = await this.ready();
    return tx(db, "nightSessions", "readwrite", (s) => s.add(session));
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

  /* ---------- 导出 / 导入 / 清空 ---------- */

  async exportAll() {
    const [settings, content, nightSessions, morningSessions] = await Promise.all([
      (async () => {
        const db = await this.ready();
        return reqToPromise(
          db.transaction("settings", "readonly").objectStore("settings").getAll()
        );
      })(),
      this.getAllContent(),
      this.getRecentNightSessions(100000),
      this.getRecentMorningSessions(100000),
    ]);
    return {
      app: "sleep-ritual",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      content,
      nightSessions,
      morningSessions,
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
    await putAll("settings", data.settings);
    await putAll("content", data.content);
    await putAll("nightSessions", data.nightSessions);
    await putAll("morningSessions", data.morningSessions);
  },

  async wipeAll() {
    const db = await this.ready();
    const clear = (storeName) =>
      tx(db, storeName, "readwrite", (s) => s.clear());
    await clear("settings");
    await clear("content");
    await clear("nightSessions");
    await clear("morningSessions");
  },
};
