const crypto = require("node:crypto");
const path = require("node:path");
const overheidAuth = require("./overheid-auth.js");
const store = require("./portal-store.js");

const DATA_DIR = process.env.OVERHEID_DATA_DIR
  ? path.resolve(process.env.OVERHEID_DATA_DIR)
  : path.resolve(__dirname, "..", "data");
const APP_NAME = "overheid";
const BODY_LIMIT = 1024 * 1024;
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_CACHE_TTL_MS = 5 * 60 * 1000;
const discordMemberCache = new Map();

const files = {
  dossiers: path.join(DATA_DIR, "overheid-dossiers.json"),
  tasks: path.join(DATA_DIR, "overheid-tasks.json"),
  applications: path.join(DATA_DIR, "overheid-applications.json"),
  certificates: path.join(DATA_DIR, "overheid-certificates.json"),
  quizzes: path.join(DATA_DIR, "overheid-quizzes.json"),
  "quiz-attempts": path.join(DATA_DIR, "overheid-quiz-attempts.json"),
  handbooks: path.join(DATA_DIR, "overheid-handbooks.json"),
  "service-settings": path.join(DATA_DIR, "overheid-service-settings.json"),
  "training-plans": path.join(DATA_DIR, "overheid-training-plans.json"),
  "vog-requests": path.join(DATA_DIR, "overheid-vog-requests.json"),
  logs: path.join(DATA_DIR, "overheid-logs.json"),
};

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function cleanField(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function splitList(value, maxItems = 16, maxLength = 180) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanField(item, maxLength)).filter(Boolean).slice(0, maxItems);
  }
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => cleanField(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sortNewest(items) {
  return items.sort((a, b) => String(b.createdAt || b.updatedAt || b.issuedAt || "").localeCompare(String(a.createdAt || a.updatedAt || a.issuedAt || "")));
}

function certificateCode(service = "POL") {
  const prefix = cleanField(service, 24).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "AMRP";
  return `AMRP-${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function publicPortalUrl() {
  return String(process.env.OVERHEID_PUBLIC_URL || "").replace(/\/+$/, "");
}

function discordBotToken() {
  return String(process.env.OVERHEID_DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || "").trim();
}

function discordGuildId() {
  return String(process.env.DISCORD_GUILD_ID || "").trim();
}

function vogChannelId() {
  return String(process.env.VOG_KANAAL_ID || "1513290970668466329").trim();
}

function vogReviewRoleId() {
  return String(process.env.VOG_REVIEW_ROLE_ID || process.env.ALLOWED_ROLE_ID || "1504849453268598875").trim();
}

function avatarUrlFromMember(member, guildId) {
  const user = member.user || {};
  if (member.avatar && user.id && guildId) {
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.png?size=128`;
  }
  if (user.avatar && user.id) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }
  if (!user.id) return "https://cdn.discordapp.com/embed/avatars/0.png";
  const index = Number(BigInt(user.id) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function publicDiscordMember(member, guildId) {
  const user = member.user || {};
  return {
    id: user.id || "",
    name: member.nick || user.global_name || user.username || "Onbekende gebruiker",
    username: user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : user.username || "",
    avatar: avatarUrlFromMember(member, guildId),
  };
}

function getBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(req.headers["x-api-key"] || "").trim();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireBotApiKey(req, res) {
  const expected = process.env.BOT_CERTIFICATE_API_KEY || "";
  if (!expected) {
    sendJson(res, 503, { ok: false, message: "BOT_CERTIFICATE_API_KEY ontbreekt in Render." });
    return false;
  }
  if (!safeEqual(getBearerToken(req), expected)) {
    sendJson(res, 401, { ok: false, message: "Ongeldige bot API key." });
    return false;
  }
  return true;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        reject(new Error("Body is te groot."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Ongeldige JSON."));
      }
    });
    req.on("error", reject);
  });
}

async function readItems(type) {
  if (store.isConfigured()) return store.readCollection(APP_NAME, type);
  return store.readJsonFile(files[type], []);
}

async function writeItems(type, items) {
  if (store.isConfigured()) {
    await store.writeCollection(APP_NAME, type, items);
    return;
  }
  await store.writeJsonFile(files[type], items);
}

function requireSession(req, res) {
  const session = overheidAuth.getSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, message: "Niet ingelogd." });
    return null;
  }
  return session;
}

