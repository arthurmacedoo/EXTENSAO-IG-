document.addEventListener("DOMContentLoaded", () => {
  const badge = document.getElementById("badge");
  const ctxBadge = document.getElementById("ctx-badge");
  const countEl = document.getElementById("comment-count");
  const btnToggle = document.getElementById("btn-toggle");
  const btnPanelToggle = document.getElementById("btn-panel-toggle");
  const btnCsv = document.getElementById("btn-csv");
  const btnHtml = document.getElementById("btn-html");
  const btnReset = document.getElementById("btn-reset");
  const chkAutoOpenClick = document.getElementById("chk-auto-open-click");
  const chkAutoOpenIg = document.getElementById("chk-auto-open-ig");
  const chkAutoBackup = document.getElementById("chk-auto-backup");

  let isPanelVisible = false;

  function sendToActiveTab(msg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].id) return;
      chrome.tabs.sendMessage(tabs[0].id, msg, (res) => {
        if (!chrome.runtime.lastError && cb) {
          cb(res);
        }
      });
    });
  }

  function updateUi(status, count, isLive, panelVisible) {
    countEl.textContent = count !== undefined ? count : "0";
    if (status === "recording") {
      badge.textContent = "GRAVANDO";
      badge.className = "badge recording";
      btnToggle.textContent = "⏹ DESLIGAR CAPTURA";
      btnToggle.className = "btn-power is-on";
    } else {
      badge.textContent = "DESLIGADO";
      badge.className = "badge paused";
      btnToggle.textContent = "▶ LIGAR CAPTURA";
      btnToggle.className = "btn-power is-off";
    }

    if (ctxBadge) {
      if (isLive) {
        ctxBadge.textContent = "🔴 Live Detectada";
        ctxBadge.className = "ctx-badge ctx-live";
      } else {
        ctxBadge.textContent = "⚪ Instagram Aberto";
        ctxBadge.className = "ctx-badge ctx-normal";
      }
    }

    if (panelVisible !== undefined) {
      isPanelVisible = panelVisible;
      updatePanelBtn();
    }
  }

  function updatePanelBtn() {
    if (!btnPanelToggle) return;
    if (isPanelVisible) {
      btnPanelToggle.textContent = "👁️ Ocultar Painel na Tela";
      btnPanelToggle.className = "btn-panel-toggle is-hidden";
    } else {
      btnPanelToggle.textContent = "👁️ Abrir Painel na Tela";
      btnPanelToggle.className = "btn-panel-toggle";
    }
  }

  // Carrega preferências salvas
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["autoOpenOnClick", "autoOpenOnInstagram", "autoBackupEnabled"], (res) => {
      if (res) {
        if (typeof res.autoOpenOnClick === "boolean") {
          chkAutoOpenClick.checked = res.autoOpenOnClick;
        }
        if (typeof res.autoOpenOnInstagram === "boolean") {
          chkAutoOpenIg.checked = res.autoOpenOnInstagram;
        }
        if (typeof res.autoBackupEnabled === "boolean" && chkAutoBackup) {
          chkAutoBackup.checked = res.autoBackupEnabled;
        }
      }

      // Se a opção "abrir painel ao clicar na extensão" estiver ativa, envia comando para abrir na tela
      if (chkAutoOpenClick.checked) {
        sendToActiveTab({ type: "SHOW_PANEL" }, (res) => {
          if (res && res.panelVisible !== undefined) {
            isPanelVisible = res.panelVisible;
            updatePanelBtn();
          }
        });
      }
    });
  }

  // Consulta status atual da aba ativa
  sendToActiveTab({ type: "GET_STATE" }, (res) => {
    if (res) {
      updateUi(res.status, res.totalComments, res.isLive, res.panelVisible);
    } else {
      if (ctxBadge) {
        ctxBadge.textContent = "⚪ Abra uma aba do Instagram";
        ctxBadge.className = "ctx-badge ctx-normal";
      }
    }
  });

  // Alterna o botão Ligar / Desligar Captura
  btnToggle.addEventListener("click", () => {
    sendToActiveTab({ type: "TOGGLE_POWER" }, (res) => {
      if (res) {
        updateUi(res.status, res.totalComments);
      }
    });
  });

  // Alterna visibilidade do painel na tela
  btnPanelToggle.addEventListener("click", () => {
    sendToActiveTab({ type: "TOGGLE_PANEL" }, (res) => {
      if (res && res.panelVisible !== undefined) {
        isPanelVisible = res.panelVisible;
        updatePanelBtn();
      }
    });
  });

  btnCsv.addEventListener("click", () => {
    sendToActiveTab({ type: "DOWNLOAD_CSV" });
  });

  if (btnHtml) {
    btnHtml.addEventListener("click", () => {
      sendToActiveTab({ type: "DOWNLOAD_HTML" });
    });
  }

  btnReset.addEventListener("click", () => {
    sendToActiveTab({ type: "RESET" }, () => {
      countEl.textContent = "0";
    });
  });

  chkAutoOpenClick.addEventListener("change", () => {
    chrome.storage.local.set({ autoOpenOnClick: chkAutoOpenClick.checked });
  });

  chkAutoOpenIg.addEventListener("change", () => {
    chrome.storage.local.set({ autoOpenOnInstagram: chkAutoOpenIg.checked });
    sendToActiveTab({ type: "SET_AUTO_OPEN_IG", value: chkAutoOpenIg.checked });
  });

  if (chkAutoBackup) {
    chkAutoBackup.addEventListener("change", () => {
      chrome.storage.local.set({ autoBackupEnabled: chkAutoBackup.checked });
      sendToActiveTab({ type: "SET_AUTO_BACKUP", value: chkAutoBackup.checked });
    });
  }
});

