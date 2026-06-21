const fs = require("node:fs/promises");
const path = require("node:path");

function getConfig() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const table = process.env.SUPABASE_RECORDS_TABLE || "portal_records";
  return { url, key, table };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.url && config.key);
}

function headers(extra = {}) {
  const config = getConfig();
  const base = {
    apikey: config.key,
    "Content-Type": "application/json",
    ...extra,
  };
  if (!config.key.startsWith("sb_secret_") && !config.key.startsWith("sb_publishable_")) {
    base.Authorization = `Bearer ${config.key}`;
  }
  return base;
}

async function request(method, query, body, extraHeaders) {
  const config = getConfig();
  const response = await fetch(`${config.url}/rest/v1/${config.table}${query}`, {
    method,
    headers: headers(extraHeaders),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.message || payload?.error || response.statusText;
    throw new Error(`Supabase: ${message}`);
  }
  return payload;
}

async function readCollection(app, type) {
  const query = `?app=eq.${encodeURIComponent(app)}&type=eq.${encodeURIComponent(type)}&select=record_id,payload,updated_at&order=updated_at.desc`;
  const rows = await request("GET", query);
  return Array.isArray(rows) ? rows.map((row) => row.payload).filter(Boolean) : [];
}

async function writeCollection(app, type, items) {
  const safeItems = Array.isArray(items) ? items : [];
  const existing = await request(
    "GET",
    `?app=eq.${encodeURIComponent(app)}&type=eq.${encodeURIComponent(type)}&select=record_id`
  );
  const keep = new Set(safeItems.map((item) => String(item.id || item.recordId || "")).filter(Boolean));
  const removeIds = (Array.isArray(existing) ? existing : [])
    .map((row) => row.record_id)
    .filter((id) => !keep.has(id));

  if (removeIds.length) {
    await request(
      "DELETE",
      `?app=eq.${encodeURIComponent(app)}&type=eq.${encodeURIComponent(type)}&record_id=in.(${removeIds.map(encodeURIComponent).join(",")})`
    );
  }

  if (!safeItems.length) return;

  const now = new Date().toISOString();
  const rows = safeItems.map((item) => ({
    app,
    type,
    record_id: String(item.id || item.recordId),
    payload: item,
    updated_at: item.updatedAt || item.updated_at || now,
  }));

  await request("POST", "?on_conflict=app,type,record_id", rows, {
    Prefer: "resolution=merge-duplicates,return=minimal",
  });
}

async function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(fallback) ? (Array.isArray(parsed) ? parsed : fallback) : parsed;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

module.exports = {
  isConfigured,
  readCollection,
  readJsonFile,
  writeCollection,
  writeJsonFile,
};
