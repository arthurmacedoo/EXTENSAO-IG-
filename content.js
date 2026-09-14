/**
 * content.js — IG Live: Captura de Comentários
 * ---------------------------------------------------------------------
 * Versão Corrigida:
 * - Inicia sempre PAUSADO/DESLIGADO por padrão (não captura feed/perfil).
 * - Botão evidente de LIGAR / DESLIGAR no painel e via popup.
 * - Detecção contextual de Live vs Instagram normal.
 * - Proteção contra "Extension context invalidated" e erro em chrome.storage.local.set.
 * - Filtros reforçados para ignorar navegação, perfis e cabeçalhos.
 * ---------------------------------------------------------------------
 */

(function () {
  "use strict";

  const STORAGE_KEY = "igLiveCapture_v1";

  const CONFIG = {
    MAX_CLIMB_LEVELS: 5,
    MAX_CONTAINER_TEXT_LENGTH: 400,
    ABORT_CLIMB_TEXT_LENGTH: 600,
    MAX_ANCHORS_IN_CONTAINER: 2,
    AUTO_BACKUP_INTERVAL_MS: 10 * 60 * 1000,
    PERSIST_DEBOUNCE_MS: 300,
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

  const USERNAME_REGEX = /^\/([a-zA-Z0-9._]+)\/?$/;

  /** @type {{status:'recording'|'paused'|'ended', comments: Array<{captured_time:string, captured_at:string, user:string, comment:string}>}} */
  let state = { status: "paused", comments: [] }; // SEMPRE começa pausado!

  let observer = null;
  let autoBackupTimer = null;
  let saveTimer = null;
  const panelEls = {};

  // ----------------------------------------------------------------
  // Validações e Contexto de Extensão
  // ----------------------------------------------------------------

  function isExtensionValid() {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  }

  function isLiveUrl() {
    return location.pathname.includes("/live") || location.search.includes("live");
  }

  function checkLiveContext() {
    if (isLiveUrl()) return true;
    // Verifica se há elementos de transmissão ao vivo na tela
    const hasLiveBadge = !!document.querySelector('[aria-label*="ao vivo" i], [aria-label*="live" i]');
    const hasVideo = !!document.querySelector("video");
    return hasVideo && hasLiveBadge;
  }

  // ----------------------------------------------------------------
  // Utilidades de texto / DOM
  // ----------------------------------------------------------------

  function extractUsernameFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const isAllowedHost =
        /(^|\.)instagram\.com$/.test(url.hostname) ||
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1";
      if (!isAllowedHost) return null;

      const match = url.pathname.match(USERNAME_REGEX);
      if (!match) return null;

      const username = match[1].toLowerCase();
      if (IGNORED_ROUTES.has(username)) return null;
      return username;
    } catch (e) {
      return null;
    }
  }

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

  // ----------------------------------------------------------------
  // Heurística de Captura via DOM
  // ----------------------------------------------------------------

  function isInIgnoredArea(el) {
    if (!el) return true;
    // Ignora elementos de navegação lateral, topo, perfil e cabeçalho do IG
    return !!el.closest(
      'nav, header, [role="navigation"], [role="banner"], #ig-live-capture-panel, [data-ig-captured="true"]'
    );
  }

  function cleanCommentText(containerEl, authorHref) {
    const clone = containerEl.cloneNode(true);
    const targetUser = extractUsernameFromHref(authorHref);

    // Remove apenas links que apontam para o autor
    clone.querySelectorAll("a[href]").forEach((a) => {
      const h = a.getAttribute("href");
      if (h === authorHref || (targetUser && extractUsernameFromHref(h) === targetUser)) {
        a.remove();
      }
    });

    // Remove botões e ícones ("Curtir", "Responder", etc.)
    clone.querySelectorAll('button, [role="button"], svg').forEach((b) => b.remove());

    let text = clone.innerText || clone.textContent || "";
    text = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length && !ACTION_WORDS.has(l.toLowerCase()))
      .join(" ");
    text = text.replace(/\s+/g, " ").trim();
    return text;
  }

  function findCommentContainerAndText(anchor) {
    if (isInIgnoredArea(anchor)) return null;

    const href = anchor.getAttribute("href");
    let el = anchor;
    for (let i = 0; i < CONFIG.MAX_CLIMB_LEVELS && el && el.parentElement; i++) {
      el = el.parentElement;
      if (!el || el === document.body) return null;
      if (isInIgnoredArea(el)) return null;

      const totalTextLen = (el.innerText || el.textContent || "").length;
      if (totalTextLen > CONFIG.ABORT_CLIMB_TEXT_LENGTH) break;

      const anchorCount = el.querySelectorAll("a[href]").length;
      if (anchorCount > CONFIG.MAX_ANCHORS_IN_CONTAINER) break;

      const text = cleanCommentText(el, href);
      if (text.length > 0 && text.length < CONFIG.MAX_CONTAINER_TEXT_LENGTH) {
        return { container: el, text };
      }
    }
    return null;
  }

  function tryProcessAnchor(anchor, isInitialScan = false) {
    if (!anchor || !anchor.getAttribute) return;
    if (state.status !== "recording") return; // NUNCA processa se estiver pausado/desligado!
    if (isInIgnoredArea(anchor)) return;

    const href = anchor.getAttribute("href");
    const username = extractUsernameFromHref(href);
    if (!username) return;

    const res = findCommentContainerAndText(anchor);
    if (!res || !res.text) return;

    // Marca como capturado no DOM para não duplicar
    res.container.dataset.igCaptured = "true";

    // Evita duplicatas se já existe registro com mesmo usuário e comentário nos últimos instantes
    const alreadyCaptured = state.comments.some(
      (c) => c.user === "@" + username && c.comment === res.text
    );
    if (alreadyCaptured) return;

    registerComment(username, res.text);
  }

  function scanNodeForAnchors(node) {
    if (state.status !== "recording") return;
    if (!(node instanceof Element)) return;
    if (isInIgnoredArea(node)) return;

    if (node.tagName === "A" && node.hasAttribute("href")) {
      tryProcessAnchor(node, false);
    }
    if (typeof node.querySelectorAll === "function") {
      node.querySelectorAll("a[href]").forEach((a) => tryProcessAnchor(a, false));
    }
  }

  function handleMutations(mutations) {
    if (state.status !== "recording") return;
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(scanNodeForAnchors);
    }
  }

  function attachObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(handleMutations);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function detachObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function doInitialScan() {
    if (state.status !== "recording") return;
    document.querySelectorAll("a[href]").forEach((a) => tryProcessAnchor(a, true));
  }

  // ----------------------------------------------------------------
  // Armazenamento com Tratamento Seguro de Erros (Fix linha 242)
  // ----------------------------------------------------------------

  function registerComment(user, comment) {
    const now = new Date();
    const entry = {
      captured_time: now.toLocaleTimeString("pt-BR", { hour12: false }),
      captured_at: now.toISOString(),
      user: "@" + user,
      comment,
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
    // Proteção essencial: se a extensão foi recarregada no DevTools, evita erro de contexto
    if (!isExtensionValid() || !chrome.storage || !chrome.storage.local) {
      return;
    }

    try {
      // Usa callback compatível com qualquer versão do Chrome para evitar erro de .catch em undefined
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
  // Exportações
  // ----------------------------------------------------------------

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
    panelEls.statusBadge.classList.remove("recording", "paused", "ended");

    const inLive = checkLiveContext();
    if (panelEls.liveContextBadge) {
      if (inLive) {
        panelEls.liveContextBadge.textContent = "🔴 Live Detectada";
        panelEls.liveContextBadge.className = "ig-lc-ctx-live";
      } else {
        panelEls.liveContextBadge.textContent = "⚪ Fora de Live";
        panelEls.liveContextBadge.className = "ig-lc-ctx-normal";
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
      panelEls.preview.textContent = state.status === "recording" 
        ? "Aguardando novos comentários..." 
        : "Captura desligada. Clique em 'Ligar Captura' para iniciar.";
    }
  }

  function onTogglePower() {
    if (state.status === "recording") {
      // DESLIGAR
      state.status = "paused";
      detachObserver();
      stopAutoBackup();
    } else {
      // LIGAR
      const inLive = checkLiveContext();
      if (!inLive) {
        const proceed = window.confirm(
          "Aviso: Nenhuma Live do Instagram foi detectada nesta aba no momento.\n\nDeseja ligar a captura mesmo assim?"
        );
        if (!proceed) return;
      }
      state.status = "recording";
      attachObserver();
      doInitialScan();
      startAutoBackup();
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

    // BOTÃO PRINCIPAL LIGAR / DESLIGAR
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
  // Mensagens do Popup (Para controlar pelo ícone da extensão)
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
          // SEGURANÇA: sempre inicia PAUSADO para não capturar navegação comum!
          state.status = "paused";
        }
      }
    } catch (e) {
      console.warn("[IG Live Capture] Erro ao restaurar estado:", e);
    }

    buildPanel();
    updateStatusBadge();
    updateCounterAndPreview();

    // Observe mudanças de URL dentro de SPAs do Instagram
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        updateStatusBadge();
      }
    }, 1500);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init);
  }
})();
