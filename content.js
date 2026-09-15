/**
 * content.js — IG Live: Captura Profissional de Comentários (v2.0)
 * ---------------------------------------------------------------------
 * Arquitetura de Alta Disponibilidade para Live Commerce (4-5h / 5.000+ coments):
 * 1. Híbrida: Interceptação Passiva de Rede (REST) + Scanner de DOM (Responder/Avatares).
 * 2. Banco de Dados IndexedDB: persistência append-only, transacional, sem limite de 10MB.
 * 3. Gestão de Sessões com Soft Delete: "Limpar" apenas arquiva, NUNCA apaga do banco.
 * 4. Modal de Histórico de Sessões integrado: re-exporte qualquer live passada.
 * 5. Anti-Descarte de Aba: Web Locks API + Port Keep-Alive contra Chrome Memory Saver.
 * 6. Backup Automático em checkpoints a cada 250 comentários ou 30 minutos.
 * ---------------------------------------------------------------------
 */

(function () {
  "use strict";

  const CONFIG = {
    AUTO_CHECKPOINT_COUNT: 250, // Backup a cada 250 comentários
    AUTO_CHECKPOINT_MINUTES: 30, // Backup a cada 30 min
    DOM_SCAN_INTERVAL_MS: 1200,
  };

  const ACTION_WORDS = new Set([
    "responder", "curtir", "reply", "like", "ver tradução", "see translation",
    "traduzir", "translate", "ver mais", "see more", "mostrar mais", "seguir", "follow",
    "seguindo", "following", "editar perfil", "edit profile", "fixado", "pinned", "fixar", "pin"
  ]);

  const PURCHASE_KEYWORDS = ["quero", "reserva", "separa", "tamanho", "pix", "valor", "preço", "comprar", "leva"];

  const unrecordedRestBuffer = [];

  const state = {
    status: "paused",
    currentSession: null,
    comments: [], // Cache em memória da sessão atual
    seenPks: new Set(),
    recentCapturedMap: new Map(), // chave user::text -> timestamp (janela deslizante contra duplicatas cruzadas REST/DOM)
    lastCheckpointCount: 0,
    autoBackupEnabled: true,
  };

  function recordRecentComment(user, text) {
    const fp = `${user.toLowerCase().replace(/^@/, "")}::${text.toLowerCase().trim()}`;
    const now = Date.now();
    state.recentCapturedMap.set(fp, now);
    if (state.recentCapturedMap.size > 250) {
      for (const [k, ts] of state.recentCapturedMap.entries()) {
        if (now - ts > 10000) state.recentCapturedMap.delete(k);
      }
    }
  }

  function isRecentlyCaptured(user, text, windowMs = 3000) {
    const fp = `${user.toLowerCase().replace(/^@/, "")}::${text.toLowerCase().trim()}`;
    const ts = state.recentCapturedMap.get(fp);
    if (!ts) return false;
    return Date.now() - ts < windowMs;
  }

  let domObserver = null;
  let domInterval = null;
  let checkpointTimer = null;
  let keepAlivePort = null;
  const panelEls = {};

  // ----------------------------------------------------------------
  // 1. Conexão Anti-Descarte de Aba (Chrome Memory Saver Guard)
  // ----------------------------------------------------------------

  function activateTabKeepAlive() {
    try {
      // 1. Web Locks API mantém trava ativa
      if (navigator.locks && navigator.locks.request) {
        navigator.locks.request("ig_live_capture_lock", { mode: "shared" }, () => {
          return new Promise(() => {}); // Não resolve nunca enquanto a página estiver aberta
        }).catch(() => {});
      }

      // 2. Conecta Port com o Service Worker
      if (typeof chrome !== "undefined" && chrome.runtime?.connect) {
        keepAlivePort = chrome.runtime.connect({ name: "IG_LIVE_KEEP_ALIVE" });
        keepAlivePort.onDisconnect.addListener(() => {
          setTimeout(activateTabKeepAlive, 3000);
        });
      }
    } catch (e) {}
  }

  // ----------------------------------------------------------------
  // 2. Escuta de Mensagens do Interceptor de Rede (world: MAIN)
  // ----------------------------------------------------------------

  window.addEventListener("message", (event) => {
    if (!event.data || event.data.source !== "IG_LIVE_INTERCEPTOR") return;

    if (event.data.type === "REST_COMMENTS") {
      const incoming = event.data.comments || [];
      if (state.status === "recording") {
        ingestRestComments(incoming);
      } else {
        unrecordedRestBuffer.push(...incoming);
        if (unrecordedRestBuffer.length > 200) {
          unrecordedRestBuffer.splice(0, unrecordedRestBuffer.length - 200);
        }
      }
    }
  });

  async function ingestRestComments(rawComments) {
    if (!Array.isArray(rawComments) || rawComments.length === 0) return;

    for (const c of rawComments) {
      if (!c) continue;
      const pk = String(c.pk || c.strong_id__ || "");
      if (pk && state.seenPks.has(pk)) continue;

      const username = c.user?.username || (typeof c.user === "string" ? c.user : "");
      const text = (c.text || "").trim();
      if (!username || !text) continue;

      if (pk) {
        state.seenPks.add(pk);
      } else {
        if (isRecentlyCaptured(username, text, 2000)) continue;
      }
      recordRecentComment(username, text);

      const now = new Date(c.created_at ? c.created_at * 1000 : Date.now());
      const entry = {
        id: `${state.currentSession?.id || "default"}_${pk || Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId: state.currentSession?.id || "default",
        pk: pk || null,
        user: "@" + username.replace(/^@/, ""),
        comment: text,
        captured_time: now.toLocaleTimeString("pt-BR", { hour12: false }),
        captured_at: now.toISOString(),
        timestampMs: now.getTime(),
        source: "REST",
      };

      await registerCommentEntry(entry);
    }
  }

  // ----------------------------------------------------------------
  // 3. Scanner Complementar de DOM (Fallback caso REST oscile)
  // ----------------------------------------------------------------

  const SYSTEM_PHRASES = [
    "também está assistindo", "começou a assistir", "entrou na live",
    "entrou na transmissão", "is also watching", "started watching",
    "joined the live", "joined"
  ];

  function isSystemNotice(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return SYSTEM_PHRASES.some((phrase) => lower.includes(phrase));
  }

  function extractUsernameFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const isAllowedHost =
        /(^|\.)instagram\.com$/.test(url.hostname) ||
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1";
      if (!isAllowedHost) return null;

      const match = url.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (!match) return null;

      const user = match[1].toLowerCase();
      const IGNORED = new Set([
        "explore", "reels", "stories", "direct", "accounts", "legal", "about",
        "developer", "api", "emails", "challenge", "disclaimer", "directory",
        "session", "tv", "p", "ads", "privacy", "terms", "safety", "creators",
        "business", "help", "settings", "loginhelp", "accountscenter", "live"
      ]);
      if (IGNORED.has(user)) return null;
      return user;
    } catch (e) {
      return null;
    }
  }

  function extractUserFromAlt(alt) {
    if (!alt || typeof alt !== "string") return null;
    const s = alt.trim().replace(/\.$/, "");
    let m = s.match(/(?:foto\s+(?:do|de)\s+)?perfil\s+d[eoa]\s+([a-zA-Z0-9._]+)/i);
    if (m) return m[1];
    m = s.match(/(?:foto\s+del\s+)?perfil\s+de\s+([a-zA-Z0-9._]+)/i);
    if (m) return m[1];
    m = s.match(/^([a-zA-Z0-9._]+)['’]s\s+profile\s+(?:picture|photo)/i);
    if (m) return m[1];
    m = s.match(/profile\s+(?:picture|photo)\s+of\s+([a-zA-Z0-9._]+)/i);
    if (m) return m[1];
    m = s.match(/^@?([a-zA-Z0-9._]{2,35})$/);
    if (m) return m[1];
    return null;
  }

  function getCleanNodeText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button, [role='button'], svg").forEach((b) => b.remove());
    clone.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        const t = (el.textContent || "").trim().toLowerCase();
        if (ACTION_WORDS.has(t)) el.remove();
      }
    });
    return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findBestCommentContainer(respEl) {
    let curr = respEl.parentElement;
    let bestCandidate = null;

    for (let depth = 0; depth < 6 && curr && curr !== document.body; depth++) {
      if (curr.id === "ig-live-capture-panel") break;

      const leaves = curr.querySelectorAll("button, [role='button'], span, div");
      let responderCount = 0;
      for (let i = 0; i < leaves.length; i++) {
        if (leaves[i].children.length === 0) {
          const t = (leaves[i].textContent || "").trim().toLowerCase();
          if (t === "responder" || t === "reply") responderCount++;
        }
      }
      if (responderCount > 1) break;

      const cleanText = getCleanNodeText(curr);
      if (cleanText.length > 0 && cleanText.length < 500) {
        bestCandidate = curr;
        const img = curr.querySelector("img");
        if (img && extractUserFromAlt(img.getAttribute("alt"))) {
          return curr;
        }
        const a = curr.querySelector("a[href]");
        if (a && extractUsernameFromHref(a.getAttribute("href"))) {
          return curr;
        }
      }
      curr = curr.parentElement;
    }
    return bestCandidate;
  }

  function extractCommentFromContainer(row) {
    if (!row) return null;
    if (row.dataset && row.dataset.igCaptured === "true") return null;
    if (row.closest && row.closest("[data-ig-captured='true']")) return null;

    let username = null;

    // A) Imagem de avatar com alt
    const imgs = row.querySelectorAll("img");
    for (const img of imgs) {
      const u = extractUserFromAlt(img.getAttribute("alt"));
      if (u) {
        username = u;
        break;
      }
    }

    // B) Link para perfil
    if (!username) {
      const anchors = row.querySelectorAll("a[href]");
      for (const a of anchors) {
        const u = extractUsernameFromHref(a.getAttribute("href"));
        if (u) {
          username = u;
          break;
        }
      }
    }

    // C) Elemento de autor (span, div, bold)
    if (!username) {
      const candidates = row.querySelectorAll("span, div, [role='link'], b, strong");
      for (const el of candidates) {
        if (el.children.length === 0) {
          const t = (el.textContent || "").trim().replace(/^@/, "");
          if (/^[a-zA-Z0-9._]{2,35}$/.test(t) && !ACTION_WORDS.has(t.toLowerCase())) {
            username = t;
            break;
          }
        }
      }
    }

    const clone = row.cloneNode(true);
    clone.querySelectorAll("img").forEach((i) => {
      const alt = i.getAttribute("alt") || "";
      if (alt && !alt.toLowerCase().includes("perfil") && !alt.toLowerCase().includes("profile")) {
        i.replaceWith(document.createTextNode(alt));
      } else {
        i.remove();
      }
    });
    clone.querySelectorAll("button, [role='button'], svg").forEach((b) => b.remove());
    clone.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        const t = (el.textContent || "").trim().toLowerCase();
        if (ACTION_WORDS.has(t)) el.remove();
      }
    });

    let rawText = (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
    if (!rawText) return null;

    let commentText = "";
    if (username) {
      const userRegex = new RegExp("^@?" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[:\\s-]*", "i");
      commentText = rawText.replace(userRegex, "").trim();
    } else {
      const parts = rawText.split(/\s+/);
      if (parts.length >= 2) {
        const possibleUser = parts[0].replace(/^@/, "").replace(/[:]$/, "").trim();
        if (/^[a-zA-Z0-9._]{2,35}$/.test(possibleUser) && !ACTION_WORDS.has(possibleUser.toLowerCase())) {
          username = possibleUser;
          commentText = parts.slice(1).join(" ").trim();
        }
      }
    }

    if (!username || !commentText) return null;

    for (const act of ACTION_WORDS) {
      const actRegex = new RegExp("\\s*" + act + "$", "i");
      commentText = commentText.replace(actRegex, "").trim();
    }
    if (!commentText) return null;

    if (isSystemNotice(commentText) || isSystemNotice(rawText)) {
      return null;
    }

    return { username: "@" + username.replace(/^@/, ""), commentText, row };
  }

  function scanDomForComments() {
    if (state.status !== "recording") return;

    // 1. Busca botões "Responder" / "Reply"
    const leaves = document.querySelectorAll("button, [role='button'], span, div");
    for (let i = 0; i < leaves.length; i++) {
      const el = leaves[i];
      if (el.children.length > 0) continue;
      const t = (el.textContent || "").trim().toLowerCase();
      if (t === "responder" || t === "reply") {
        const container = findBestCommentContainer(el);
        if (container) {
          processExtractedComment(extractCommentFromContainer(container));
        }
      }
    }

    // 2. Busca por imagens de avatar (para comentários sem botão responder ou fixados)
    const imgs = document.querySelectorAll('img[alt*="perfil" i], img[alt*="profile" i]');
    for (const img of imgs) {
      if (img.closest && img.closest("#ig-live-capture-panel")) continue;
      let curr = img.parentElement;
      for (let depth = 0; depth < 5 && curr && curr !== document.body; depth++) {
        if (curr.id === "ig-live-capture-panel") break;
        const info = extractCommentFromContainer(curr);
        if (info) {
          processExtractedComment(info);
          break;
        }
        curr = curr.parentElement;
      }
    }

    // 3. Busca por links diretos de usuário
    const anchors = document.querySelectorAll("a[href]");
    for (const a of anchors) {
      if (a.closest && a.closest("#ig-live-capture-panel")) continue;
      if (!extractUsernameFromHref(a.getAttribute("href"))) continue;
      let curr = a.parentElement;
      for (let depth = 0; depth < 4 && curr && curr !== document.body; depth++) {
        if (curr.id === "ig-live-capture-panel") break;
        const info = extractCommentFromContainer(curr);
        if (info) {
          processExtractedComment(info);
          break;
        }
        curr = curr.parentElement;
      }
    }
  }

  async function processExtractedComment(info) {
    if (!info) return;
    const { username, commentText, row } = info;

    row.dataset.igCaptured = "true";

    if (isRecentlyCaptured(username, commentText, 3500)) return;
    recordRecentComment(username, commentText);

    const now = new Date();
    const entry = {
      id: `${state.currentSession?.id || "default"}_dom_${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`,
      sessionId: state.currentSession?.id || "default",
      pk: null,
      user: username,
      comment: commentText,
      captured_time: now.toLocaleTimeString("pt-BR", { hour12: false }),
      captured_at: now.toISOString(),
      timestampMs: now.getTime(),
      source: "DOM",
    };

    await registerCommentEntry(entry);
  }

  // ----------------------------------------------------------------
  // 4. Registro no IndexedDB e Checkpoints
  // ----------------------------------------------------------------

  async function registerCommentEntry(entry) {
    state.comments.push(entry);

    // Salva atomicamente no IndexedDB
    if (window.LiveDB) {
      try {
        await window.LiveDB.saveComment(entry);
      } catch (e) {
        console.warn("[IG Live] Falha ao salvar no IndexedDB:", e);
      }
    }

    updateCounterAndPreview(entry);

    // Auto-checkpoint a cada N comentários
    if (state.autoBackupEnabled && state.comments.length - state.lastCheckpointCount >= CONFIG.AUTO_CHECKPOINT_COUNT) {
      state.lastCheckpointCount = state.comments.length;
      triggerSilentCheckpoint();
    }
  }

  function triggerSilentCheckpoint() {
    if (!state.autoBackupEnabled) return;
    if (state.comments.length === 0) return;
    const filename = `backup_segurança_${state.currentSession?.id || "live"}_${state.comments.length}coment.csv`;
    sendDownload(buildCSV(state.comments), "text/csv;charset=utf-8", filename);
  }

  // ----------------------------------------------------------------
  // 5. Gestão de Sessões (Soft Delete — NUNCA perde dados)
  // ----------------------------------------------------------------

  async function ensureActiveSession() {
    if (!window.LiveDB) return;
    try {
      let session = await window.LiveDB.getLatestActiveSession();
      if (!session) {
        session = await window.LiveDB.createSession();
      }
      state.currentSession = session;

      // Restaura comentários existentes dessa sessão
      const loaded = await window.LiveDB.getSessionComments(session.id);
      state.comments = loaded;
      state.seenPks.clear();
      state.recentCapturedMap.clear();
      loaded.forEach((c) => {
        if (c.pk) state.seenPks.add(String(c.pk));
      });
      state.lastCheckpointCount = loaded.length;
    } catch (e) {
      console.error("[IG Live] Erro ao carregar sessão:", e);
    }
  }

  async function onNewSession() {
    const totalCurrent = state.comments.length;
    const ok = window.confirm(
      `Deseja arquivar a sessão atual (${totalCurrent} comentários) e iniciar uma Nova Sessão?\n\n` +
      `✓ Seus comentários atuais continuarão 100% SALVOS no "Histórico".\n` +
      `✓ O contador da tela voltará a zero para você iniciar um novo momento.\n` +
      `✓ NENHUM dado será apagado do banco de dados.`
    );
    if (!ok) return;

    if (state.currentSession && window.LiveDB) {
      await window.LiveDB.endSession(state.currentSession.id);
      const newSession = await window.LiveDB.createSession();
      state.currentSession = newSession;
    }

    state.comments = [];
    state.seenPks.clear();
    state.recentCapturedMap.clear();
    state.lastCheckpointCount = 0;

    updateCounterAndPreview();
    updateStatusBadge();
    alert("Nova sessão iniciada! A anterior está arquivada no Histórico.");
  }

  // ----------------------------------------------------------------
  // 6. Exportação (CSV, HTML, JSON)
  // ----------------------------------------------------------------

  function buildCSV(comments) {
    const header = ["captured_time", "captured_at", "user", "comment", "source"];
    const escape = (val) => '"' + String(val || "").replace(/"/g, '""') + '"';
    const lines = [header.map(escape).join(",")];
    comments.forEach((c) => {
      lines.push([c.captured_time, c.captured_at, c.user, c.comment, c.source || "REST"].map(escape).join(","));
    });
    return "\uFEFF" + lines.join("\r\n");
  }

  function buildHTMLReport(comments, sessionTitle) {
    const total = comments.length;
    const uniqueUsers = new Set(comments.map((c) => c.user));
    const keywordCounts = {};
    PURCHASE_KEYWORDS.forEach((k) => (keywordCounts[k] = 0));

    const userCounts = {};
    const buyerUsers = new Set();

    comments.forEach((c) => {
      const u = c.user || "";
      userCounts[u] = (userCounts[u] || 0) + 1;
      const lower = (c.comment || "").toLowerCase();
      let hasPurchase = false;
      PURCHASE_KEYWORDS.forEach((k) => {
        if (lower.includes(k)) {
          keywordCounts[k]++;
          hasPurchase = true;
        }
      });
      if (hasPurchase && u) {
        buyerUsers.add(u);
      }
    });

    const sortedUsers = Object.keys(userCounts).sort((a, b) => userCounts[b] - userCounts[a]);
    const userOptions = sortedUsers
      .map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u)} (${userCounts[u]})</option>`)
      .join("");

    function escapeHtml(str) {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function highlight(text) {
      let escaped = escapeHtml(text);
      PURCHASE_KEYWORDS.forEach((k) => {
        const re = new RegExp("(" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
        escaped = escaped.replace(re, "<mark>$1</mark>");
      });
      return escaped;
    }

    const rows = comments
      .map(
        (c) => `
      <tr data-user="${escapeHtml((c.user || "").toLowerCase())}" data-comment="${escapeHtml((c.comment || "").toLowerCase())}">
        <td class="col-time">${escapeHtml(c.captured_time)}</td>
        <td class="col-user">
          <button type="button" class="user-pill" title="Filtrar comentários deste cliente" onclick="filterByUser('${escapeHtml(c.user)}')">
            ${escapeHtml(c.user)}
          </button>
        </td>
        <td class="col-comment">${highlight(c.comment)}</td>
        <td class="col-source"><span class="badge-${c.source === "REST" ? "rest" : "dom"}">${c.source || "REST"}</span></td>
      </tr>`
      )
      .join("");

    const keywordCards = PURCHASE_KEYWORDS.map(
      (k) => `
      <button type="button" class="kw-card" data-kw="${escapeHtml(k)}" title="Clique para filtrar apenas comentários com '${escapeHtml(k)}'">
        <div class="kw-count">${keywordCounts[k]}</div>
        <div class="kw-label">${escapeHtml(k)}</div>
      </button>`
    ).join("");

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(sessionTitle || "Relatório de Comentários")}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f4f6f8; margin:0; padding:28px; color:#1a1a1a; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px 0; color:#111; display:flex; align-items:center; gap:8px; }
  .meta { color:#666; font-size:13px; margin-bottom:20px; }
  .summary { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:24px; }
  .summary-card { background:#fff; border-radius:12px; padding:14px 20px; box-shadow:0 2px 5px rgba(0,0,0,.05); min-width:140px; border:1px solid #e1e4e8; }
  .summary-card .n { font-size:26px; font-weight:700; color:#0066cc; }
  .summary-card .l { font-size:12px; color:#666; text-transform:uppercase; margin-top:2px; font-weight:600; }
  
  .kw-section { margin-bottom:24px; }
  .kw-title { font-size:13px; font-weight:700; color:#444; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px; }
  .kw-grid { display:flex; gap:10px; flex-wrap:wrap; }
  .kw-card {
    background:#fff8e6; border:2px solid #ffe082; border-radius:10px; padding:10px 18px;
    text-align:center; min-width:90px; cursor:pointer; transition:all 0.15s ease;
    user-select:none; outline:none;
  }
  .kw-card:hover { transform:translateY(-2px); border-color:#f59e0b; box-shadow:0 4px 8px rgba(245,158,11,.15); }
  .kw-card.active { background:#fef3c7; border-color:#d97706; box-shadow:0 0 0 3px rgba(217,119,6,.25); }
  .kw-card .kw-count { font-size:20px; font-weight:800; color:#b78103; }
  .kw-card .kw-label { font-size:11px; color:#795548; text-transform:uppercase; font-weight:700; margin-top:2px; }

  /* Toolbar de Filtros */
  .controls-card { background:#fff; border-radius:12px; padding:16px 20px; box-shadow:0 2px 5px rgba(0,0,0,.05); border:1px solid #e1e4e8; margin-bottom:20px; }
  .controls-row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
  .search-wrap { flex:1; min-width:280px; position:relative; }
  .search-wrap input {
    width:100%; padding:10px 36px 10px 14px; border:1px solid #cbd5e1; border-radius:8px;
    font-size:14px; outline:none; transition:border 0.2s;
  }
  .search-wrap input:focus { border-color:#2563eb; box-shadow:0 0 0 3px rgba(37,99,235,.15); }
  .btn-clear {
    position:absolute; right:10px; top:50%; transform:translateY(-50%); background:none;
    border:none; color:#94a3b8; font-size:14px; cursor:pointer; display:none; padding:4px;
  }
  .btn-clear:hover { color:#475569; }

  .select-wrap { min-width:220px; }
  .select-wrap select {
    width:100%; padding:10px 12px; border:1px solid #cbd5e1; border-radius:8px;
    font-size:13px; outline:none; background:#fff; cursor:pointer;
  }
  .select-wrap select:focus { border-color:#2563eb; }

  .btn-action {
    padding:10px 16px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer;
    border:none; transition:all 0.15s ease; display:flex; align-items:center; gap:6px;
  }
  .btn-copy { background:#059669; color:#fff; }
  .btn-copy:hover { background:#047857; }
  .btn-reset { background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; }
  .btn-reset:hover { background:#e2e8f0; color:#1e293b; }

  .filter-status { margin-top:12px; font-size:12px; color:#64748b; display:flex; justify-content:space-between; align-items:center; }
  .filter-badge { background:#eff6ff; color:#1d4ed8; font-weight:600; padding:3px 8px; border-radius:6px; border:1px solid #bfdbfe; font-size:11px; }

  /* Tabela */
  .table-card { background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 5px rgba(0,0,0,.05); border:1px solid #e1e4e8; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; padding:12px 16px; border-bottom:1px solid #edf0f2; font-size:13px; vertical-align:middle; }
  th { background:#f8fafc; font-size:11px; text-transform:uppercase; color:#64748b; font-weight:700; letter-spacing:0.5px; }
  
  .th-user-filter, .th-comment-filter { display:flex; align-items:center; gap:8px; }
  .th-label { font-size:11px; font-weight:800; color:#475569; letter-spacing:0.5px; white-space:nowrap; }
  .th-select {
    flex:1; min-width:160px; padding:6px 10px; font-size:12px; font-weight:700;
    color:#0369a1; background:#f0f9ff; border:1.5px solid #0284c7; border-radius:6px;
    outline:none; cursor:pointer;
  }
  .th-select:focus { box-shadow:0 0 0 3px rgba(2,132,199,0.25); }
  .th-input {
    flex:1; max-width:300px; padding:6px 10px; font-size:12px; color:#1e293b;
    background:#fff; border:1px solid #cbd5e1; border-radius:6px; outline:none;
  }
  .th-input:focus { border-color:#0284c7; }

  mark { background:#ffe58f; padding:2px 4px; border-radius:3px; font-weight:600; }
  .badge-rest { background:#e0f2fe; color:#0369a1; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; }
  .badge-dom { background:#f3e8ff; color:#7e22ce; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; }
  tr:hover td { background:#f8fafc; }

  .user-pill {
    background:none; border:none; padding:4px 8px; border-radius:6px; font-size:13px;
    font-weight:700; color:#0284c7; cursor:pointer; text-align:left; transition:all 0.15s ease;
  }
  .user-pill:hover { background:#e0f2fe; color:#0369a1; text-decoration:underline; }

  .toast {
    position:fixed; bottom:24px; right:24px; background:#1e293b; color:#fff;
    padding:12px 20px; border-radius:8px; font-size:13px; font-weight:600;
    box-shadow:0 4px 12px rgba(0,0,0,.2); opacity:0; transition:opacity 0.2s;
    pointer-events:none; z-index:9999;
  }
  .toast.show { opacity:1; }
</style>
</head>
<body>
  <div class="container">
    <h1>⚡ ${escapeHtml(sessionTitle || "Relatório de Comentários")}</h1>
    <div class="meta">Gerado em ${new Date().toLocaleString("pt-BR")} · ${total} comentários capturados · ${uniqueUsers.size} clientes únicos</div>

    <div class="summary">
      <div class="summary-card"><div class="n">${total}</div><div class="l">Total de Comentários</div></div>
      <div class="summary-card"><div class="n">${uniqueUsers.size}</div><div class="l">Clientes Únicos</div></div>
      <div class="summary-card"><div class="n" style="color:#059669;">${buyerUsers.size}</div><div class="l">Clientes c/ Intenção de Compra</div></div>
    </div>

    <div class="kw-section">
      <div class="kw-title">🏷️ Filtrar por Termos de Compra (clique para filtrar na hora):</div>
      <div class="kw-grid">${keywordCards}</div>
    </div>

    <div class="controls-card">
      <div class="controls-row">
        <div class="search-wrap">
          <input type="text" id="searchInput" placeholder="🔍 Buscar por @usuário, produto, tamanho ou palavra..." autocomplete="off">
          <button type="button" id="btnClearSearch" class="btn-clear">✕</button>
        </div>
        <div class="select-wrap">
          <select id="userSelect">
            <option value="">👤 Todos os Usuários (${uniqueUsers.size})</option>
            ${userOptions}
          </select>
        </div>
        <button type="button" id="btnCopyBuyers" class="btn-action btn-copy">
          📋 Copiar @ Compradores (${buyerUsers.size})
        </button>
        <button type="button" id="btnResetFilters" class="btn-action btn-reset">
          🔄 Limpar Filtros
        </button>
      </div>
      <div class="filter-status">
        <span>Mostrando <strong id="shownCount">${total}</strong> de <strong>${total}</strong> comentários</span>
        <span id="activeFilterBadge" class="filter-badge" style="display:none;"></span>
      </div>
    </div>

    <div class="table-card">
      <table>
        <thead>
          <tr>
            <th style="width: 100px;">HORÁRIO</th>
            <th style="width: 280px;">
              <div class="th-user-filter">
                <span class="th-label">USUÁRIO</span>
                <select id="thUserSelect" class="th-select" title="Filtrar por usuário específico">
                  <option value="">👤 Filtrar Usuário (${uniqueUsers.size}) ▼</option>
                  ${userOptions}
                </select>
              </div>
            </th>
            <th>
              <div class="th-comment-filter">
                <span class="th-label">COMENTÁRIO</span>
                <input type="text" id="thCommentInput" class="th-input" placeholder="🔍 Filtrar palavra..." autocomplete="off" />
              </div>
            </th>
            <th style="width: 90px;">ORIGEM</th>
          </tr>
        </thead>
        <tbody id="commentsBody">${rows}</tbody>
      </table>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    (function () {
      let activeKeyword = "";
      let activeUser = "";
      let searchQuery = "";

      const searchInput = document.getElementById("searchInput");
      const btnClearSearch = document.getElementById("btnClearSearch");
      const userSelect = document.getElementById("userSelect");
      const thUserSelect = document.getElementById("thUserSelect");
      const thCommentInput = document.getElementById("thCommentInput");
      const btnResetFilters = document.getElementById("btnResetFilters");
      const btnCopyBuyers = document.getElementById("btnCopyBuyers");
      const shownCount = document.getElementById("shownCount");
      const activeFilterBadge = document.getElementById("activeFilterBadge");
      const kwCards = document.querySelectorAll(".kw-card");
      const tableRows = document.querySelectorAll("#commentsBody tr");
      const toast = document.getElementById("toast");

      function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add("show");
        setTimeout(() => toast.classList.remove("show"), 2500);
      }

      function applyFilters() {
        let count = 0;
        const q = searchQuery.trim().toLowerCase();
        const u = activeUser.trim().toLowerCase();
        const kw = activeKeyword.trim().toLowerCase();

        tableRows.forEach((tr) => {
          const rowUser = tr.getAttribute("data-user") || "";
          const rowComment = tr.getAttribute("data-comment") || "";

          const matchUser = !u || rowUser === u;
          const matchKw = !kw || rowComment.includes(kw);
          const matchQuery = !q || rowUser.includes(q) || rowComment.includes(q);

          if (matchUser && matchKw && matchQuery) {
            tr.style.display = "";
            count++;
          } else {
            tr.style.display = "none";
          }
        });

        shownCount.textContent = count;

        const filters = [];
        if (activeKeyword) filters.push('Tag: "' + activeKeyword.toUpperCase() + '"');
        if (activeUser) filters.push('Cliente: ' + activeUser);
        if (searchQuery) filters.push('Busca: "' + searchQuery + '"');

        if (filters.length > 0) {
          activeFilterBadge.style.display = "inline-block";
          activeFilterBadge.textContent = "Filtros ativos: " + filters.join(" + ");
        } else {
          activeFilterBadge.style.display = "none";
        }
      }

      searchInput.addEventListener("input", (e) => {
        searchQuery = e.target.value;
        if (thCommentInput) thCommentInput.value = searchQuery;
        btnClearSearch.style.display = searchQuery ? "block" : "none";
        applyFilters();
      });

      if (thCommentInput) {
        thCommentInput.addEventListener("input", (e) => {
          searchQuery = e.target.value;
          searchInput.value = searchQuery;
          btnClearSearch.style.display = searchQuery ? "block" : "none";
          applyFilters();
        });
      }

      btnClearSearch.addEventListener("click", () => {
        searchInput.value = "";
        if (thCommentInput) thCommentInput.value = "";
        searchQuery = "";
        btnClearSearch.style.display = "none";
        applyFilters();
      });

      userSelect.addEventListener("change", (e) => {
        activeUser = e.target.value;
        if (thUserSelect) thUserSelect.value = activeUser;
        applyFilters();
      });

      if (thUserSelect) {
        thUserSelect.addEventListener("change", (e) => {
          activeUser = e.target.value;
          userSelect.value = activeUser;
          applyFilters();
        });
      }

      window.filterByUser = function (user) {
        activeUser = user;
        userSelect.value = user;
        if (thUserSelect) thUserSelect.value = user;
        applyFilters();
        thUserSelect.scrollIntoView({ behavior: "smooth", block: "center" });
      };

      kwCards.forEach((card) => {
        card.addEventListener("click", () => {
          const kw = card.getAttribute("data-kw");
          if (activeKeyword === kw) {
            activeKeyword = "";
            card.classList.remove("active");
          } else {
            kwCards.forEach((c) => c.classList.remove("active"));
            activeKeyword = kw;
            card.classList.add("active");
          }
          applyFilters();
        });
      });

      btnResetFilters.addEventListener("click", () => {
        activeKeyword = "";
        activeUser = "";
        searchQuery = "";
        searchInput.value = "";
        if (thCommentInput) thCommentInput.value = "";
        btnClearSearch.style.display = "none";
        userSelect.value = "";
        if (thUserSelect) thUserSelect.value = "";
        kwCards.forEach((c) => c.classList.remove("active"));
        applyFilters();
      });

      const buyersList = ${JSON.stringify(Array.from(buyerUsers))};
      btnCopyBuyers.addEventListener("click", () => {
        if (buyersList.length === 0) {
          alert("Nenhum cliente com termos de compra detectado nesta sessão.");
          return;
        }
        const text = buyersList.join(", ");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            showToast("✅ " + buyersList.length + " compradores copiados para a área de transferência!");
          }).catch(() => {
            prompt("Copie os @ dos compradores abaixo:", text);
          });
        } else {
          prompt("Copie os @ dos compradores abaixo:", text);
        }
      });
    })();
  </script>
</body>
</html>`;
  }

  function sendDownload(content, mimeType, filename) {
    if (typeof chrome !== "undefined" && chrome.runtime?.id) {
      try {
        chrome.runtime.sendMessage(
          { type: "IG_LIVE_DOWNLOAD", content, mimeType, filename },
          (res) => {
            if (chrome.runtime.lastError || (res && !res.ok)) {
              fallbackDownload(content, mimeType, filename);
            }
          }
        );
        return;
      } catch (e) {}
    }
    fallbackDownload(content, mimeType, filename);
  }

  function fallbackDownload(content, mimeType, filename) {
    try {
      const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 8000);
    } catch (err) {
      console.error("[IG Live] Falha no download:", err);
    }
  }

  // ----------------------------------------------------------------
  // 7. Interface Flutuante com Modal de Histórico
  // ----------------------------------------------------------------

  function checkLiveContext() {
    if (location.pathname.includes("/live") || location.search.includes("live")) return true;
    const hasLiveBadge = !!document.querySelector('[aria-label*="ao vivo" i], [aria-label*="live" i]');
    const hasVideo = !!document.querySelector("video");
    const hasResponder = Array.from(document.querySelectorAll('button, [role="button"], span')).some(
      (el) => el.children.length === 0 && (el.textContent || "").trim().toLowerCase() === "responder"
    );
    return (hasVideo && hasLiveBadge) || hasResponder;
  }

  function updateStatusBadge() {
    if (!panelEls.statusBadge || !panelEls.btnTogglePower) return;

    const inLive = checkLiveContext();
    if (panelEls.liveContextBadge) {
      if (inLive) {
        panelEls.liveContextBadge.textContent = "🔴 Live Detectada";
        panelEls.liveContextBadge.className = "ig-lc-ctx-badge ig-lc-ctx-live";
      } else {
        panelEls.liveContextBadge.textContent = "⚪ Fora de Live";
        panelEls.liveContextBadge.className = "ig-lc-ctx-badge ig-lc-ctx-normal";
      }
    }

    if (state.status === "recording") {
      panelEls.statusBadge.textContent = "● GRAVANDO";
      panelEls.statusBadge.className = "ig-lc-status recording";
      panelEls.btnTogglePower.textContent = "⏹ DESLIGAR CAPTURA";
      panelEls.btnTogglePower.className = "ig-lc-btn-power is-on";
    } else {
      panelEls.statusBadge.textContent = "⏸ DESLIGADO";
      panelEls.statusBadge.className = "ig-lc-status paused";
      panelEls.btnTogglePower.textContent = "▶ LIGAR CAPTURA";
      panelEls.btnTogglePower.className = "ig-lc-btn-power is-off";
    }
  }

  function updateCounterAndPreview(lastEntry) {
    if (!panelEls.counter) return;
    panelEls.counter.textContent = `${state.comments.length} comentário(s) capturado(s)`;

    const entry = lastEntry || state.comments[state.comments.length - 1];
    if (entry && entry.user) {
      panelEls.preview.textContent = `${entry.user}: ${entry.comment}`;
      panelEls.preview.title = `${entry.captured_time} — ${entry.user}: ${entry.comment} (${entry.source || "REST"})`;
    } else {
      panelEls.preview.textContent =
        state.status === "recording"
          ? "Aguardando novos comentários..."
          : "Captura desligada. Clique em 'Ligar Captura' para iniciar.";
    }
  }

  function onTogglePower() {
    if (state.status === "recording") {
      state.status = "paused";
      stopScanning();
    } else {
      state.status = "recording";
      startScanning();
    }
    updateStatusBadge();
    updateCounterAndPreview();
  }

  function startScanning() {
    if (unrecordedRestBuffer.length > 0) {
      const buffered = unrecordedRestBuffer.splice(0, unrecordedRestBuffer.length);
      ingestRestComments(buffered);
    }
    scanDomForComments();
    if (!domObserver) {
      domObserver = new MutationObserver(() => scanDomForComments());
      domObserver.observe(document.body, { childList: true, subtree: true });
    }
    if (!domInterval) {
      domInterval = setInterval(scanDomForComments, CONFIG.DOM_SCAN_INTERVAL_MS);
    }
    if (!checkpointTimer) {
      checkpointTimer = setInterval(triggerSilentCheckpoint, CONFIG.AUTO_CHECKPOINT_MINUTES * 60 * 1000);
    }
  }

  function stopScanning() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (domInterval) {
      clearInterval(domInterval);
      domInterval = null;
    }
    if (checkpointTimer) {
      clearInterval(checkpointTimer);
      checkpointTimer = null;
    }
  }

  function makeDraggable(panel, handle) {
    let isDown = false;
    let startX = 0, startY = 0, startRight = 0, startTop = 0;
    handle.addEventListener("mousedown", (e) => {
      isDown = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startTop = rect.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.right = `${Math.max(10, startRight - dx)}px`;
      panel.style.top = `${Math.max(10, startTop + dy)}px`;
    });
    document.addEventListener("mouseup", () => {
      isDown = false;
    });
  }

  // Modal de Histórico de Sessões
  async function openHistoryModal() {
    if (!window.LiveDB) return;
    const sessions = await window.LiveDB.getAllSessions();
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    let existingModal = document.getElementById("ig-lc-history-modal");
    if (existingModal) existingModal.remove();

    const modal = document.createElement("div");
    modal.id = "ig-lc-history-modal";
    modal.innerHTML = `
      <div class="ig-lc-modal-backdrop"></div>
      <div class="ig-lc-modal-card">
        <div class="ig-lc-modal-header">
          <h4>📦 Histórico de Lives Anteriores</h4>
          <button type="button" class="ig-lc-modal-close">✕</button>
        </div>
        <div class="ig-lc-modal-desc">
          Seus dados nunca são perdidos! Todas as lives gravadas neste computador ficam salvas abaixo:
        </div>
        <div class="ig-lc-modal-list">
          ${
            sessions.length === 0
              ? '<div class="ig-lc-empty">Nenhuma sessão gravada ainda.</div>'
              : sessions
                  .map(
                    (s) => `
            <div class="ig-lc-session-row" data-id="${s.id}">
              <div class="ig-lc-session-info">
                <strong>${s.title}</strong>
                <span>${new Date(s.startedAt).toLocaleString("pt-BR")} · ${s.commentCount || 0} comentários</span>
              </div>
              <div class="ig-lc-session-actions">
                <button type="button" class="ig-lc-sbtn ig-lc-sbtn-csv" data-id="${s.id}">⬇ CSV</button>
                <button type="button" class="ig-lc-sbtn ig-lc-sbtn-html" data-id="${s.id}">⬇ HTML</button>
              </div>
            </div>`
                  )
                  .join("")
          }
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector(".ig-lc-modal-close").addEventListener("click", () => modal.remove());
    modal.querySelector(".ig-lc-modal-backdrop").addEventListener("click", () => modal.remove());

    modal.querySelectorAll(".ig-lc-sbtn-csv").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sId = btn.getAttribute("data-id");
        const list = await window.LiveDB.getSessionComments(sId);
        sendDownload(buildCSV(list), "text/csv;charset=utf-8", `live_${sId}.csv`);
      });
    });

    modal.querySelectorAll(".ig-lc-sbtn-html").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sId = btn.getAttribute("data-id");
        const session = sessions.find((s) => s.id === sId);
        const list = await window.LiveDB.getSessionComments(sId);
        sendDownload(buildHTMLReport(list, session?.title), "text/html;charset=utf-8", `relatorio_${sId}.html`);
      });
    });
  }

  function buildPanel() {
    if (document.getElementById("ig-live-capture-panel")) return;

    const panel = document.createElement("div");
    panel.id = "ig-live-capture-panel";

    const header = document.createElement("div");
    header.className = "ig-lc-header";

    const title = document.createElement("span");
    title.className = "ig-lc-title";
    title.textContent = "IG Live Pro ⚡";

    const headerRight = document.createElement("div");
    headerRight.className = "ig-lc-header-right";

    const liveContextBadge = document.createElement("span");
    liveContextBadge.className = "ig-lc-ctx-badge";

    const statusBadge = document.createElement("span");
    statusBadge.className = "ig-lc-status";

    const btnMin = document.createElement("button");
    btnMin.type = "button";
    btnMin.className = "ig-lc-min-btn";
    btnMin.title = "Minimizar / Expandir";
    btnMin.textContent = "—";
    btnMin.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("minimized");
      btnMin.textContent = panel.classList.contains("minimized") ? "+" : "—";
    });

    const btnClose = document.createElement("button");
    btnClose.type = "button";
    btnClose.className = "ig-lc-close-btn";
    btnClose.title = "Fechar painel na tela";
    btnClose.textContent = "✕";
    btnClose.addEventListener("click", (e) => {
      e.stopPropagation();
      hidePanel();
    });

    headerRight.append(liveContextBadge, statusBadge, btnMin, btnClose);
    header.append(title, headerRight);

    const body = document.createElement("div");
    body.className = "ig-lc-body";

    const btnTogglePower = document.createElement("button");
    btnTogglePower.type = "button";
    btnTogglePower.className = "ig-lc-btn-power is-off";
    btnTogglePower.textContent = "▶ LIGAR CAPTURA";
    btnTogglePower.addEventListener("click", onTogglePower);

    const counter = document.createElement("div");
    counter.className = "ig-lc-counter";
    counter.textContent = "0 comentário(s) capturado(s)";

    const preview = document.createElement("div");
    preview.className = "ig-lc-preview";
    preview.textContent = "Captura desligada. Clique em 'Ligar Captura' para iniciar.";

    const rowExport = document.createElement("div");
    rowExport.className = "ig-lc-btnrow";

    const btnCsv = document.createElement("button");
    btnCsv.className = "ig-lc-btn";
    btnCsv.textContent = "⬇ CSV";
    btnCsv.addEventListener("click", () => {
      if (state.comments.length === 0) return alert("Nenhum comentário na sessão atual.");
      sendDownload(buildCSV(state.comments), "text/csv;charset=utf-8", `ig_live_${Date.now()}.csv`);
    });

    const btnHtml = document.createElement("button");
    btnHtml.className = "ig-lc-btn";
    btnHtml.textContent = "⬇ Relatório";
    btnHtml.addEventListener("click", () => {
      if (state.comments.length === 0) return alert("Nenhum comentário na sessão atual.");
      sendDownload(buildHTMLReport(state.comments, state.currentSession?.title), "text/html;charset=utf-8", `relatorio_live_${Date.now()}.html`);
    });

    const btnHistory = document.createElement("button");
    btnHistory.className = "ig-lc-btn ig-lc-btn-accent";
    btnHistory.textContent = "📦 Histórico";
    btnHistory.title = "Acessar backups de lives anteriores";
    btnHistory.addEventListener("click", openHistoryModal);

    rowExport.append(btnCsv, btnHtml, btnHistory);

    const rowActions = document.createElement("div");
    rowActions.className = "ig-lc-btnrow";

    const btnNewSession = document.createElement("button");
    btnNewSession.className = "ig-lc-btn ig-lc-btn-secondary";
    btnNewSession.textContent = "🔄 Nova Sessão (Limpar)";
    btnNewSession.title = "Arquiva os dados atuais no histórico e inicia uma nova contagem segura";
    btnNewSession.addEventListener("click", onNewSession);

    rowActions.append(btnNewSession);

    body.append(btnTogglePower, counter, preview, rowExport, rowActions);
    panel.append(header, body);
    document.documentElement.appendChild(panel);

    makeDraggable(panel, header);

    panelEls.panel = panel;
    panelEls.liveContextBadge = liveContextBadge;
    panelEls.statusBadge = statusBadge;
    panelEls.btnTogglePower = btnTogglePower;
    panelEls.counter = counter;
    panelEls.preview = preview;
  }

  function showPanel() {
    if (!panelEls.panel) buildPanel();
    if (panelEls.panel) {
      panelEls.panel.style.display = "block";
    }
  }

  function hidePanel() {
    if (panelEls.panel) {
      panelEls.panel.style.display = "none";
    }
  }

  function togglePanel() {
    if (!panelEls.panel) {
      buildPanel();
      showPanel();
      return true;
    }
    if (panelEls.panel.style.display === "none") {
      showPanel();
      return true;
    } else {
      hidePanel();
      return false;
    }
  }

  // ----------------------------------------------------------------
  // 8. Mensagens do Popup (Barra do Chrome)
  // ----------------------------------------------------------------

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req.type === "GET_STATE") {
        sendResponse({
          status: state.status,
          totalComments: state.comments.length,
          isLive: checkLiveContext(),
          panelVisible: panelEls.panel ? panelEls.panel.style.display !== "none" : false,
        });
      } else if (req.type === "TOGGLE_PANEL") {
        const isVis = togglePanel();
        sendResponse({ panelVisible: isVis });
      } else if (req.type === "SHOW_PANEL") {
        showPanel();
        sendResponse({ panelVisible: true });
      } else if (req.type === "HIDE_PANEL") {
        hidePanel();
        sendResponse({ panelVisible: false });
      } else if (req.type === "TOGGLE_POWER") {
        onTogglePower();
        sendResponse({
          status: state.status,
          totalComments: state.comments.length,
        });
      } else if (req.type === "DOWNLOAD_CSV") {
        if (state.comments.length > 0) {
          sendDownload(buildCSV(state.comments), "text/csv;charset=utf-8", `ig_live_${Date.now()}.csv`);
        }
        sendResponse({ ok: true });
      } else if (req.type === "DOWNLOAD_HTML") {
        if (state.comments.length > 0) {
          sendDownload(buildHTMLReport(state.comments, state.currentSession?.title), "text/html;charset=utf-8", `relatorio_live_${Date.now()}.html`);
        }
        sendResponse({ ok: true });
      } else if (req.type === "RESET") {
        onNewSession();
        sendResponse({ ok: true });
      } else if (req.type === "SET_AUTO_OPEN_IG") {
        if (req.value) {
          showPanel();
        }
        sendResponse({ ok: true });
      } else if (req.type === "SET_AUTO_BACKUP") {
        state.autoBackupEnabled = !!req.value;
        sendResponse({ ok: true });
      }
      return true;
    });
  }

  // ----------------------------------------------------------------
  // 9. Inicialização Geral
  // ----------------------------------------------------------------

  async function init() {
    activateTabKeepAlive();
    await ensureActiveSession();
    buildPanel();
    updateStatusBadge();
    updateCounterAndPreview();

    // Por padrão o painel flutuante fica OCULTO, a menos que a preferência autoOpenOnInstagram esteja ativa
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get(["autoOpenOnInstagram", "autoBackupEnabled"], (res) => {
        if (res) {
          if (res.autoOpenOnInstagram === true) {
            showPanel();
          } else {
            hidePanel();
          }
          if (typeof res.autoBackupEnabled === "boolean") {
            state.autoBackupEnabled = res.autoBackupEnabled;
          }
        }
      });
    } else {
      hidePanel();
    }

    setInterval(updateStatusBadge, 2000);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init);
  }
})();
