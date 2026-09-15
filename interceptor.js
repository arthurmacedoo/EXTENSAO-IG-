/**
 * interceptor.js — Injetado no contexto da página do Instagram (world: MAIN)
 * --------------------------------------------------------------------------
 * Intercepta de forma 100% PASSIVA as chamadas de rede que o próprio
 * Instagram Web realiza para carregar comentários de Live.
 * 
 * Vantagens:
 * - 0% risco de Rate Limit (não faz requisições extras ao servidor do Instagram).
 * - 100% de precisão (pega o JSON oficial com ID único `pk`, timestamp real e texto limpo).
 * - Não depende de seletores de CSS nem sofre com listas virtualizadas do DOM.
 * --------------------------------------------------------------------------
 */

(function () {
  "use strict";

  function extractComments(data) {
    if (!data) return [];
    // Não incluir system_comments (ex: "fulano entrou na live"), apenas comentários de usuários
    if (Array.isArray(data.comments)) {
      return data.comments;
    }
    if (data.data) {
      if (Array.isArray(data.data.comments)) return data.data.comments;
      if (Array.isArray(data.data.live_comments)) return data.data.live_comments;
      for (const k of Object.keys(data.data)) {
        if (data.data[k] && Array.isArray(data.data[k].comments)) {
          return data.data[k].comments;
        }
      }
    }
    return [];
  }

  function isCommentRequest(url) {
    if (!url || typeof url !== "string") return false;
    return (
      url.includes("/get_comment/") ||
      (url.includes("/live/") && url.includes("comment")) ||
      (url.includes("/api/v1/live/") && url.includes("/comment/")) ||
      url.includes("live_comment")
    );
  }

  // 1. Interceptação de window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

      // Intercepta comentários de Live
      if (isCommentRequest(url)) {
        const clone = response.clone();
        clone
          .json()
          .then((data) => {
            const list = extractComments(data);
            if (list.length > 0) {
              window.postMessage(
                {
                  source: "IG_LIVE_INTERCEPTOR",
                  type: "REST_COMMENTS",
                  comments: list,
                },
                "*"
              );
            }
          })
          .catch(() => {});
      }

      // Detecta broadcast_id da Live
      const match = url.match(/\/api\/v1\/live\/(\d+)\//);
      if (match && match[1]) {
        window.postMessage(
          {
            source: "IG_LIVE_INTERCEPTOR",
            type: "BROADCAST_ID_FOUND",
            broadcastId: match[1],
          },
          "*"
        );
      }
    } catch (e) {
      // Ignora silenciosamente para não afetar o Instagram
    }
    return response;
  };

  // 2. Interceptação de XMLHttpRequest (para chamadas legadas/internas)
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener("load", function () {
      try {
        if (typeof url === "string" && isCommentRequest(url)) {
          const data = JSON.parse(this.responseText);
          const list = extractComments(data);
          if (list.length > 0) {
            window.postMessage(
              {
                source: "IG_LIVE_INTERCEPTOR",
                type: "REST_COMMENTS",
                comments: list,
              },
              "*"
            );
          }
        }
      } catch (e) {}
    });
    return originalOpen.call(this, method, url, ...rest);
  };
})();
