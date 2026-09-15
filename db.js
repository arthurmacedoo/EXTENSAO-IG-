/**
 * db.js — Camada de Persistência com IndexedDB
 * --------------------------------------------------------------------------
 * Armazenamento transacional robusto:
 * - Suporta mais de 100.000 comentários sem lentidão.
 * - Append atômico registro por registro (não serializa arrays gigantes).
 * - Arquitetura baseada em Sessões: "Limpar" apenas arquiva e cria nova sessão.
 *   Nenhum dado é apagado permanentemente por acidente!
 * --------------------------------------------------------------------------
 */

const DB_NAME = "IGLiveCommerceDB";
const DB_VERSION = 1;

class LiveDatabase {
  constructor() {
    this.db = null;
    this._initPromise = null;
  }

  async open() {
    if (this.db) return this.db;
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("sessions")) {
          const sStore = db.createObjectStore("sessions", { keyPath: "id" });
          sStore.createIndex("by_startedAt", "startedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("comments")) {
          const cStore = db.createObjectStore("comments", { keyPath: "id" });
          cStore.createIndex("by_session", "sessionId", { unique: false });
          cStore.createIndex("by_pk", "pk", { unique: false });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => {
        console.error("[IG Live DB] Erro ao abrir IndexedDB:", e.target.error);
        reject(e.target.error);
      };
    });

    return this._initPromise;
  }

  async createSession(title) {
    const db = await this.open();
    const now = new Date();
    const id = `session_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`;
    const session = {
      id,
      title: title || `Live — ${now.toLocaleDateString("pt-BR")} às ${now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`,
      startedAt: now.toISOString(),
      endedAt: null,
      commentCount: 0,
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session);
      tx.oncomplete = () => resolve(session);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async getLatestActiveSession() {
    const sessions = await this.getAllSessions();
    if (sessions.length === 0) return null;
    // Ordena da mais recente para a mais antiga
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    const latest = sessions[0];
    // Se a última sessão tiver menos de 8 horas e não tiver sido encerrada explicitamente, reutiliza
    const ageMs = Date.now() - new Date(latest.startedAt).getTime();
    if (!latest.endedAt && ageMs < 8 * 60 * 60 * 1000) {
      return latest;
    }
    return null;
  }

  async getSession(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllSessions() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async endSession(id) {
    const session = await this.getSession(id);
    if (!session) return;
    session.endedAt = new Date().toISOString();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session);
      tx.oncomplete = () => resolve(session);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async deleteSession(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "comments"], "readwrite");
      tx.objectStore("sessions").delete(id);

      // Deleta todos os comentários associados a essa sessão
      const cStore = tx.objectStore("comments");
      const index = cStore.index("by_session");
      const req = index.openKeyCursor(IDBKeyRange.only(id));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cStore.delete(cursor.primaryKey);
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async saveComment(comment) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(["comments", "sessions"], "readwrite");
      const cStore = tx.objectStore("comments");
      cStore.put(comment);

      // Atualiza o contador na sessão
      const sStore = tx.objectStore("sessions");
      const sReq = sStore.get(comment.sessionId);
      sReq.onsuccess = () => {
        const session = sReq.result;
        if (session) {
          session.commentCount = (session.commentCount || 0) + 1;
          sStore.put(session);
        }
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async getSessionComments(sessionId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("comments", "readonly");
      const index = tx.objectStore("comments").index("by_session");
      const req = index.getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => {
        const list = req.result || [];
        // Ordena por timestamp crescente
        list.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
        resolve(list);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }
}

// Instância global para o content script
window.LiveDB = new LiveDatabase();
