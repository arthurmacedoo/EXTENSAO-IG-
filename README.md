# IG Live - Captura de Comentários (Chrome Extension)

Extensão para Google Chrome (Manifest V3) que captura comentários de transmissões ao vivo (Lives) no Instagram em tempo real, permitindo exportar em CSV, HTML e JSON.

## Principais Recursos e Correções
1. **Padrão Desligado**: Ao abrir qualquer página do Instagram, a extensão fica **desligada/pausada**, não capturando feeds, perfis ou navegação.
2. **Botão Liga / Desliga**: Botão evidente no painel flutuante e no ícone da extensão para ligar a captura somente quando você quiser.
3. **Detecção de Live**: Alerta se você estiver em uma live ou fora dela.
4. **Tratamento de Storage**: Correção para evitar o erro de `chrome.storage.local.set` e perda de contexto ao recarregar a extensão.
5. **Exportação**: Baixe a lista em CSV (compatível com Excel), HTML (com destaque para termos de compra) e JSON.

## Como instalar no Chrome neste computador:
1. Abra o Google Chrome e acesse: `chrome://extensions`
2. Ative o modo **"Modo do desenvolvedor"** no canto superior direito.
3. Clique em **"Carregar sem compactação"** (Load unpacked).
4. Selecione esta pasta:
   `c:\Users\artfa\Documents\antigravity\valiant-chandrasekhar`
5. Pronto! Ao acessar uma Live no Instagram, clique em **"▶ LIGAR CAPTURA"**.
