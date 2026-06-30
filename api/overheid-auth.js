const crypto = require("node:crypto");
const store = require("./portal-store.js");

const DISCORD_API = "https://discord.com/api/v10";
const SESSION_COOKIE = "ar_overheid_session";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const APP_NAME = "overheid";
const DEFAULT_ADMIN_ROLE_ID = "1518384682532737165";

const services = {
  politie: {
    label: "Politie",
    path: "/overheid/politie/index.html",
    roleEnv: "DISCORD_ROLE_POLITIE",
    closed: process.env.DISCORD_SERVICE_POLITIE_OPEN === "false",
  },
  kmar: {
    label: "KMar / Justitie",
    path: "/overheid/diensten/kmar.html",
    roleEnv: "DISCORD_ROLE_KMAR",
    closed: process.env.DISCORD_SERVICE_KMAR_OPEN !== "true",
  },
  ambulance: {
    label: "Ambulance",
    path: "/overheid/diensten/ambulance.html",
    roleEnv: "DISCORD_ROLE_AMBULANCE",
    closed: process.env.DISCORD_SERVICE_AMBULANCE_OPEN !== "true",
  },
  pechhulp: {
    label: "ANWB / Pechhulp",
    path: "/overheid/diensten/pechhulp.html",
    roleEnv: "DISCORD_ROLE_PECHHULP",
    closed: process.env.DISCORD_SERVICE_PECHHULP_OPEN !== "true",
  },
};

const states = new Map();
const sessions = new Map();
let serviceSettingsCache = { expiresAt: 0, value: [] };

function splitIds(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host || "127.0.0.1:3000"}`;
}

function getPublicUrl(req) {
  return (process.env.OVERHEID_PUBLIC_URL || getOrigin(req)).replace(/\/+$/, "");
}

function getConfig(req) {
  const publicUrl = getPublicUrl(req);
  const roleMap = Object.fromEntries(
    Object.entries(services).map(([id, service]) => [id, splitIds(process.env[service.roleEnv])])
  );

  return {
    clientId: process.env.DISCORD_CLIENT_ID || "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    guildId: process.env.DISCORD_GUILD_ID || "",
    redirectUri: `${publicUrl}/api/overheid/auth/callback`,
    adminRoleIds: splitIds(process.env.DISCORD_ROLE_ADMIN || process.env.DISCORD_ROLE_STAFF || DEFAULT_ADMIN_ROLE_ID),
    roleMap,
  };
}

function hasRequiredConfig(config) {
  return Boolean(config.clientId && config.clientSecret && config.guildId);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function redirect(res, location, statusCode = 302, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader("Location", location);
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.end();
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function randomId() {
  return crypto.randomBytes(24).toString("base64url");
}

function cleanup() {
  const now = Date.now();
  for (const [key, value] of states) {
    if (value.expiresAt <= now) states.delete(key);
  }
  for (const [key, value] of sessions) {
    if (value.expiresAt <= now) sessions.delete(key);
  }
}

function getSession(req) {
  cleanup();
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return { id: sessionId, ...session };
}

function getAllowedServices(roleIds, config) {
  const roles = new Set(roleIds || []);
  const isAdmin = config.adminRoleIds.some((roleId) => roles.has(roleId));
  return Promise.all(Object.entries(config.roleMap).map(async ([serviceId, requiredRoles]) => {
    if (await isServiceClosed(serviceId)) return null;
    if (isAdmin || requiredRoles.some((roleId) => roles.has(roleId))) return serviceId;
    return null;
  })).then((items) => items.filter(Boolean));
}

async function getServiceSettings() {
  if (serviceSettingsCache.expiresAt > Date.now()) return serviceSettingsCache.value;
  if (!store.isConfigured()) {
    serviceSettingsCache = { expiresAt: Date.now() + 30 * 1000, value: [] };
    return [];
  }
  try {
    const value = await store.readCollection(APP_NAME, "service-settings");
    serviceSettingsCache = { expiresAt: Date.now() + 30 * 1000, value };
    return value;
  } catch {
    serviceSettingsCache = { expiresAt: Date.now() + 30 * 1000, value: [] };
    return [];
  }
}

async function isServiceClosed(serviceId) {
  if (services[serviceId]?.closed) return true;
  const setting = (await getServiceSettings()).find((item) => item.serviceId === serviceId);
  if (setting?.status) return setting.status.toLowerCase() === "gesloten";
  return false;
}

function isAdminSession(session) {
  if (!session) return false;
  const adminRoleIds = splitIds(process.env.DISCORD_ROLE_ADMIN || process.env.DISCORD_ROLE_STAFF || DEFAULT_ADMIN_ROLE_ID);
  if (!adminRoleIds.length) return true;
  const roles = new Set(session.roles || []);
  return adminRoleIds.some((roleId) => roles.has(roleId));
}

function getServiceFromPath(pathname) {
  if (pathname.startsWith("/overheid/politie/")) return "politie";
  if (pathname === "/overheid/politie") return "politie";

  const match = pathname.match(/^\/overheid\/diensten\/([^/.]+)\.html$/);
  if (match && services[match[1]]) return match[1];

  return null;
}

function sanitizeNext(next, service) {
  if (typeof next === "string" && next.startsWith("/overheid/") && !next.startsWith("//")) {
    return next;
  }

  return services[service]?.path || "/overheid/";
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || response.statusText };
  }
}

async function exchangeCode(code, config) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Discord token exchange mislukt");
  }

  return payload;
}

async function fetchDiscordJson(pathname, accessToken) {
  const response = await fetch(`${DISCORD_API}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Discord API aanvraag mislukt");
  }
  return payload;
}

