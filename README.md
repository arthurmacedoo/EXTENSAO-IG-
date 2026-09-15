# ⚡ IG Live - Captura Profissional de Comentários (Live Commerce)

Extensão profissional para **Google Chrome** desenvolvida para quem faz **Lives de Vendas no Instagram**. Captura 100% dos comentários em tempo real, organiza compradores, destaca intenções de compra e gera uma **Dashboard Interativa** para fechamento rápido de pedidos via WhatsApp ou Direct.

---

## 🎯 O que a ferramenta faz?

* 🔴 **Captura Híbrida em Tempo Real**: Intercepta o feed oficial de dados do Instagram (REST) + leitor visual de tela (DOM com suporte a avatares e comentários fixados).
* 🛡️ **Proteção Anti-Perda (IndexedDB)**: Todos os comentários ficam salvos localmente no navegador. Se a página atualizar ou a live cair, nenhum comentário é perdido.
* 📊 **Relatório em Dashboard Interativa (HTML)**:
  * **Filtro Direto na Coluna USUÁRIO**: Selecione qualquer cliente e veja na hora apenas as mensagens dele.
  * **Tags de Compra Clicáveis**: Clique em botões como **`QUERO`**, **`RESERVA`**, **`PIX`** ou **`TAMANHO`** para filtrar imediatamente quem quer comprar.
  * **Busca Instantânea**: Digite qualquer palavra, código de produto ou `@` para filtrar em milissegundos.
  * **📋 Copiar @ dos Compradores**: Botão de 1 clique que copia a lista de clientes para colar no WhatsApp ou Direct.
* 📁 **Exportações Múltiplas**: Baixe a lista a qualquer momento em **CSV (Excel)**, **HTML Interativo** ou **JSON**.
* 🔒 **100% Segura e Privada**: Não pede senha do Instagram, não faz requisições externas e não bloqueia sua conta. Roda 100% no seu navegador.

---

## 🚀 Como Instalar no Google Chrome

Não é necessário instalar nenhum programa adicional. A extensão roda direto no navegador:

1. **Baixe ou clone** este repositório no seu computador.
2. Abra o **Google Chrome** e acesse na barra de endereços:
   ```text
   chrome://extensions
   ```
3. Ative a chave **"Modo do desenvolvedor"** no canto superior direito.
4. Clique no botão **"Carregar sem compactação"** (canto superior esquerdo).
5. Selecione a pasta deste projeto (`EXTENSAO IG`).
6. Pronto! O ícone da extensão aparecerá na barra do Chrome.

---

## 💻 Como Usar na Live do Instagram

1. Abra a Live no Instagram Web pelo computador:
   ```text
   https://www.instagram.com/SEU_PERFIL/live/
   ```
2. O painel flutuante **IG Live Pro ⚡** aparecerá no canto superior direito da tela.
3. Clique no botão verde **▶ LIGAR CAPTURA**.
4. Os comentários serão capturados e contabilizados automaticamente enquanto a live acontece.
5. Ao final (ou durante a live), clique em:
   * **⬇ CSV**: Para abrir a planilha no Excel.
   * **⬇ Relatório**: Para abrir a Dashboard Interativa com filtros por cliente e termos de compra.
   * **📦 Histórico**: Para acessar dados de lives passadas salvas no computador.

---

## 🧪 Como Testar sem precisar de uma Live ao vivo

O projeto já inclui um **Simulador de Live do Instagram**:

1. Dê dois cliques no arquivo:
   ```text
   iniciar_teste_local.bat
   ```
2. O Chrome abrirá uma Live simulada com vídeo e chat ao vivo idênticos ao Instagram.
3. Ligue a extensão e clique em **"▶ Iniciar Live Automática"** para ver a captura funcionando e testar o relatório!

---

## 🌐 Compatibilidade e Suporte

| Recurso | Suporte |
| :--- | :--- |
| **Navegadores** | Google Chrome, Microsoft Edge, Brave, Opera (qualquer navegador Chromium) |
| **Páginas** | Instagram Live Web (`instagram.com/*/live`) e simulador local |
| **Duração** | Suporta transmissões longas (4 a 5+ horas e mais de 10.000 comentários) |
| **Formato de Exportação** | CSV (Excel), HTML Interativo (Dashboard offline) e JSON |
| **Idiomas de termos** | Português (Quero, Reserva, Separa, Pix, Tamanho, Valor, Preço, Comprar, Leva) |

---

## 📄 Licença

Uso livre para lojistas, streamers e vendedores de Live Commerce.
