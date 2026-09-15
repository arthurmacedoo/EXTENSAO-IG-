const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const server = http.createServer((req, res) => {
  const cleanUrl = req.url.split("?")[0];
  let fileName = cleanUrl === "/" ? "simulador_live_instagram.html" : cleanUrl.replace(/^\//, "");
  let filePath = path.join(__dirname, fileName);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain;charset=utf-8" });
    res.end("Arquivo não encontrado: " + fileName);
    return;
  }

  const ext = path.extname(filePath);
  const mimeTypes = {
    ".html": "text/html;charset=utf-8",
    ".js": "text/javascript;charset=utf-8",
    ".css": "text/css;charset=utf-8",
    ".png": "image/png",
    ".json": "application/json;charset=utf-8"
  };

  res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain;charset=utf-8" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log("==================================================");
  console.log(" Servidor de Simulacao de Live do Instagram Rodando!");
  console.log(` Acesse no Google Chrome: http://localhost:${PORT}/simulador_live_instagram.html`);
  console.log("==================================================");
  console.log("Pressione Ctrl+C para encerrar o teste.");
});
