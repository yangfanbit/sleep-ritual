import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve("D:/GitHub Space/sleepearly");
const PORT = Number(process.env.SR_PORT) || 8793;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("dev server on http://127.0.0.1:" + PORT);
});