function requireAdmin(req, res) {
  const session = requireSession(req, res);
  if (!session) return null;
  if (!overheidAuth.isAdminSession(session)) {
    sendJson(res, 403, { ok: false, message: "Geen beheerrechten." });
    return null;
  }
  return session;
}

async function addLog(session, action, target, detail = "", changes = null) {
  const logs = await readItems("logs");
  logs.push({
    id: crypto.randomUUID(),
    action: cleanField(action, 120),
    target: cleanField(target, 160),
    detail: cleanField(detail, 700),
    changes,
    createdAt: new Date().toISOString(),
    createdBy: session?.user || null,
  });
  await writeItems("logs", logs.slice(-300));
}

function normalizeDossier(body, session, existing = {}) {
  const subjectName = cleanField(body.subjectName || body.playerName, 120);
  const description = cleanField(body.description, 2200);
  if (!subjectName || !description) throw new Error("Naam en beschrijving zijn verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    service: cleanField(body.service, 80) || "Politie",
    subjectName,
    discordId: cleanField(body.discordId, 40),
    category: cleanField(body.category, 80) || "Notitie",
    severity: cleanField(body.severity, 40) || "Laag",
    status: cleanField(body.status, 40) || "Open",
    assignedTo: cleanField(body.assignedTo, 120),
    tags: splitList(body.tags, 12, 80),
    evidenceLinks: splitList(body.evidenceLinks || body.evidence, 10, 260),
    notes: splitList(body.notes, 20, 500),
    action: cleanField(body.action, 1000),
    description,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeTask(body, session, existing = {}) {
  const title = cleanField(body.title, 160);
  if (!title) throw new Error("Titel is verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    title,
    service: cleanField(body.service, 80) || "Algemeen",
    type: cleanField(body.type, 80) || "Opleiding",
    assignee: cleanField(body.assignee, 120),
    priority: cleanField(body.priority, 40) || "Normaal",
    status: cleanField(body.status, 40) || "Open",
    dueDate: cleanField(body.dueDate, 40),
    description: cleanField(body.description, 1800),
    tags: splitList(body.tags, 10, 80),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeApplication(body, session, existing = {}) {
  const applicantName = cleanField(body.applicantName || body.name, 120);
  if (!applicantName) throw new Error("Naam kandidaat is verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    applicantName,
    discordId: cleanField(body.discordId, 40),
    service: cleanField(body.service, 80) || "Politie",
    status: cleanField(body.status, 60) || "Nieuw",
    reviewer: cleanField(body.reviewer, 120),
    interviewAt: cleanField(body.interviewAt, 80),
    training: splitList(body.training, 12, 120),
    notes: cleanField(body.notes, 1800),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeCertificate(body, session, existing = {}) {
  const holderName = cleanField(body.holderName || body.name, 120);
  const quizTitle = cleanField(body.quizTitle || body.title, 180);
  if (!holderName || !quizTitle) throw new Error("Naam en toets zijn verplicht.");
  const now = new Date().toISOString();
  const score = Number(body.score ?? existing.score ?? 0);
  const maxScore = Math.max(1, Number(body.maxScore ?? body.max ?? existing.maxScore ?? 1));
  const percent = Math.round((score / maxScore) * 100);
  const code = cleanField(body.code || existing.code || certificateCode(body.service || existing.service), 80);
  return {
    id: existing.id || code,
    code,
    service: cleanField(body.service, 80) || "Politie",
    holderName,
    discordId: cleanField(body.discordId, 40),
    quizTitle,
    score,
    maxScore,
    percent,
    status: cleanField(body.status, 40) || "Geldig",
    issuedAt: existing.issuedAt || body.issuedAt || now,
    expiresAt: cleanField(body.expiresAt, 80),
    verifierNotes: cleanField(body.verifierNotes || body.notes, 1200),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeQuiz(body, session, existing = {}) {
  const title = cleanField(body.title, 180);
  if (!title) throw new Error("Titel is verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    title,
    service: cleanField(body.service, 80) || "Politie",
    rank: cleanField(body.rank, 80) || "Basis",
    passPercent: Number(body.passPercent || existing.passPercent || 80),
    status: cleanField(body.status, 40) || "Actief",
    description: cleanField(body.description, 1200),
    questionsText: cleanField(body.questionsText, 5000),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeQuizAttempt(body, session, existing = {}) {
  const quizTitle = cleanField(body.quizTitle || body.title, 180);
  if (!quizTitle) throw new Error("Toetsnaam is verplicht.");
  const now = new Date().toISOString();
  const score = Number(body.score ?? existing.score ?? 0);
  const maxScore = Math.max(1, Number(body.maxScore ?? body.max ?? existing.maxScore ?? 100));
  const percent = Number.isFinite(Number(body.percent)) ? Number(body.percent) : Math.round((score / maxScore) * 100);
  const passPercent = Number(body.passPercent || existing.passPercent || 90);
  const passed = body.passed === true || body.passed === "true" || percent >= passPercent;
  return {
    id: existing.id || crypto.randomUUID(),
    service: cleanField(body.service, 80) || "Politie",
    quizId: cleanField(body.quizId, 120),
    quizTitle,
    holderName: cleanField(body.holderName || session.user?.username, 120) || "Amsterdam Roleplay medewerker",
    discordId: cleanField(body.discordId || session.user?.id, 40),
    score,
    maxScore,
    percent,
    passPercent,
    passed,
    status: cleanField(body.status, 60) || (passed ? "Geslaagd" : "Niet geslaagd"),
    questionScores: Array.isArray(body.questionScores) ? body.questionScores.map(Number).slice(0, 30) : [],
    answers: Array.isArray(body.answers)
      ? body.answers.slice(0, 30).map((item) => ({
          question: cleanField(item.question, 260),
          answer: cleanField(item.answer, 800),
          score: Number(item.score || 0),
        }))
      : [],
    certificateCode: cleanField(body.certificateCode, 100),
    cooldownUntil: cleanField(body.cooldownUntil, 80),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeHandbook(body, session, existing = {}) {
  const title = cleanField(body.title, 180);
  const url = cleanField(body.url, 500);
  if (!title || !url) throw new Error("Titel en link zijn verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    title,
    service: cleanField(body.service, 80) || "Politie",
    category: cleanField(body.category, 80) || "Handboek",
    version: cleanField(body.version, 40),
    status: cleanField(body.status, 40) || "Actief",
    url,
    notes: cleanField(body.notes, 1200),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeServiceSetting(body, session, existing = {}) {
  const serviceId = cleanField(body.serviceId || body.id, 40).toLowerCase();
  if (!serviceId) throw new Error("Dienst ID is verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || serviceId,
    serviceId,
    title: cleanField(body.title, 120) || serviceId,
    status: cleanField(body.status, 40) || "Open",
    roleId: cleanField(body.roleId, 60),
    notes: cleanField(body.notes, 1200),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeTrainingPlan(body, session, existing = {}) {
  const title = cleanField(body.title, 180);
  if (!title) throw new Error("Titel is verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    title,
    service: cleanField(body.service, 80) || "Politie",
    instructor: cleanField(body.instructor, 120),
    participants: splitList(body.participants, 30, 120),
    plannedAt: cleanField(body.plannedAt, 80),
    status: cleanField(body.status, 40) || "Gepland",
    notes: cleanField(body.notes, 1800),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function hasMeaningfulReason(reason) {
  const value = cleanField(reason, 900).toLowerCase();
  const words = value
    .replace(/[^a-z0-9À-ÿ\s-]/gi, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3);
  if (words.length < 5) return false;
  if (/^(test|asdf|geen idee|idk|nvt|nee|ja)[\s.!?]*$/i.test(value)) return false;
  return true;
}

function vogRoleId() {
  return String(process.env.VOG_ROLE_ID || process.env.DISCORD_ROLE_VOG || "1504849665542062250").trim();
}

function vogGuildId() {
  return String(process.env.VOG_DISCORD_GUILD_ID || process.env.SUPPORT_DISCORD_GUILD_ID || process.env.DISCORD_GUILD_ID || "").trim();
}

function assessVogApplication(body) {
  const reason = cleanField(body.reason, 900);
  const criminalRecord = cleanField(body.criminalRecord, 40).toLowerCase();
  const criminalDetails = cleanField(body.criminalDetails, 900);
  const lowerReason = reason.toLowerCase();
  const lowerDetails = criminalDetails.toLowerCase();
  const noCriminalRecord = ["nee", "geen", "false", "no", "0"].includes(criminalRecord);
  const badCriminalWords = ["ja", "ban", "straf", "crimineel", "overtreding", "arrest", "gevangen", "witwas", "moord", "diefstal", "wapen"];
  const hasBadRecord = !noCriminalRecord || badCriminalWords.some((word) => lowerDetails.includes(word));
  const serviceWords = {
    politie: ["politie", "agent", "korps", "handhaving", "surveillance", "arrestatie"],
    kmar: ["kmar", "marechaussee", "justitie", "rechtbank", "bewaking", "grens"],
    ambulance: ["ambulance", "zorg", "medisch", "ehbo", "hulpverlening", "patient", "patiënt"],
    pechhulp: ["pechhulp", "anwb", "monteur", "voertuig", "reparatie", "takel"],
    advocatuur: ["advocaat", "advocatuur", "juridisch", "recht", "client", "cliënt"],
    algemeen: ["overheid", "dienst", "sollicitatie", "support", "functie", "veilig"],
  };
  const allServiceWords = Object.values(serviceWords).flat();
  const generalWords = ["sollicitatie", "worden", "functie", "dienst", "overheid", "vertrouwen", "veilig", "roleplay", "amsterdam"];
  const matchesPurpose = [...allServiceWords, ...generalWords].some((word) => lowerReason.includes(word));

  if (hasBadRecord) {
    return { approved: false, reason: "Afgewezen omdat er strafbare feiten zijn opgegeven." };
  }
  if (!hasMeaningfulReason(reason) || reason.length < 45) {
    return { approved: false, reason: "Afgewezen omdat de reden te kort of niet duidelijk genoeg is." };
  }
  if (!matchesPurpose) {
    return { approved: false, reason: "Afgewezen omdat de reden niet duidelijk aansluit bij Politie, KMar, Ambulance, Pechhulp, Advocatuur of overheid." };
  }
  return { approved: true, reason: "Automatisch goedgekeurd op basis van duidelijke reden en geen strafblad." };
}

function normalizeVogRequest(body, session) {
  const assessment = assessVogApplication(body);
  const reason = cleanField(body.reason, 900);
  const criminalRecord = cleanField(body.criminalRecord, 40).toLowerCase();
  const criminalDetails = cleanField(body.criminalDetails, 900);
  if (!reason) throw new Error("Reden van aanvraag is verplicht.");
  if (!criminalRecord) throw new Error("Kies of je een strafblad hebt.");

  return {
    status: assessment.approved ? "approved" : "denied",
    datum: new Date().toLocaleString("nl-NL"),
    volledige_naam: session.user?.username || "Discord gebruiker",
    geboortedatum: "Ingediend via website",
    reden_aanvraag: reason,
    strafblad: criminalRecord === "nee" ? "Geen" : (criminalDetails || "Ja"),
    datum_aanvraag: new Date().toISOString(),
    goedgekeurd_door: assessment.approved ? "Website controle" : null,
    datum_goedkeuring: assessment.approved ? new Date().toISOString() : null,
    afgewezen_reden: assessment.approved ? null : assessment.reason,
  };
}

function supabaseConfig() {
  return {
    url: String(process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
    key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  };
}

async function supabaseVogRequest(method, query, body, extraHeaders = {}) {
  const config = supabaseConfig();
  if (!config.url || !config.key) throw new Error("Supabase mist in Render.");
  const headers = {
    apikey: config.key,
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (!config.key.startsWith("sb_secret_") && !config.key.startsWith("sb_publishable_")) {
    headers.Authorization = `Bearer ${config.key}`;
  }
  const response = await fetch(`${config.url}/rest/v1/vog_aanvragen${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.message || payload?.error || "Supabase VOG aanvraag mislukt.");
  return payload;
}

async function readVogRequest(userId) {
  if (!store.isConfigured()) {
    const items = await readItems("vog-requests");
    return items.find((item) => item.user_id === userId) || null;
  }
  const rows = await supabaseVogRequest("GET", `?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function readVogRequests() {
  if (!store.isConfigured()) return readItems("vog-requests");
  const rows = await supabaseVogRequest("GET", "?select=*&order=datum_aanvraag.desc");
  return Array.isArray(rows) ? rows : [];
}

async function writeVogRequest(userId, payload) {
  if (!store.isConfigured()) {
    const items = await readItems("vog-requests");
    const next = items.filter((item) => item.user_id !== userId);
    next.push({ user_id: userId, ...payload });
    await writeItems("vog-requests", next);
    return next.find((item) => item.user_id === userId);
  }
  const existing = await readVogRequest(userId);
  if (existing) {
    const rows = await supabaseVogRequest("PATCH", `?user_id=eq.${encodeURIComponent(userId)}`, payload, { Prefer: "return=representation" });
    return Array.isArray(rows) ? rows[0] || { user_id: userId, ...payload } : { user_id: userId, ...payload };
  }
  const rows = await supabaseVogRequest("POST", "", [{ user_id: userId, ...payload }], { Prefer: "return=representation" });
  return Array.isArray(rows) ? rows[0] || { user_id: userId, ...payload } : { user_id: userId, ...payload };
}

async function notifyVogRequest(session, item) {
  const token = discordBotToken();
  const channelId = vogChannelId();
  if (!token || !channelId) return "Geen Discord melding verstuurd: bot-token of VOG kanaal mist.";

  const reviewerRole = vogReviewRoleId();
  const mention = reviewerRole ? `<@&${reviewerRole}>` : "";
  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: mention,
      embeds: [{
        title: "NIEUWE VOG AANVRAAG - WEBSITE",
        color: 0xf2b84b,
        description: `Aanvrager: <@${session.user?.id}> (${session.user?.id})\nBron: Overheid website`,
        fields: [
          { name: "Naam", value: cleanField(item.volledige_naam, 900) || "Onbekend", inline: false },
          { name: "Reden van aanvraag", value: cleanField(item.reden_aanvraag, 900) || "Geen reden", inline: false },
          { name: "Strafblad", value: cleanField(item.strafblad, 900) || "Onbekend", inline: false },
          { name: "Actie", value: `/vog goedkeuren ${session.user?.id} of /vog afwijzen ${session.user?.id}`, inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    }),
  });

  if (!response.ok) {
    let message = "Discord melding kon niet verstuurd worden.";
    try {
      const payload = await response.json();
      message = payload.message || message;
    } catch {}
    return message;
  }
  return "Discord melding verstuurd naar VOG kanaal.";
}

async function assignVogRole(userId) {
  const token = discordBotToken();
  const guildId = vogGuildId();
  const roleId = vogRoleId();
  if (!token || !guildId || !roleId) return "VOG goedgekeurd, maar rol niet gegeven: Discord bot-token/guild/role mist in Render.";

  const response = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: "",
  });
  if (response.status === 204) return "VOG goedgekeurd en Discord rol toegekend.";

  let message = "VOG goedgekeurd, maar Discord rol kon niet toegekend worden.";
  try {
    const payload = await response.json();
    message = `${message} ${payload.message || ""}`.trim();
  } catch {}
  return message;
}

async function handleVogRequest(req, res) {
  const session = requireSession(req, res);
  if (!session) return true;

  if (req.method === "GET") {
    const request = await readVogRequest(session.user?.id);
    sendJson(res, 200, { ok: true, requests: request ? [request] : [] });
    return true;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "Methode niet toegestaan." });
    return true;
  }

  try {
    const body = await readBody(req);
    const existing = await readVogRequest(session.user?.id);
    if (existing?.status === "approved") {
      sendJson(res, 409, { ok: false, message: "Je VOG is al goedgekeurd." });
      return true;
    }
    if (existing?.status === "pending") {
      sendJson(res, 409, { ok: false, message: "Je hebt al een VOG aanvraag in behandeling." });
      return true;
    }

    const item = await writeVogRequest(session.user?.id, normalizeVogRequest(body, session));
    let resultMessage = item.status === "approved" ? "VOG goedgekeurd." : item.afgewezen_reden || "VOG afgewezen.";
    if (item.status === "approved") {
      resultMessage = await assignVogRole(session.user?.id);
    }
    await addLog(session, "VOG aanvraag", session.user?.username || session.user?.id || "Discord gebruiker", `${item.status} via website - ${resultMessage}`);
    sendJson(res, 201, { ok: true, request: item, message: resultMessage });
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message });
  }
  return true;
}

async function handleCollection(req, res, url, options) {
  const session = requireAdmin(req, res);
  if (!session) return true;

  if (url.pathname === options.path && req.method === "GET") {
    sendJson(res, 200, { ok: true, [options.key]: sortNewest(await readItems(options.type)) });
    return true;
  }

  if (url.pathname === options.path && req.method === "POST") {
    try {
      const body = await readBody(req);
      const items = await readItems(options.type);
      const item = options.normalize(body, session);
      const next = items.filter((record) => record.id !== item.id);
      next.push(item);
      await writeItems(options.type, next);
      await addLog(session, `${options.label} toegevoegd`, options.title(item), item.status || item.type || "");
      sendJson(res, 201, { ok: true, item });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message });
    }
    return true;
  }

  const match = url.pathname.match(new RegExp(`^${options.path.replace(/\//g, "\\/")}\\/([^/]+)$`));
  if (!match) return false;

  if (req.method === "PATCH") {
    try {
      const body = await readBody(req);
      const items = await readItems(options.type);
      const index = items.findIndex((item) => item.id === match[1]);
      if (index === -1) {
        sendJson(res, 404, { ok: false, message: `${options.label} niet gevonden.` });
        return true;
      }
      items[index] = options.normalize({ ...items[index], ...body }, session, items[index]);
      await writeItems(options.type, items);
      await addLog(session, `${options.label} bijgewerkt`, options.title(items[index]), items[index].status || "");
      sendJson(res, 200, { ok: true, item: items[index] });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message });
    }
    return true;
  }

  if (req.method === "DELETE") {
    const items = await readItems(options.type);
    const target = items.find((item) => item.id === match[1]);
    const next = items.filter((item) => item.id !== match[1]);
    if (next.length === items.length) {
      sendJson(res, 404, { ok: false, message: `${options.label} niet gevonden.` });
      return true;
    }
    await writeItems(options.type, next);
    await addLog(session, `${options.label} verwijderd`, target ? options.title(target) : match[1]);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function handleIssueCertificate(req, res) {
  const session = requireSession(req, res);
  if (!session) return true;
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "Methode niet toegestaan." });
    return true;
  }
  try {
    const body = await readBody(req);
    const score = Number(body.score || 0);
    const maxScore = Math.max(1, Number(body.maxScore || body.max || 1));
    const percent = Math.round((score / maxScore) * 100);
    const passPercent = Number(body.passPercent || 80);
    if (percent < passPercent) throw new Error("Score is niet hoog genoeg voor een certificaat.");
    const certificates = await readItems("certificates");
    const item = normalizeCertificate({
      service: body.service || "Politie",
      holderName: session.user?.username || "Amsterdam Roleplay medewerker",
      discordId: session.user?.id || "",
      quizTitle: body.quizTitle || body.title || "Kennistoets",
      score,
      maxScore,
      status: "Geldig",
    }, session);
    certificates.push(item);
    await writeItems("certificates", certificates);
    await addLog(session, "Certificaat uitgegeven", item.code, item.quizTitle);
    sendJson(res, 201, { ok: true, certificate: publicCertificate(item) });
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message });
  }
  return true;
}

async function handleIssueQuizAttempt(req, res) {
  const session = requireSession(req, res);
  if (!session) return true;
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "Methode niet toegestaan." });
    return true;
  }
  try {
    const body = await readBody(req);
    const attempts = await readItems("quiz-attempts");
    const item = normalizeQuizAttempt(body, session);
    attempts.push(item);
    await writeItems("quiz-attempts", attempts);
    await addLog(session, "Kennistoets poging", item.quizTitle, `${item.percent}% - ${item.status}`);
    sendJson(res, 201, { ok: true, attempt: item });
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message });
  }
  return true;
}

async function handleBotIssueCertificate(req, res) {
  if (!requireBotApiKey(req, res)) return true;
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "Methode niet toegestaan." });
    return true;
  }
  try {
    const body = await readBody(req);
    const score = Number(body.score || body.percent || 0);
    const maxScore = Math.max(1, Number(body.maxScore || body.max || 100));
    const percent = Math.round((score / maxScore) * 100);
    const passPercent = Number(body.passPercent || body.slagingsgrens || 90);
    if (percent < passPercent) throw new Error("Score is niet hoog genoeg voor een certificaat.");

    const botSession = {
      user: {
        id: "overheid-bot",
        username: cleanField(body.issuedBy || "Overheid Bot", 120),
      },
    };
    const certificates = await readItems("certificates");
    const item = normalizeCertificate({
      service: body.service || "Politie",
      holderName: body.holderName || body.username || body.name,
      discordId: body.discordId || body.userId,
      quizTitle: body.quizTitle || body.trainingName || body.training || body.title,
      score,
      maxScore,
      passPercent,
      status: body.status || "Geldig",
      verifierNotes: body.verifierNotes || body.notes || "Uitgegeven via Discord bot.",
    }, botSession);

    certificates.push(item);
    await writeItems("certificates", certificates);
    await addLog(botSession, "Bot certificaat uitgegeven", item.code, `${item.holderName} - ${item.quizTitle}`);
    sendJson(res, 201, {
      ok: true,
      certificate: publicCertificate(item),
      verifyUrl: `${publicPortalUrl() || ""}/overheid/verify.html?code=${encodeURIComponent(item.code)}`,
    });
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message });
  }
  return true;
}