function createSession(res, req, user, member, allowedServices) {
  const sessionId = randomId();
  const secure = getPublicUrl(req).startsWith("https://");
  const session = {
    user: {
      id: user.id,
      username: user.global_name || user.username,
      tag: user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : user.username,
      avatar: user.avatar || null,
    },
    roles: member.roles || [],
    services: allowedServices,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  sessions.set(sessionId, session);
  res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, sessionId, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure,
  }));
  return session;
}

async function handleLogin(req, res, url) {
  const config = getConfig(req);
  if (!hasRequiredConfig(config)) {
    redirect(res, "/overheid/?error=config");
    return;
  }

  const service = services[url.searchParams.get("service")] ? url.searchParams.get("service") : "";
  const next = sanitizeNext(url.searchParams.get("next"), service);
  if (service && await isServiceClosed(service)) {
    redirect(res, `/overheid/?error=closed&service=${service}`);
    return;
  }
  const session = getSession(req);

  if (session && service) {
    redirect(res, session.services.includes(service) ? next : `/overheid/?error=no_access&service=${service}`);
    return;
  }

  if (session && !service) {
    redirect(res, next || "/overheid/?login=success");
    return;
  }

  const state = randomId();
  states.set(state, {
    service,
    next,
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "identify guilds.members.read",
    state,
  });

  redirect(res, `https://discord.com/oauth2/authorize?${params}`);
}

async function handleCallback(req, res, url) {
  const config = getConfig(req);
  const error = url.searchParams.get("error");
  if (error) {
    redirect(res, `/overheid/?error=${encodeURIComponent(error)}`);
    return;
  }

  const code = url.searchParams.get("code");
  const stateId = url.searchParams.get("state");
  const state = stateId ? states.get(stateId) : null;
  if (!code || !state || state.expiresAt <= Date.now()) {
    redirect(res, "/overheid/?error=state");
    return;
  }
  states.delete(stateId);

  try {
    const token = await exchangeCode(code, config);
    const [user, member] = await Promise.all([
      fetchDiscordJson("/users/@me", token.access_token),
      fetchDiscordJson(`/users/@me/guilds/${config.guildId}/member`, token.access_token),
    ]);
    const allowedServices = await getAllowedServices(member.roles, config);
    createSession(res, req, user, member, allowedServices);

    if (state.service) {
      redirect(res, allowedServices.includes(state.service) ? state.next : `/overheid/?error=no_access&service=${state.service}`);
      return;
    }

    redirect(res, state.next || "/overheid/?login=success");
  } catch (error) {
    redirect(res, `/overheid/?error=discord&message=${encodeURIComponent(error.message)}`);
  }
}

function handleMe(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 200, { loggedIn: false, services: [], labels: Object.fromEntries(Object.entries(services).map(([id, service]) => [id, service.label])) });
    return;
  }

  sendJson(res, 200, {
    loggedIn: true,
    user: session.user,
    services: session.services,
    isAdmin: isAdminSession(session),
    labels: Object.fromEntries(Object.entries(services).map(([id, service]) => [id, service.label])),
  });
}

function handleLogout(req, res) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (sessionId) sessions.delete(sessionId);
  res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure: getPublicUrl(req).startsWith("https://") }));
  redirect(res, "/overheid/?logout=1");
}

async function handle(req, res, url) {
  if (url.pathname === "/api/overheid/auth/login") {
    await handleLogin(req, res, url);
    return true;
  }

  if (url.pathname === "/api/overheid/auth/callback") {
    await handleCallback(req, res, url);
    return true;
  }

  if (url.pathname === "/api/overheid/auth/me") {
    handleMe(req, res);
    return true;
  }

  if (url.pathname === "/api/overheid/auth/logout") {
    handleLogout(req, res);
    return true;
  }

  return false;
}

async function requirePortalAccess(req, res, url) {
  if (url.pathname === "/overheid/vog.html") {
    const session = getSession(req);
    if (!session) {
      const next = encodeURIComponent(url.pathname + url.search);
      redirect(res, `/api/overheid/auth/login?next=${next}`);
      return false;
    }
    return true;
  }

  if (url.pathname === "/overheid/admin.html" || url.pathname.startsWith("/overheid/admin/")) {
    const session = getSession(req);
    if (!session) {
      const next = encodeURIComponent(url.pathname + url.search);
      redirect(res, `/api/overheid/auth/login?next=${next}`);
      return false;
    }
    if (!isAdminSession(session)) {
      redirect(res, "/overheid/?error=no_access&service=beheer");
      return false;
    }
    return true;
  }

  const service = getServiceFromPath(url.pathname);
  if (!service) return true;

  if (await isServiceClosed(service)) {
    redirect(res, `/overheid/?error=closed&service=${service}`);
    return false;
  }

  const session = getSession(req);
  if (!session) {
    const next = encodeURIComponent(url.pathname + url.search);
    redirect(res, `/api/overheid/auth/login?service=${service}&next=${next}`);
    return false;
  }

  if (!session.services.includes(service)) {
    redirect(res, `/overheid/?error=no_access&service=${service}`);
    return false;
  }

  return true;
}

module.exports = {
  getSession,
  handle,
  isAdminSession,
  requirePortalAccess,
  services,
};
