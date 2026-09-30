/**
 * background.js — Service worker para downloads e prevenção contra suspensão de abas
 */

// Mantém canais de comunicação com a aba da live para evitar Tab Discarding
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "IG_LIVE_KEEP_ALIVE") {
    port.onDisconnect.addListener(() => {
      // Porta desconectada (aba fechada ou recarregada)
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "IG_LIVE_COMMENT_CAPTURED") {
    // Reenvia em tempo real para todas as outras abas (incluindo abas do Dashboard)
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id && tab.id !== sender.tab?.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: "DISPATCH_LIVE_COMMENT_TO_DASHBOARD",
            comment: message.comment
          }, () => {
            if (chrome.runtime.lastError) {
              // Silencia caso a aba não tenha listener
            }
          });
        }
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "IG_LIVE_DOWNLOAD") {
    const { content, mimeType, filename } = message;

    try {
      const base64Data = btoa(unescape(encodeURIComponent(content)));
      const dataUrl = `data:${mimeType || "text/plain;charset=utf-8"};base64,${base64Data}`;

      chrome.downloads.download(
        {
          url: dataUrl,
          filename: filename || `ig_live_${Date.now()}.csv`,
          saveAs: false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, downloadId });
          }
        }
      );
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true; // resposta assíncrona
  }
});