function publicCertificate(item) {
  if (!item) return null;
  return {
    code: item.code,
    service: item.service,
    holderName: item.holderName,
    discordId: item.discordId,
    quizTitle: item.quizTitle,
    score: item.score,
    maxScore: item.maxScore,
    percent: item.percent,
    status: item.status,
    issuedAt: item.issuedAt,
    expiresAt: item.expiresAt,
  };
}

async function handleVerifyCertificate(req, res, url) {
  const code = cleanField(url.searchParams.get("code"), 100).toUpperCase();
  if (!code) {
    sendJson(res, 400, { ok: false, message: "Vul een certificaatcode in." });
    return true;
  }
  const certificates = await readItems("certificates");
  const certificate = certificates.find((item) => String(item.code || item.id).toUpperCase() === code);
  if (!certificate) {
    sendJson(res, 404, { ok: false, message: "Certificaat niet gevonden." });
    return true;
  }
  sendJson(res, 200, { ok: true, certificate: publicCertificate(certificate) });
  return true;
}

async function handleDiscordMember(req, res, url) {
  const session = requireAdmin(req, res);
  if (!session) return true;

  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, message: "Methode niet toegestaan." });
    return true;
  }

  const id = cleanField(url.searchParams.get("id"), 40).replace(/\D/g, "");
  if (!id) {
    sendJson(res, 400, { ok: false, message: "Discord ID ontbreekt." });
    return true;
  }

  const token = discordBotToken();
  const guildId = discordGuildId();
  if (!token || !guildId) {
    sendJson(res, 503, { ok: false, message: "Discord bot-token of guild ID ontbreekt in Render." });
    return true;
  }

  const cached = discordMemberCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    sendJson(res, 200, { ok: true, member: cached.member, cached: true });
    return true;
  }

  try {
    const response = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${id}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      sendJson(res, response.status === 404 ? 404 : 502, { ok: false, message: "Discord gebruiker kon niet geladen worden." });
      return true;
    }
    const member = publicDiscordMember(await response.json(), guildId);
    discordMemberCache.set(id, { member, expiresAt: Date.now() + DISCORD_CACHE_TTL_MS });
    sendJson(res, 200, { ok: true, member });
  } catch {
    sendJson(res, 502, { ok: false, message: "Discord API niet bereikbaar." });
  }
  return true;
}

