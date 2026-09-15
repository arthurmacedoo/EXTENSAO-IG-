/**
 * content.js — IG Live: Captura de Comentários
 * ---------------------------------------------------------------------
 * Versão 1.2.0:
 * - Suporte nativo ao layout real da Live do Instagram (captura por botão "Responder" e avatar).
 * - Extração precisa do @username (via alt da foto de perfil ou nó de texto) e do comentário limpo.
 * - Varredura em tempo real por MutationObserver + Intervalo de segurança (1s).
 * - Captura imediata dos comentários que já estão na tela ao clicar em "Ligar Captura".
 * - Preservação de emojis nos comentários.
 * - Inicia sempre DESLIGADO para proteção do usuário.
 * ---------------------------------------------------------------------
 */

(function () {
  "use strict";

  const STORAGE_KEY = "igLiveCapture_v1";

  const CONFIG = {
    AUTO_BACKUP_INTERVAL_MS: 10 * 60 * 1000, // 10 minutos
    PERSIST_DEBOUNCE_MS: 300,
    SCAN_INTERVAL_MS: 1000, // Polling a cada 1 segundo para garantir que nenhum comentário escape
  };

  const IGNORED_ROUTES = new Set([
    "explore", "reels", "stories", "direct", "accounts", "legal", "about",
    "developer", "api", "emails", "challenge", "disclaimer", "directory",
    "session", "tv", "p", "ads", "privacy", "terms", "safety", "creators",
    "business", "help", "settings", "loginhelp", "accountscenter",
    "nametag", "live", "reel", "stories_archive", "web",
  ]);

  const ACTION_WORDS = new Set([
    "responder", "curtir", "reply", "like", "ver tradução", "see translation",
    "traduzir", "translate", "ver mais", "see more", "mostrar mais", "seguir", "follow",
    "seguindo", "following", "editar perfil", "edit profile"
  ]);

  const PURCHASE_KEYWORDS = ["quero", "reserva", "separa", "tamanho", "pix", "valor", "preço", "comprar"];

  /** @type {{status:'recording'|'paused', comments: Array<{captured_time:string, captured_at:string, user:string, comment:string, timestampMs?:number}>}} */
  let state = { status: "paused", comments: [] };

  let observer = null;
  let liveScanInterval = null;
  let autoBackupTimer = null;
  let saveTimer = null;
  const panelEls = {};

  // ----------------------------------------------------------------
  // Validações e Contexto
  // ----------------------------------------------------------------

  function isExtensionValid() {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  }

  function isLiveUrl() {
    return location.pathname.includes("/live") || location.search.includes("live");
  }

  function checkLiveContext() {
    if (isLiveUrl()) return true;
    const hasLiveBadge = !!document.querySelector('[aria-label*="ao vivo" i], [aria-label*="live" i]');
    const hasVideo = !!document.querySelector("video");
    const hasResponder = Array.from(document.querySelectorAll('button, [role="button"], span')).some(
      el => el.children.length === 0 && (el.textContent || "").trim().toLowerCase() === "responder"
    );
    return (hasVideo && hasLiveBadge) || hasResponder;
  }

  // ----------------------------------------------------------------
  // Extração de Dados do DOM da Live do Instagram
  // ----------------------------------------------------------------

  function extractUserFromAlt(alt) {
    if (!alt || typeof alt !== "string") return null;
    const s = alt.trim().replace(/\.$/, "");

    // Português: "Foto do perfil de lojaclosetcoletivo" ou "Foto de perfil de..."
    let m = s.match(/(?:foto\s+(?:do|de)\s+)?perfil\s+d[eoa]\s+([a-zA-Z0-9._]+)/i);
    if (m) return m[1];

    // Espanhol: "Foto del perfil de usuario"
    m = s.match(/(?:foto\s+del\s+)?perfil\s+de\s+([a-zA-Z0-9._]+)/i);
    if (m) return m[1];

    // Inglês: "username's profile picture"
    m = s.match(/^([a-zA-Z0-9._]+)['’]s\s+profile\s+(?:picture|photo)/i);
    if (m) return m[1];

    // "Profile picture of username"
    m = s.match(/profile\s+(?:picture|photo)\s+of\s+([a-zA-Z0-9._]+)/i);
    if (m) return m[1];

    // Nome direto no alt
    m = s.match(/^@?([a-zA-Z0-9._]{2,35})$/);
    if (m) return m[1];

    return null;
  }

  function processCommentRow(row) {
    if (!row || row.dataset.igCaptured === "true") return false;
    if (row.closest("#ig-live-capture-panel")) return false;

    // 1. Localiza avatar para extrair o usuário
    let username = null;
    const img = row.querySelector("img");
    if (img && img.alt) {
      username = extractUserFromAlt(img.alt);
    }

    // 2. Se não achou pelo alt, tenta achar em links internos da linha
    if (!username) {
      const anchor = row.querySelector("a[href]");
      if (anchor) {
        const href = anchor.getAttribute("href") || "";
        const m = href.match(/\/([a-zA-Z0-9._]+)\/?$/);
        if (m && !IGNORED_ROUTES.has(m[1].toLowerCase())) {
          username = m[1];
        }
      }
    }

    // 3. Clona o elemento para limpar e extrair o texto
    const clone = row.cloneNode(true);

    // Converte emojis em formato de imagem para texto
    clone.querySelectorAll("img").forEach((i) => {
      const alt = i.getAttribute("alt") || "";
      if (alt && !alt.toLowerCase().includes("perfil") && !alt.toLowerCase().includes("profile")) {
        i.replaceWith(document.createTextNode(alt));
      } else {
        i.remove();
      }
    });

    // Remove botões de ação e SVGs (ex: botão "Responder", corações, etc.)
    clone.querySelectorAll('button, [role="button"], svg').forEach((b) => b.remove());

    // Remove palavras de ação que estejam em nós filhos
    clone.querySelectorAll("*").forEach((el) => {
      if (el.children.length === 0) {
        const t = (el.textContent || "").trim().toLowerCase();
        if (ACTION_WORDS.has(t)) {
          el.remove();
        }
      }
    });

    let rawText = (clone.innerText || clone.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!rawText) return false;

    let commentText = "";

    if (username) {
      // Se já temos o username via alt ou link, remove ele do início do texto
      const userRegex = new RegExp(
        "^@?" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[:\\s-]*",
        "i"
      );
      commentText = rawText.replace(userRegex, "").trim();
    } else {
      // Caso não tenhamos o alt, a primeira palavra é quase sempre o nome do usuário no layout do IG
      const parts = rawText.split(/\s+/);
      if (parts.length >= 2) {
        username = parts[0].replace(/^@/, "").replace(/[:]$/, "").trim();
        commentText = parts.slice(1).join(" ").trim();
      }
    }

    if (!username || !commentText) return false;
    if (IGNORED_ROUTES.has(username.toLowerCase())) return false;

    // Limpa sobras de "responder" ou "reply" no final do texto
    for (const act of ACTION_WORDS) {
      const actRegex = new RegExp("\\s*" + act + "$", "i");
      commentText = commentText.replace(actRegex, "").trim();
    }

    if (!commentText) return false;

    // Marca o container físico para não processar duas vezes
    row.dataset.igCaptured = "true";

    registerComment(username, commentText);
    return true;
  }

  function scanLiveComments() {
    if (state.status !== "recording") return;

    // ESTRATÉGIA A: Localizar comentários pelo botão "Responder" / "Reply"
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
        if (row.dataset && row.dataset.igCaptured === "true") break;
        if (row.id === "ig-live-capture-panel") break;

        const fullText = (row.innerText || row.textContent || "").trim();
        if (fullText.length > 5 && fullText.length < 600) {
          // Garante que é uma única linha de comentário (não o chat inteiro agrupado)
          const nested = row.querySelectorAll('button, [role="button"], span, div');
          let respCount = 0;
          for (let k = 0; k < nested.length; k++) {
            if (nested[k].children.length === 0) {
              const ct = (nested[k].textContent || "").trim().toLowerCase();
              if (ct === "responder" || ct === "reply") respCount++;
            }
          }
          if (respCount === 1) {
            processCommentRow(row);
            break;
          }
        }
        row = row.parentElement;
      }
    }

    // ESTRATÉGIA B: Localizar comentários por avatares na área de chat
    const imgs = document.querySelectorAll('img[alt*="perfil" i], img[alt*="profile" i], img[alt*="foto" i]');
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (img.closest('#ig-live-capture-panel, header, [role="banner"]')) continue;

      let row = img.parentElement;
      for (let depth = 0; depth < 5 && row && row !== document.body; depth++) {
        if (row.dataset && row.dataset.igCaptured === "true") break;
        if (row.querySelector("header, video")) break;

        const text = (row.innerText || row.textContent || "").trim();
        if (text.length > 2 && text.length < 500) {
          const rowImgs = row.querySelectorAll("img");
          if (rowImgs.length <= 2) {
            processCommentRow(row);
            break;
          }
        }
        row = row.parentElement;
      }
    }
  }

  // ----------------------------------------------------------------
  // Gerenciamento de Observadores e Varredura Contínua
  // ----------------------------------------------------------------

  function handleMutations(mutations) {
    if (state.status !== "recording") return;
    scanLiveComments();
  }

  function startScanning() {
    scanLiveComments();

    if (!observer) {
      observer = new MutationObserver(handleMutations);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    if (!liveScanInterval) {
      liveScanInterval = setInterval(scanLiveComments, CONFIG.SCAN_INTERVAL_MS);
    }

    startAutoBackup();
  }

  function stopScanning() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (liveScanInterval) {
      clearInterval(liveScanInterval);
      liveScanInterval = null;
    }
    stopAutoBackup();
  }

  // ----------------------------------------------------------------
  // Armazenamento
  // ----------------------------------------------------------------

  function registerComment(user, comment) {
    const cleanUser = user.replace(/^@/, "").trim();
    const cleanComment = comment.trim();
    if (!cleanComment) return;

    // Evita duplicatas imediatas consecutivas (mesmo autor e texto em menos de 2s)
    const nowMs = Date.now();
    const last = state.comments[state.comments.length - 1];
    if (
      last &&
      last.user === "@" + cleanUser &&
      last.comment === cleanComment &&
      nowMs - (last.timestampMs || 0) < 2000
    ) {
      return;
    }

    const now = new Date();
    const entry = {
      captured_time: now.toLocaleTimeString("pt-BR", { hour12: false }),
      captured_at: now.toISOString(),
      user: "@" + cleanUser,
      comment: cleanComment,
      timestampMs: nowMs,
    };

    state.comments.push(entry);
    persistState();
    updateCounterAndPreview(entry);
  }

  function persistState() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistStateImmediate, CONFIG.PERSIST_DEBOUNCE_MS);
  }

  function persistStateImmediate() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!isExtensionValid() || !chrome.storage?.local) return;

    try {
      chrome.storage.local.set({ [STORAGE_KEY]: state }, () => {
        if (chrome.runtime?.lastError) {
          console.warn("[IG Live Capture] Erro de gravação:", chrome.runtime.lastError.message);
        }
      });
    } catch (err) {
      console.warn("[IG Live Capture] Falha ao persistir estado:", err);
    }
  }

  // ----------------------------------------------------------------
  // Exportações (CSV / HTML / JSON)
  // ----------------------------------------------------------------

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function timestampForFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
      d.getHours()
    )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function buildCSV(comments) {
    const header = ["captured_time", "captured_at", "user", "comment"];
    const escape = (val) => '"' + String(val).replace(/"/g, '""') + '"';
    const lines = [header.map(escape).join(",")];
    comments.forEach((c) => {
      lines.push(
        [c.captured_time, c.captured_at, c.user, c.comment].map(escape).join(",")
      );
    });
    return "\uFEFF" + lines.join("\r\n");
  }

  function buildHTMLReport(comments) {
    const total = comments.length;
    const uniqueUsers = new Set(comments.map((c) => c.user));
    const keywordCounts = {};
    PURCHASE_KEYWORDS.forEach((k) => (keywordCounts[k] = 0));
    comments.forEach((c) => {
      const lower = c.comment.toLowerCase();
      PURCHASE_KEYWORDS.forEach((k) => {
        if (lower.includes(k)) keywordCounts[k]++;
      });
    });

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
<title>Relatório de Comentários — Live Instagram</title>
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
  tr:hover td { background:#fbfcfe; }
</style>
</head>
<body>
  <h1>Relatório de Comentários — Live Instagram</h1>
  <div class="meta">Gerado em ${new Date().toLocaleString("pt-BR")} · ${total} comentário(s) · ${uniqueUsers.size} usuário(s) único(s)</div>

  <div class="summary">
    <div class="summary-card"><div class="n">${total}</div><div class="l">Comentários</div></div>
    <div class="summary-card"><div class="n">${uniqueUsers.size}</div><div class="l">Usuários únicos</div></div>
  </div>

  <div class="kw-section">
    <div class="meta">Contagem de Palavras-Chave de Compra:</div>
    <div class="kw-grid">${keywordCards}</div>
  </div>

  <table>
    <thead><tr><th>Horário</th><th>Usuário</th><th>Comentário</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
  }

  function sendDownload(content, mimeType, filename) {
    if (isExtensionValid()) {
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
      } catch (e) {
        // Fallback local
      }
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
      console.error("[IG Live Capture] Falha no download:", err);
    }
  }

  function startAutoBackup() {
    stopAutoBackup();
    autoBackupTimer = setInterval(() => {
      if (state.status !== "recording" || state.comments.length === 0) return;
      sendDownload(
        buildCSV(state.comments),
        "text/csv;charset=utf-8",
        `backup_auto_ig_live_${timestampForFilename()}.csv`
      );
    }, CONFIG.AUTO_BACKUP_INTERVAL_MS);
  }

  function stopAutoBackup() {
    if (autoBackupTimer) {
      clearInterval(autoBackupTimer);
      autoBackupTimer = null;
    }
  }

  // ----------------------------------------------------------------
  // Painel Flutuante (UI)
  // ----------------------------------------------------------------

  function makeButton(label, className, handler) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handler();
    });
    return btn;
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
      panelEls.preview.title = `${entry.captured_time} — ${entry.user}: ${entry.comment}`;
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
    persistStateImmediate();
    updateStatusBadge();
    updateCounterAndPreview();
  }

  function onDownloadCsv() {
    if (state.comments.length === 0) {
      alert("Nenhum comentário capturado para exportar.");
      return;
    }
    sendDownload(
      buildCSV(state.comments),
      "text/csv;charset=utf-8",
      `ig_live_comentarios_${timestampForFilename()}.csv`
    );
  }

  function onDownloadHtml() {
    if (state.comments.length === 0) {
      alert("Nenhum comentário capturado para exportar.");
      return;
    }
    sendDownload(
      buildHTMLReport(state.comments),
      "text/html;charset=utf-8",
      `ig_live_relatorio_${timestampForFilename()}.html`
    );
  }

  function onDownloadJson() {
    if (state.comments.length === 0) {
      alert("Nenhum comentário capturado para exportar.");
      return;
    }
    sendDownload(
      JSON.stringify(state.comments, null, 2),
      "application/json;charset=utf-8",
      `ig_live_comentarios_${timestampForFilename()}.json`
    );
  }

  function onReset() {
    const ok = window.confirm(
      "Deseja limpar todos os comentários capturados?\n\nEsta ação apagará a lista atual."
    );
    if (!ok) return;
    state.comments = [];
    persistStateImmediate();
    updateCounterAndPreview();
  }

  function buildPanel() {
    if (document.getElementById("ig-live-capture-panel")) return;

    const panel = document.createElement("div");
    panel.id = "ig-live-capture-panel";

    const header = document.createElement("div");
    header.className = "ig-lc-header";

    const title = document.createElement("span");
    title.className = "ig-lc-title";
    title.textContent = "IG Live Captura";

    const headerRight = document.createElement("div");
    headerRight.className = "ig-lc-header-right";

    const liveContextBadge = document.createElement("span");
    liveContextBadge.className = "ig-lc-ctx-badge";

    const statusBadge = document.createElement("span");
    statusBadge.className = "ig-lc-status";

    const btnMin = document.createElement("button");
    btnMin.type = "button";
    btnMin.className = "ig-lc-min-btn";
    btnMin.title = "Minimizar / Expandir Painel";
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
    rowExport.append(
      makeButton("⬇ CSV", "ig-lc-btn", onDownloadCsv),
      makeButton("⬇ HTML", "ig-lc-btn", onDownloadHtml),
      makeButton("⬇ JSON", "ig-lc-btn", onDownloadJson)
    );

    const rowActions = document.createElement("div");
    rowActions.className = "ig-lc-btnrow";
    rowActions.append(
      makeButton("🗑 Limpar Lista", "ig-lc-btn ig-lc-btn-secondary", onReset)
    );

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
  // Mensagens do Popup
  // ----------------------------------------------------------------

  if (isExtensionValid()) {
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
        onDownloadCsv();
        sendResponse({ ok: true });
      } else if (req.type === "RESET") {
        onReset();
        sendResponse({ ok: true });
      }
      return true;
    });
  }

  // ----------------------------------------------------------------
  // Inicialização
  // ----------------------------------------------------------------

  async function init() {
    if (!isExtensionValid()) return;

    try {
      if (chrome.storage && chrome.storage.local) {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        if (stored && stored[STORAGE_KEY]) {
          state = Object.assign({ status: "paused", comments: [] }, stored[STORAGE_KEY]);
          state.status = "paused"; // Sempre inicia pausado por padrão
        }
      }
    } catch (e) {
      console.warn("[IG Live Capture] Erro ao restaurar estado:", e);
    }

    buildPanel();
    updateStatusBadge();
    updateCounterAndPreview();

    // Monitora mudanças de tela ou Live
    setInterval(() => {
      updateStatusBadge();
    }, 2000);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init);
  }
})();
