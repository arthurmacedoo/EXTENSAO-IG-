document.addEventListener("DOMContentLoaded", () => {
  const badge = document.getElementById("badge");
  const countEl = document.getElementById("comment-count");
  const btnToggle = document.getElementById("btn-toggle");
  const btnCsv = document.getElementById("btn-csv");
  const btnReset = document.getElementById("btn-reset");

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

  function updateUi(status, count) {
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
  }

  // Consulta status atual da aba ativa
  sendToActiveTab({ type: "GET_STATE" }, (res) => {
    if (res) {
      updateUi(res.status, res.totalComments);
    }
  });

  btnToggle.addEventListener("click", () => {
    sendToActiveTab({ type: "TOGGLE_POWER" }, (res) => {
      if (res) {
        updateUi(res.status, res.totalComments);
      }
    });
  });

  btnCsv.addEventListener("click", () => {
    sendToActiveTab({ type: "DOWNLOAD_CSV" });
  });

  btnReset.addEventListener("click", () => {
    sendToActiveTab({ type: "RESET" }, () => {
      countEl.textContent = "0";
    });
  });
});
