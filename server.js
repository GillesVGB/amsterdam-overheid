const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

loadLocalEnv();

const overheidAuth = require("./api/overheid-auth.js");
const overheidData = require("./api/overheid-data.js");

const publicDir = path.resolve(__dirname, "public");
const port = Number(process.env.PORT || 3000);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function loadLocalEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(__dirname, fileName);
    if (!fsSync.existsSync(filePath)) continue;

    const content = fsSync.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;

      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

function getSafeFilePath(rootDir, urlPathname) {
  const pathname = decodeURIComponent(urlPathname);
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(path.join(rootDir, requestedPath));
  return filePath === rootDir || filePath.startsWith(rootDir + path.sep) ? filePath : null;
}

async function serveStatic(req, res, pathname = null) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let filePath = getSafeFilePath(publicDir, pathname || url.pathname);

  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stat = await fs.stat(filePath);
    }
    if (!stat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", [".html", ".css", ".js"].includes(ext) ? "no-cache" : "public, max-age=3600");
    res.end(await fs.readFile(filePath));
  } catch {
    sendText(res, 404, "Not found");
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/overheid/auth/")) {
      if (await overheidAuth.handle(req, res, url)) return;
    }

    if (url.pathname.startsWith("/api/overheid/")) {
      await overheidData.handle(req, res, url);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/overheid") {
      redirect(res, "/overheid/");
      return;
    }

    if (url.pathname.startsWith("/overheid/")) {
      if (!(await overheidAuth.requirePortalAccess(req, res, url))) return;
      const overheidPath = url.pathname.replace(/^\/overheid/, "") || "/";
      await serveStatic(req, res, overheidPath);
      return;
    }

    sendText(res, 404, "Not found");
  });
}

if (require.main === module) {
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`Amsterdam overheid portaal draait op poort ${port}`);
  });
}

module.exports = { createServer };
