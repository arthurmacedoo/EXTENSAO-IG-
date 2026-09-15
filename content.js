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
    "seguindo", "following", "editar perfil", "edit profile"
  ]);

  const PURCHASE_KEYWORDS = ["quero", "reserva", "separa", "tamanho", "pix", "valor", "preço", "comprar", "leva"];

  const state = {
    status: "paused",
    currentSession: null,
    comments: [], // Cache em memória da sessão atual
    seenPks: new Set(),
    seenFingerprints: new Set(),
    lastCheckpointCount: 0,
  };

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

    if (event.data.type === "REST_COMMENTS" && state.status === "recording") {
      const incoming = event.data.comments || [];
      ingestRestComments(incoming);
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

      const fp = `${username.toLowerCase()}::${text}`;
      if (state.seenFingerprints.has(fp)) continue;

      if (pk) state.seenPks.add(pk);
      state.seenFingerprints.add(fp);

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

  function scanDomForComments() {
    if (state.status !== "recording") return;

    // Busca botões ou nós "Responder"
    const leaves = document.querySelectorAll('button, [role="button"], span, div');
    const responderEls = [];
    for (let i = 0; i < leaves.length; i++) {
      const el = leaves[i];
      if (el.children.length > 0) continue;
      const t = (el.textContent || "").trim().toLowerCase();
      if (t === "responder" || t === "reply") {
        responderEls.push(el);
      }
    }

    for (const respEl of responderEls) {
      let row = respEl.parentElement;
      for (let depth = 0; depth < 5 && row && row !== document.body; depth++) {
        if (row.id === "ig-live-capture-panel") break;
        const fullText = (row.innerText || row.textContent || "").trim();
        if (fullText.length > 5 && fullText.length < 600) {
          const nested = row.querySelectorAll('button, [role="button"], span, div');
          let respCount = 0;
          for (let k = 0; k < nested.length; k++) {
            if (nested[k].children.length === 0) {
              const ct = (nested[k].textContent || "").trim().toLowerCase();
              if (ct === "responder" || ct === "reply") respCount++;
            }
          }
          if (respCount === 1) {
            processDomRow(row);
            break;
          }
        }
        row = row.parentElement;
      }
    }
  }

  async function processDomRow(row) {
    let username = null;
    const img = row.querySelector("img");
    if (img && img.alt) {
      username = extractUserFromAlt(img.alt);
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
    clone.querySelectorAll('button, [role="button"], svg').forEach((b) => b.remove());
    clone.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        const t = (el.textContent || "").trim().toLowerCase();
        if (ACTION_WORDS.has(t)) el.remove();
      }
    });

    let rawText = (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
    if (!rawText) return;

    let commentText = "";
    if (username) {
      const userRegex = new RegExp("^@?" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[:\\s-]*", "i");
      commentText = rawText.replace(userRegex, "").trim();
    } else {
      const parts = rawText.split(/\s+/);
      if (parts.length >= 2) {
        username = parts[0].replace(/^@/, "").replace(/[:]$/, "").trim();
        commentText = parts.slice(1).join(" ").trim();
      }
    }

    if (!username || !commentText) return;
    for (const act of ACTION_WORDS) {
      const actRegex = new RegExp("\\s*" + act + "$", "i");
      commentText = commentText.replace(actRegex, "").trim();
    }
    if (!commentText) return;

    const fp = `${username.toLowerCase()}::${commentText}`;
    if (state.seenFingerprints.has(fp)) return; // Já capturado por REST ou DOM
    state.seenFingerprints.add(fp);

    const now = new Date();
    const entry = {
      id: `${state.currentSession?.id || "default"}_dom_${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`,
      sessionId: state.currentSession?.id || "default",
      pk: null,
      user: "@" + username.replace(/^@/, ""),
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
    if (state.comments.length - state.lastCheckpointCount >= CONFIG.AUTO_CHECKPOINT_COUNT) {
      state.lastCheckpointCount = state.comments.length;
      triggerSilentCheckpoint();
    }
  }

  function triggerSilentCheckpoint() {
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
      state.seenFingerprints.clear();
      loaded.forEach((c) => {
        if (c.pk) state.seenPks.add(String(c.pk));
        state.seenFingerprints.add(`${c.user.toLowerCase().replace(/^@/, "")}::${c.comment}`);
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
    state.seenFingerprints.clear();
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
    comments.forEach((c) => {
      const lower = (c.comment || "").toLowerCase();
      PURCHASE_KEYWORDS.forEach((k) => {
        if (lower.includes(k)) keywordCounts[k]++;
      });
    });

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
      <tr>
        <td>${escapeHtml(c.captured_time)}</td>
        <td><strong>${escapeHtml(c.user)}</strong></td>
        <td>${highlight(c.comment)}</td>
        <td><span class="badge-${c.source === "REST" ? "rest" : "dom"}">${c.source || "REST"}</span></td>
      </tr>`
      )
      .join("");

    const keywordCards = PURCHASE_KEYWORDS.map(
      (k) => `
      <div class="kw-card">
        <div class="kw-count">${keywordCounts[k]}</div>
        <div class="kw-label">${escapeHtml(k)}</div>
      </div>`
    ).join("");

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(sessionTitle || "Relatório de Comentários")}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f4f6f8; margin:0; padding:28px; color:#1a1a1a; }
  h1 { font-size: 22px; margin-bottom: 4px; color:#111; }
  .meta { color:#666; font-size:13px; margin-bottom:20px; }
  .summary { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:24px; }
  .summary-card { background:#fff; border-radius:10px; padding:14px 20px; box-shadow:0 2px 4px rgba(0,0,0,.06); min-width:130px; border:1px solid #e1e4e8; }
  .summary-card .n { font-size:24px; font-weight:700; color:#0066cc; }
  .summary-card .l { font-size:12px; color:#666; text-transform:uppercase; margin-top:2px; }
  .kw-section { margin-bottom:24px; }
  .kw-grid { display:flex; gap:10px; flex-wrap:wrap; }
  .kw-card { background:#fff8e6; border:1px solid #ffe082; border-radius:8px; padding:8px 16px; text-align:center; min-width:80px; }
  .kw-count { font-size:18px; font-weight:700; color:#b78103; }
  .kw-label { font-size:11px; color:#795548; text-transform:uppercase; font-weight:600; }
  table { width:100%; border-collapse: collapse; background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 2px 4px rgba(0,0,0,.06); border:1px solid #e1e4e8; }
  th, td { text-align:left; padding:10px 14px; border-bottom:1px solid #edf0f2; font-size:13px; vertical-align:middle; }
  th { background:#fafbfc; font-size:12px; text-transform:uppercase; color:#586069; font-weight:600; }
  mark { background:#ffe58f; padding:1px 4px; border-radius:3px; }
  .badge-rest { background:#e3f2fd; color:#0d47a1; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; }
  .badge-dom { background:#f3e5f5; color:#4a148c; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; }
  tr:hover td { background:#fbfcfe; }
</style>
</head>
<body>
  <h1>${escapeHtml(sessionTitle || "Relatório de Comentários")}</h1>
  <div class="meta">Gerado em ${new Date().toLocaleString("pt-BR")} · ${total} comentários · ${uniqueUsers.size} clientes únicos</div>

  <div class="summary">
    <div class="summary-card"><div class="n">${total}</div><div class="l">Comentários</div></div>
    <div class="summary-card"><div class="n">${uniqueUsers.size}</div><div class="l">Clientes únicos</div></div>
  </div>

  <div class="kw-section">
    <div class="meta">Contagem de Termos de Compra:</div>
    <div class="kw-grid">${keywordCards}</div>
  </div>

  <table>
    <thead><tr><th>Horário</th><th>Usuário</th><th>Comentário</th><th>Origem</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
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

    headerRight.append(liveContextBadge, statusBadge, btnMin);
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
        });
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
      } else if (req.type === "RESET") {
        onNewSession();
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

    setInterval(updateStatusBadge, 2000);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init);
  }
})();
