const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname);
const port = Number(process.env.PORT) || 5173;
const host = "127.0.0.1";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const server = http.createServer(function (req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const relative = urlPath.replace(/^\/+/, "") || "index.html";
  let file = path.resolve(root, relative);

  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(file, function (err, stats) {
    if (!err && stats.isDirectory()) {
      file = path.join(file, "index.html");
    }

    fs.readFile(file, function (readErr, data) {
      if (readErr) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          '<!DOCTYPE html><html lang="ru"><meta charset="utf-8"><title>Страница не найдена</title><body style="font-family:sans-serif;padding:3rem;background:#f4efe6;color:#241f1c"><p>Страница не найдена.</p><p><a href="/">На главную</a></p></body></html>'
        );
        return;
      }

      res.writeHead(200, {
        "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream"
      });
      res.end(data);
    });
  });
});

server.listen(port, host, function () {
  console.log("Сайт Оксаны Ежевской: http://" + host + ":" + port + "/");
});
