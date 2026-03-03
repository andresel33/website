const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { URL } = require("url");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".pdf", ".txt"]);
const RENAMABLE_MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".pdf"]);
const DOC_LINKS_FILENAME = "document_links.json";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8"
};

function commandErrorMessage(error) {
  const stderr = error && error.stderr ? String(error.stderr).trim() : "";
  const stdout = error && error.stdout ? String(error.stdout).trim() : "";
  return stderr || stdout || (error && error.message) || "Unknown command error";
}

function toRepoRelativePath(filePath) {
  const relative = path.relative(ROOT, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Cannot stage file outside repository root");
  }
  return relative.split(path.sep).join("/");
}

function sanitizeCommitFragment(value, fallback) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/["']/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function pushPaths(filePaths, message) {
  const repoPaths = [...new Set(filePaths.map((filePath) => toRepoRelativePath(filePath)))];
  if (repoPaths.length === 0) {
    throw new Error("No files provided for push");
  }

  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    throw new Error(`Git repository not available: ${commandErrorMessage(error)}`);
  }

  try {
    execFileSync("git", ["add", "--", ...repoPaths], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    throw new Error(`Git add failed: ${commandErrorMessage(error)}`);
  }

  let stagedFiles = "";
  try {
    stagedFiles = execFileSync("git", ["diff", "--cached", "--name-only", "--", ...repoPaths], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8"
    }).trim();
  } catch (error) {
    throw new Error(`Could not inspect staged changes: ${commandErrorMessage(error)}`);
  }

  if (!stagedFiles) {
    return;
  }

  try {
    execFileSync("git", ["commit", "-m", message, "--", ...repoPaths], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    throw new Error(`Git commit failed: ${commandErrorMessage(error)}`);
  }

  try {
    execFileSync("git", ["push"], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    throw new Error(`Git push failed after local commit: ${commandErrorMessage(error)}`);
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": MIME_TYPES[".json"] });
  res.end(JSON.stringify(payload));
}

function resolveCountryDir(countryParam) {
  if (!countryParam) {
    return null;
  }
  const desired = String(countryParam).toLowerCase();
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  const match = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === desired);
  return match ? path.join(DATA_DIR, match.name) : null;
}

function safeFilename(filename) {
  const base = path.basename(String(filename || "").trim());
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, "_");
  return cleaned || `upload_${Date.now()}.bin`;
}

function makeUniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext) || "upload";
  let candidate = path.join(dir, filename);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_${counter}${ext}`);
    counter += 1;
  }
  return candidate;
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) {
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (err) => {
      if (!aborted) {
        reject(err);
      }
    });
  });
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function createDocumentId() {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function inferDocumentName(url, fallbackIndex = 1) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("docs.google.com")) {
      const match = parsed.pathname.match(/\/document\/d\/([^/]+)/i);
      if (match && match[1]) {
        return `Google Doc ${match[1].slice(0, 8)}`;
      }
      return `Google Doc ${fallbackIndex}`;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1] || "";
    const name = decodeURIComponent(lastPart).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
    if (name && name.toLowerCase() !== "edit") {
      return name.slice(0, 120);
    }
    return parsed.hostname.slice(0, 120);
  } catch {
    return `Document ${fallbackIndex}`;
  }
}

function sanitizeDocumentName(name, url, fallbackIndex = 1) {
  const cleaned = String(name || "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned && cleaned.toLowerCase() !== "edit") {
    return cleaned.slice(0, 120);
  }
  return inferDocumentName(url, fallbackIndex);
}

function documentLinksPath(countryDir) {
  return path.join(countryDir, DOC_LINKS_FILENAME);
}

function buildRenamableFilename(oldName, requestedName) {
  const safeOld = safeFilename(oldName);
  const safeRequested = safeFilename(requestedName);
  const oldExt = path.extname(safeOld).toLowerCase();
  const sourceExt = path.extname(safeRequested).toLowerCase();
  const resolved = sourceExt ? safeRequested : `${safeRequested}${oldExt}`;
  const finalExt = path.extname(resolved).toLowerCase();
  if (!RENAMABLE_MEDIA_EXTENSIONS.has(finalExt)) {
    return null;
  }
  return resolved;
}

function loadLegacyTextLinks(countryDir) {
  const entries = fs
    .readdirSync(countryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".txt")
    .map((entry) => entry.name);

  const urls = [];
  entries.forEach((filename) => {
    const fullPath = path.join(countryDir, filename);
    const lines = fs
      .readFileSync(fullPath, "utf8")
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => isHttpUrl(line));
    lines.forEach((line) => urls.push(line));
  });

  const uniqueUrls = [...new Set(urls)];
  return uniqueUrls.map((url, index) => ({
    id: `legacy_${index + 1}`,
    name: inferDocumentName(url, index + 1),
    url
  }));
}

function normalizeDocumentLinks(records) {
  if (!Array.isArray(records)) {
    return [];
  }
  const normalized = [];
  records.forEach((record, index) => {
    const url = record && typeof record.url === "string" ? record.url.trim() : "";
    if (!isHttpUrl(url)) {
      return;
    }
    const id = record && typeof record.id === "string" && record.id.trim() ? record.id.trim() : createDocumentId();
    const name = sanitizeDocumentName(record && record.name, url, index + 1);
    normalized.push({ id, name, url });
  });
  return normalized;
}

function writeDocumentLinks(countryDir, records) {
  const filePath = documentLinksPath(countryDir);
  fs.writeFileSync(filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

function readDocumentLinks(countryDir) {
  const filePath = documentLinksPath(countryDir);
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const normalized = normalizeDocumentLinks(parsed);
      if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
        writeDocumentLinks(countryDir, normalized);
      }
      return normalized;
    } catch {
      return [];
    }
  }

  const migrated = loadLegacyTextLinks(countryDir);
  if (migrated.length > 0) {
    writeDocumentLinks(countryDir, migrated);
  }
  return migrated;
}

function serveFile(filePath, res) {
  const safePath = path.normalize(filePath);
  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(safePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

async function handleListRequest(requestUrl, res) {
  const country = requestUrl.searchParams.get("country");
  const countryDir = resolveCountryDir(country);
  if (!countryDir) {
    sendJson(res, 404, { error: "Country folder not found" });
    return;
  }

  const files = fs
    .readdirSync(countryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== DOC_LINKS_FILENAME)
    .map((entry) => entry.name);
  sendJson(res, 200, files);
}

async function handleUploadRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const countryDir = resolveCountryDir(body.country);
  if (!countryDir) {
    sendJson(res, 404, { error: "Country folder not found" });
    return;
  }

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) {
    sendJson(res, 400, { error: "No files provided" });
    return;
  }

  const saved = [];
  const rejected = [];
  const countryName = path.basename(countryDir).toLowerCase();

  for (const file of files) {
    const rawName = file && typeof file.name === "string" ? file.name : "";
    const contentBase64 = file && typeof file.contentBase64 === "string" ? file.contentBase64 : "";
    const ext = path.extname(rawName).toLowerCase();

    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      rejected.push({ name: rawName || "unknown", reason: "Unsupported file type" });
      continue;
    }
    if (!contentBase64) {
      rejected.push({ name: rawName || "unknown", reason: "Missing file content" });
      continue;
    }

    try {
      const buffer = Buffer.from(contentBase64, "base64");
      if (buffer.length === 0) {
        rejected.push({ name: rawName || "unknown", reason: "File is empty" });
        continue;
      }
      if (buffer.length > MAX_FILE_BYTES) {
        rejected.push({ name: rawName || "unknown", reason: "File is too large (max 15MB)" });
        continue;
      }

      const safeName = safeFilename(rawName);
      const destination = makeUniquePath(countryDir, safeName);
      fs.writeFileSync(destination, buffer);
      const finalName = path.basename(destination);
      const commitTitle = sanitizeCommitFragment(finalName, "uploaded-file");
      try {
        pushPaths([destination], `chore(content): upload ${commitTitle} in ${countryName}`);
      } catch (error) {
        rejected.push({ name: rawName || "unknown", reason: error.message });
        continue;
      }
      saved.push(path.basename(destination));
    } catch {
      rejected.push({ name: rawName || "unknown", reason: "Could not write file" });
    }
  }

  if (saved.length === 0) {
    const firstReason = rejected[0] && rejected[0].reason ? rejected[0].reason : "";
    const errorMessage = firstReason ? `No files were uploaded: ${firstReason}` : "No files were uploaded";
    sendJson(res, 400, { error: errorMessage, rejected });
    return;
  }

  sendJson(res, 200, { saved, rejected });
}

async function handleAddLinksRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const countryDir = resolveCountryDir(body.country);
  if (!countryDir) {
    sendJson(res, 404, { error: "Country folder not found" });
    return;
  }

  const rawLinks = Array.isArray(body.links) ? body.links : [];
  const cleaned = [...new Set(rawLinks.map((entry) => String(entry || "").trim()).filter((entry) => isHttpUrl(entry)))];
  if (cleaned.length === 0) {
    sendJson(res, 400, { error: "No valid HTTP/HTTPS links provided" });
    return;
  }

  const linksFile = documentLinksPath(countryDir);
  const countryName = path.basename(countryDir).toLowerCase();
  const current = readDocumentLinks(countryDir);
  const currentByUrl = new Set(current.map((entry) => entry.url));
  let working = [...current];
  const failed = [];
  let saved = 0;

  for (const url of cleaned) {
    if (currentByUrl.has(url)) {
      continue;
    }

    const entry = {
      id: createDocumentId(),
      name: inferDocumentName(url, working.length + 1),
      url
    };
    const next = [...working, entry];
    writeDocumentLinks(countryDir, next);

    const linkName = sanitizeCommitFragment(entry.name, "added-link");
    try {
      pushPaths([linksFile], `chore(content): add link ${linkName} in ${countryName}`);
      working = next;
      currentByUrl.add(url);
      saved += 1;
    } catch (error) {
      failed.push({ url, reason: error.message });
    }
  }

  if (saved === 0 && failed.length > 0) {
    sendJson(res, 500, { error: "No links could be committed", failed });
    return;
  }

  sendJson(res, 200, { saved, failed });
}

async function handleDocumentLinksRequest(req, requestUrl, res) {
  if (req.method === "GET") {
    const country = requestUrl.searchParams.get("country");
    const countryDir = resolveCountryDir(country);
    if (!countryDir) {
      sendJson(res, 404, { error: "Country folder not found" });
      return;
    }
    const links = readDocumentLinks(countryDir);
    sendJson(res, 200, links);
    return;
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    const countryDir = resolveCountryDir(body.country);
    if (!countryDir) {
      sendJson(res, 404, { error: "Country folder not found" });
      return;
    }

    const url = String(body.url || "").trim();
    if (!isHttpUrl(url)) {
      sendJson(res, 400, { error: "Invalid HTTP/HTTPS link" });
      return;
    }

    const links = readDocumentLinks(countryDir);
    const existing = links.find((entry) => entry.url === url);
    if (existing) {
      sendJson(res, 200, existing);
      return;
    }

    const entry = {
      id: createDocumentId(),
      name: sanitizeDocumentName(body.name, url, links.length + 1),
      url
    };
    const merged = [...links, entry];
    writeDocumentLinks(countryDir, merged);
    const linksFile = documentLinksPath(countryDir);
    const countryName = path.basename(countryDir).toLowerCase();
    const linkName = sanitizeCommitFragment(entry.name, "added-link");
    try {
      pushPaths([linksFile], `chore(content): add link ${linkName} in ${countryName}`);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
      return;
    }
    sendJson(res, 200, entry);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleRenameDocumentRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const countryDir = resolveCountryDir(body.country);
  if (!countryDir) {
    sendJson(res, 404, { error: "Country folder not found" });
    return;
  }

  const id = String(body.id || "").trim();
  const name = String(body.name || "").trim();
  if (!id) {
    sendJson(res, 400, { error: "Missing document id" });
    return;
  }
  if (!name) {
    sendJson(res, 400, { error: "Missing document name" });
    return;
  }

  const links = readDocumentLinks(countryDir);
  const index = links.findIndex((entry) => entry.id === id);
  if (index === -1) {
    sendJson(res, 404, { error: "Document link not found" });
    return;
  }

  links[index].name = sanitizeDocumentName(name, links[index].url, index + 1);
  writeDocumentLinks(countryDir, links);
  sendJson(res, 200, links[index]);
}

async function handleRenameMediaRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const countryDir = resolveCountryDir(body.country);
  if (!countryDir) {
    sendJson(res, 404, { error: "Country folder not found" });
    return;
  }

  const oldName = safeFilename(body.oldName || "");
  const requestedName = String(body.newName || "").trim();
  if (!oldName || !requestedName) {
    sendJson(res, 400, { error: "Missing oldName or newName" });
    return;
  }
  if (oldName === DOC_LINKS_FILENAME) {
    sendJson(res, 400, { error: "Protected file cannot be renamed" });
    return;
  }

  const oldExt = path.extname(oldName).toLowerCase();
  if (!RENAMABLE_MEDIA_EXTENSIONS.has(oldExt)) {
    sendJson(res, 400, { error: "Only image/PDF files can be renamed here" });
    return;
  }

  const sourcePath = path.join(countryDir, oldName);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    sendJson(res, 404, { error: "Source file not found" });
    return;
  }

  const targetName = buildRenamableFilename(oldName, requestedName);
  if (!targetName) {
    sendJson(res, 400, { error: "Target extension must be PNG/JPG/JPEG/PDF" });
    return;
  }
  if (targetName === DOC_LINKS_FILENAME) {
    sendJson(res, 400, { error: "Protected file name" });
    return;
  }
  if (targetName === oldName) {
    sendJson(res, 200, { name: oldName });
    return;
  }

  const destination = makeUniquePath(countryDir, targetName);
  fs.renameSync(sourcePath, destination);
  sendJson(res, 200, { name: path.basename(destination) });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/api/list") {
    await handleListRequest(requestUrl, res);
    return;
  }

  if (requestUrl.pathname === "/api/upload") {
    await handleUploadRequest(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/add-links") {
    await handleAddLinksRequest(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/doc-links") {
    await handleDocumentLinksRequest(req, requestUrl, res);
    return;
  }

  if (requestUrl.pathname === "/api/rename-link") {
    await handleRenameDocumentRequest(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/rename-media") {
    await handleRenameMediaRequest(req, res);
    return;
  }

  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const fullPath = path.join(ROOT, decodeURIComponent(requestedPath));
  serveFile(fullPath, res);
});

server.listen(PORT, () => {
  console.log(`Arq Nova site running at http://localhost:${PORT}`);
});