async function handlePublicServiceSettings(req, res) {
  const settings = await readItems("service-settings");
  sendJson(res, 200, {
    ok: true,
    services: settings.map((item) => ({
      serviceId: item.serviceId,
      title: item.title,
      status: item.status,
      notes: item.notes,
    })),
  });
  return true;
}

async function handlePublicCollection(req, res, type, key) {
  const items = await readItems(type);
  sendJson(res, 200, {
    ok: true,
    [key]: sortNewest(items).filter((item) => !item.status || item.status === "Actief" || item.status === "Geldig"),
  });
  return true;
}

async function handlePublicQuizzes(req, res) {
  const items = await readItems("quizzes");
  sendJson(res, 200, {
    ok: true,
    quizzes: sortNewest(items).map((item) => ({
      id: item.id,
      title: item.title,
      service: item.service,
      rank: item.rank,
      passPercent: item.passPercent,
      status: item.status,
      description: item.description,
      questionsText: item.status === "Actief" ? item.questionsText : "",
    })),
  });
  return true;
}

async function handleSummary(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return true;
  const [dossiers, tasks, applications, certificates, quizzes, quizAttempts, handbooks, serviceSettings, trainingPlans, vogRequests, logs] = await Promise.all([
    readItems("dossiers"),
    readItems("tasks"),
    readItems("applications"),
    readItems("certificates"),
    readItems("quizzes"),
    readItems("quiz-attempts"),
    readItems("handbooks"),
    readItems("service-settings"),
    readItems("training-plans"),
    readVogRequests(),
    readItems("logs"),
  ]);
  const byService = {};
  for (const item of [...dossiers, ...tasks, ...applications, ...certificates, ...handbooks, ...trainingPlans]) {
    const service = item.service || "Algemeen";
    byService[service] ||= 0;
    byService[service] += 1;
  }
  sendJson(res, 200, {
    ok: true,
    storage: store.isConfigured() ? "supabase" : "json-fallback",
    counts: {
      dossiers: dossiers.length,
      tasks: tasks.length,
      openTasks: tasks.filter((task) => task.status !== "Gesloten").length,
      applications: applications.length,
      openApplications: applications.filter((item) => !["Afgekeurd", "Aangenomen", "Gesloten"].includes(item.status)).length,
      certificates: certificates.length,
      quizzes: quizzes.length,
      quizAttempts: quizAttempts.length,
      failedQuizAttempts: quizAttempts.filter((item) => !item.passed).length,
      handbooks: handbooks.length,
      serviceSettings: serviceSettings.length,
      trainingPlans: trainingPlans.length,
      vogRequests: vogRequests.length,
    },
    byService,
    latestLogs: sortNewest(logs).slice(0, 12),
  });
  return true;
}

async function handle(req, res, url) {
  if (url.pathname === "/api/overheid/vog") return handleVogRequest(req, res);
  if (url.pathname === "/api/overheid/quiz-attempts/issue") return handleIssueQuizAttempt(req, res);
  if (url.pathname === "/api/overheid/certificates/issue") return handleIssueCertificate(req, res);
  if (url.pathname === "/api/overheid/certificates/bot-issue") return handleBotIssueCertificate(req, res);
  if (url.pathname === "/api/overheid/certificates/verify" && req.method === "GET") return handleVerifyCertificate(req, res, url);
  if (url.pathname === "/api/overheid/discord/member") return handleDiscordMember(req, res, url);
  if (url.pathname === "/api/overheid/service-settings/public" && req.method === "GET") return handlePublicServiceSettings(req, res);
  if (url.pathname === "/api/overheid/handbooks/public" && req.method === "GET") return handlePublicCollection(req, res, "handbooks", "handbooks");
  if (url.pathname === "/api/overheid/quizzes/public" && req.method === "GET") return handlePublicQuizzes(req, res);
  if (url.pathname === "/api/overheid/admin/summary" && req.method === "GET") return handleSummary(req, res);

  const collections = [
    { path: "/api/overheid/dossiers", type: "dossiers", key: "dossiers", label: "Dossier", title: (item) => item.subjectName, normalize: normalizeDossier },
    { path: "/api/overheid/tasks", type: "tasks", key: "tasks", label: "Taak", title: (item) => item.title, normalize: normalizeTask },
    { path: "/api/overheid/applications", type: "applications", key: "applications", label: "Sollicitatie", title: (item) => item.applicantName, normalize: normalizeApplication },
    { path: "/api/overheid/certificates", type: "certificates", key: "certificates", label: "Certificaat", title: (item) => item.code, normalize: normalizeCertificate },
    { path: "/api/overheid/quizzes", type: "quizzes", key: "quizzes", label: "Kennistoets", title: (item) => item.title, normalize: normalizeQuiz },
    { path: "/api/overheid/quiz-attempts", type: "quiz-attempts", key: "quizAttempts", label: "Toetspoging", title: (item) => item.quizTitle, normalize: normalizeQuizAttempt },
    { path: "/api/overheid/handbooks", type: "handbooks", key: "handbooks", label: "Handboek", title: (item) => item.title, normalize: normalizeHandbook },
    { path: "/api/overheid/service-settings", type: "service-settings", key: "serviceSettings", label: "Dienstinstelling", title: (item) => item.title, normalize: normalizeServiceSetting },
    { path: "/api/overheid/training-plans", type: "training-plans", key: "trainingPlans", label: "Training", title: (item) => item.title, normalize: normalizeTrainingPlan },
  ];

  for (const options of collections) {
    if (url.pathname.startsWith(options.path)) return handleCollection(req, res, url, options);
  }

  sendJson(res, 404, { ok: false, message: "Overheid API route niet gevonden." });
  return true;
}

module.exports = { handle };
