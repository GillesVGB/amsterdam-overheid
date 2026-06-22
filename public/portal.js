function getLoginErrorMessage(code, service) {
  const serviceLabel = service ? " voor " + service : "";
  const messages = {
    config: "Discord-login is nog niet volledig geconfigureerd.",
    no_access: "Je hebt geen toegang" + serviceLabel + ". Vraag de juiste Discord-rol aan.",
    closed: "Deze dienst is gesloten en kan momenteel niet geopend worden.",
    state: "Login sessie verlopen. Probeer opnieuw.",
    discord: "Discord-login mislukt. Probeer opnieuw.",
    access_denied: "Discord-login is geannuleerd.",
  };
  return messages[code] || "";
}

function initServiceChoice() {
  const panel = document.querySelector("[data-selected-login]");
  const selectedLabel = document.querySelector("[data-selected-service]");
  const loginLink = document.querySelector("[data-service-login]");
  const choices = Array.from(document.querySelectorAll("[data-service-choice]"));
  const status = document.querySelector("[data-auth-status]");

  if (!panel || !selectedLabel || !loginLink || !choices.length) return;

  async function loadServiceSettings() {
    if (window.location.protocol === "file:") return;
    try {
      const response = await fetch("/api/overheid/service-settings/public", { cache: "no-store" });
      const data = await response.json();
      (data.services || []).forEach((service) => {
        const choice = choices.find((item) => item.dataset.serviceChoice === service.serviceId);
        if (!choice) return;
        const closed = String(service.status || "").toLowerCase() === "gesloten";
        choice.dataset.serviceStatus = closed ? "Gesloten" : "Open";
        choice.classList.toggle("is-closed", closed);
        choice.setAttribute("aria-disabled", closed ? "true" : "false");
        const small = choice.querySelector("small");
        if (small) small.textContent = closed ? "Gesloten" : "Selecteer dienst";
      });
    } catch {
      // Statische fallback blijft actief wanneer de API niet bereikbaar is.
    }
  }

  choices.forEach((choice) => {
    choice.addEventListener("click", (event) => {
      event.preventDefault();
      if (choice.classList.contains("is-closed") || choice.dataset.serviceStatus === "Gesloten") {
        if (status) {
          status.textContent = "Deze dienst is gesloten en kan momenteel niet geopend worden.";
          status.classList.add("is-error");
        }
        panel.hidden = true;
        return;
      }

      choices.forEach((item) => item.classList.remove("is-selected"));
      choice.classList.add("is-selected");

      const service = choice.dataset.serviceChoice;
      const label = choice.dataset.serviceLabel || service;
      selectedLabel.textContent = "Gekozen dienst: " + label;
      loginLink.href = "/api/overheid/auth/login?service=" + encodeURIComponent(service);
      panel.hidden = false;

      if (status && !status.classList.contains("is-ok")) {
        status.classList.remove("is-error");
        status.textContent = "Dienst gekozen. Log nu in met Discord om je rol te controleren.";
      }
    });
  });

  loadServiceSettings();
}

async function initAuthStatus() {
  const status = document.querySelector("[data-auth-status]");
  if (window.location.protocol === "file:") return;

  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (status && error) {
    status.textContent = getLoginErrorMessage(error, params.get("service")) || "Er ging iets mis met inloggen.";
    status.classList.add("is-error");
    return;
  }

  try {
    const response = await fetch("/api/overheid/auth/me", { cache: "no-store" });
    const data = await response.json();

    if (!data.loggedIn) {
      try {
        sessionStorage.removeItem("overheidUser");
      } catch {}
      if (!status) return;
      status.textContent = "Niet ingelogd. Kies een dienst om via Discord je rol te checken.";
      return;
    }

    try {
      sessionStorage.setItem("overheidUser", data.user.username);
    } catch {}

    if (!status) return;
    const labels = data.services.map((service) => data.labels?.[service] || service).join(", ");
    status.textContent = "Ingelogd als " + data.user.username + ". Toegang: " + (labels || "geen diensten");
    status.classList.add("is-ok");
  } catch {
    if (!status) return;
    status.textContent = "Loginstatus kon niet geladen worden.";
    status.classList.add("is-error");
  }
}

async function fetchOverheidJson(url, options) {
  const response = await fetch(url, Object.assign({ cache: "no-store" }, options || {}));
  if (response.status === 401) {
    window.location.href = "/api/overheid/auth/login?next=" + encodeURIComponent(window.location.pathname + window.location.search);
    throw new Error("Niet ingelogd.");
  }
  return response.json();
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function textNode(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("nl-BE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

function recordBadge(text) {
  return textNode("span", "status-badge", text);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const discordMemberCache = new Map();

function normalizeDiscordId(value) {
  return String(value || "").replace(/\D/g, "");
}

function fallbackDiscordAvatar(id) {
  try {
    return "https://cdn.discordapp.com/embed/avatars/" + Number(BigInt(id) % 6n) + ".png";
  } catch {
    return "https://cdn.discordapp.com/embed/avatars/0.png";
  }
}

async function loadDiscordMember(id) {
  const discordId = normalizeDiscordId(id);
  if (!discordId || window.location.protocol === "file:") return null;
  if (discordMemberCache.has(discordId)) return discordMemberCache.get(discordId);

  const promise = fetchOverheidJson("/api/overheid/discord/member?id=" + encodeURIComponent(discordId))
    .then((data) => data.ok ? data.member : null)
    .catch(() => null);
  discordMemberCache.set(discordId, promise);
  return promise;
}

function createDiscordUserTag(item) {
  const id = normalizeDiscordId(item.discordId);
  if (!id) return null;

  const wrap = document.createElement("div");
  wrap.className = "discord-tag-row";

  const tag = document.createElement("a");
  tag.className = "discord-user-tag";
  tag.href = "https://discord.com/users/" + encodeURIComponent(id);
  tag.target = "_blank";
  tag.rel = "noopener";
  tag.title = "Open Discord-profiel";

  const avatar = document.createElement("img");
  avatar.src = fallbackDiscordAvatar(id);
  avatar.alt = "";
  tag.appendChild(avatar);

  const copy = document.createElement("span");
  copy.className = "discord-user-copy";
  const name = textNode("strong", "discord-user-name", item.holderName || "Discord gebruiker");
  const handle = textNode("small", "discord-user-handle", "<@" + id + ">");
  copy.appendChild(name);
  copy.appendChild(handle);
  tag.appendChild(copy);
  wrap.appendChild(tag);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "mini-button ghost";
  button.textContent = "Kopieer mention";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("<@" + id + ">");
      button.textContent = "Gekopieerd";
      setTimeout(() => { button.textContent = "Kopieer mention"; }, 1400);
    } catch {
      button.textContent = "<@" + id + ">";
    }
  });
  wrap.appendChild(button);

  loadDiscordMember(id).then((member) => {
    if (!member) return;
    avatar.src = member.avatar || fallbackDiscordAvatar(id);
    name.textContent = member.name || item.holderName || "Discord gebruiker";
    handle.textContent = member.username ? "@" + member.username : "<@" + id + ">";
  });

  return wrap;
}

function createCertificateOwner(item) {
  const block = document.createElement("div");
  block.className = "record-owner";
  block.appendChild(textNode("span", "record-owner-label", "Gemaakt door"));

  const discordTag = createDiscordUserTag(item);
  if (discordTag) {
    block.appendChild(discordTag);
  } else {
    block.appendChild(textNode("strong", "record-owner-name", item.holderName || "Onbekend"));
  }

  return block;
}

function appendRecordBadges(root, items, prefix) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  values.forEach((item) => root.appendChild(recordBadge((prefix || "") + item)));
}

function appendRecordLinks(root, title, links) {
  const values = Array.isArray(links) ? links.filter(Boolean) : [];
  if (!values.length) return;
  const wrap = document.createElement("div");
  wrap.className = "record-link-list";
  wrap.appendChild(textNode("strong", "", title));
  values.forEach((value, index) => {
    const link = document.createElement("a");
    link.href = value;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Bewijs " + (index + 1);
    wrap.appendChild(link);
  });
  root.appendChild(wrap);
}

function appendRecordNotes(root, notes) {
  const values = Array.isArray(notes) ? notes.filter(Boolean) : [];
  if (!values.length) return;
  const wrap = document.createElement("div");
  wrap.className = "record-note-list";
  wrap.appendChild(textNode("strong", "", "Interne notities"));
  values.forEach((value) => wrap.appendChild(textNode("p", "", value)));
  root.appendChild(wrap);
}

const overheidCollections = {
  dossiers: {
    endpoint: "/api/overheid/dossiers",
    key: "dossiers",
    title: (item) => item.subjectName || "Dossier",
    meta: (item) => [item.service, item.category, item.severity, item.status, item.assignedTo && "Aan: " + item.assignedTo].concat(item.tags || []).filter(Boolean),
    body: (item) => item.description || "Geen beschrijving.",
    closeStatus: "Gesloten",
  },
  tasks: {
    endpoint: "/api/overheid/tasks",
    key: "tasks",
    title: (item) => item.title || "Taak",
    meta: (item) => [item.service, item.type, item.priority, item.status, item.assignee && "Aan: " + item.assignee].concat(item.tags || []).filter(Boolean),
    body: (item) => item.description || "Geen beschrijving.",
    closeStatus: "Gesloten",
  },
  applications: {
    endpoint: "/api/overheid/applications",
    key: "applications",
    title: (item) => item.applicantName || "Sollicitatie",
    meta: (item) => [item.service, item.status, item.reviewer && "Reviewer: " + item.reviewer, item.interviewAt && "Gesprek: " + item.interviewAt].concat(item.training || []).filter(Boolean),
    body: (item) => item.notes || "Geen notities.",
    closeStatus: "Gesloten",
  },
  certificates: {
    endpoint: "/api/overheid/certificates",
    key: "certificates",
    title: (item) => item.code || "Certificaat",
    meta: (item) => [item.service, item.status, item.percent + "%", item.issuedAt && "Uitgegeven: " + formatDate(item.issuedAt)].filter(Boolean),
    body: (item) => [item.quizTitle, item.verifierNotes].filter(Boolean).join("\n\n") || "Geen notities.",
    closeStatus: "Ingetrokken",
  },
  quizzes: {
    endpoint: "/api/overheid/quizzes",
    key: "quizzes",
    title: (item) => item.title || "Kennistoets",
    meta: (item) => [item.service, item.rank, item.status, "Slagen: " + (item.passPercent || 80) + "%"].filter(Boolean),
    body: (item) => item.description || item.questionsText || "Geen beschrijving.",
    closeStatus: "Inactief",
  },
  handbooks: {
    endpoint: "/api/overheid/handbooks",
    key: "handbooks",
    title: (item) => item.title || "Handboek",
    meta: (item) => [item.service, item.category, item.version && "Versie " + item.version, item.status].filter(Boolean),
    body: (item) => item.notes || item.url || "Geen notities.",
    closeStatus: "Inactief",
  },
  serviceSettings: {
    endpoint: "/api/overheid/service-settings",
    key: "serviceSettings",
    title: (item) => item.title || item.serviceId || "Dienst",
    meta: (item) => [item.serviceId, item.status, item.roleId && "Rol: " + item.roleId].filter(Boolean),
    body: (item) => item.notes || "Geen notities.",
  },
  trainingPlans: {
    endpoint: "/api/overheid/training-plans",
    key: "trainingPlans",
    title: (item) => item.title || "Training",
    meta: (item) => [item.service, item.status, item.instructor && "Docent: " + item.instructor, item.plannedAt && "Moment: " + item.plannedAt].concat(item.participants || []).filter(Boolean),
    body: (item) => item.notes || "Geen notities.",
    closeStatus: "Afgerond",
  },
};

function renderOverheidRecord(type, item) {
  const config = overheidCollections[type];
  const card = document.createElement("article");
  card.className = "record-card";

  const header = document.createElement("header");
  header.appendChild(textNode("h3", "", config.title(item)));
  header.appendChild(recordBadge(formatDate(item.updatedAt || item.createdAt)));
  card.appendChild(header);

  const meta = document.createElement("div");
  meta.className = "record-meta";
  config.meta(item).forEach((value) => meta.appendChild(recordBadge(value)));
  card.appendChild(meta);
  if (type === "certificates") card.appendChild(createCertificateOwner(item));
  card.appendChild(textNode("p", "", config.body(item)));
  appendRecordLinks(card, "Bewijslinks", item.evidenceLinks);
  appendRecordNotes(card, item.notes);
  if (item.action) card.appendChild(textNode("p", "", "Actie: " + item.action));
  if (type === "handbooks" && item.url) appendRecordLinks(card, "Handboeklink", [item.url]);
  if (type === "certificates" && item.code) {
    const verify = document.createElement("a");
    verify.href = "verify.html?code=" + encodeURIComponent(item.code);
    verify.className = "mini-button";
    verify.textContent = "Verifieer";
    card.appendChild(verify);
  }

  const actions = document.createElement("div");
  actions.className = "record-actions";
  if (config.closeStatus && item.status !== config.closeStatus) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mini-button";
    close.textContent = "Sluiten";
    close.addEventListener("click", () => updateOverheidRecord(type, item.id, { status: config.closeStatus }));
    actions.appendChild(close);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mini-button danger";
  remove.textContent = "Verwijder";
  remove.addEventListener("click", () => deleteOverheidRecord(type, item.id));
  actions.appendChild(remove);
  card.appendChild(actions);

  return card;
}

function renderOverheidLogs(logs) {
  const root = document.querySelector("[data-overheid-logs]");
  if (!root) return;
  clearNode(root);
  if (!logs.length) {
    root.appendChild(textNode("p", "empty-text", "Nog geen logs."));
    return;
  }
  logs.forEach((log) => {
    const card = document.createElement("article");
    card.className = "record-card";
    card.appendChild(textNode("h3", "", log.action || "Log"));
    const meta = document.createElement("div");
    meta.className = "record-meta";
    if (log.target) meta.appendChild(recordBadge(log.target));
    if (log.createdBy?.username) meta.appendChild(recordBadge(log.createdBy.username));
    meta.appendChild(recordBadge(formatDate(log.createdAt)));
    card.appendChild(meta);
    if (log.detail) card.appendChild(textNode("p", "", log.detail));
    root.appendChild(card);
  });
}

async function loadOverheidSummary() {
  const root = document.querySelector("[data-overheid-summary]");
  if (!root || window.location.protocol === "file:") return;
  try {
    const data = await fetchOverheidJson("/api/overheid/admin/summary");
    if (!data.ok) throw new Error(data.message || "Beheerstatus kon niet laden.");
    clearNode(root);
    [
      ["Dossiers", data.counts.dossiers],
      ["Open taken", data.counts.openTasks],
      ["Sollicitaties", data.counts.openApplications],
      ["Certificaten", data.counts.certificates],
      ["Toetsen", data.counts.quizzes],
      ["Handboeken", data.counts.handbooks],
      ["Trainingen", data.counts.trainingPlans],
    ].forEach(([label, value]) => {
      const block = document.createElement("div");
      block.appendChild(textNode("span", "", label));
      block.appendChild(textNode("strong", "", String(value)));
      root.appendChild(block);
    });
    renderOverheidLogs(data.latestLogs || []);
  } catch {
    root.innerHTML = '<div><span>Beheer</span><strong>Geen toegang</strong></div>';
  }
}

async function loadOverheidCollection(type) {
  const config = overheidCollections[type];
  const root = document.querySelector('[data-overheid-list="' + type + '"]');
  if (!config || !root) return;
  if (window.location.protocol === "file:") {
    root.innerHTML = '<p class="empty-text">Open via de server om beheerdata te laden.</p>';
    return;
  }
  try {
    const data = await fetchOverheidJson(config.endpoint);
    const items = data[config.key] || [];
    clearNode(root);
    if (!items.length) {
      root.appendChild(textNode("p", "empty-text", "Nog geen items."));
      return;
    }
    items.forEach((item) => root.appendChild(renderOverheidRecord(type, item)));
  } catch (error) {
    root.innerHTML = '<p class="empty-text">' + (error.message || "Kon niet laden.") + '</p>';
  }
}

async function updateOverheidRecord(type, id, payload) {
  const config = overheidCollections[type];
  await fetchOverheidJson(config.endpoint + "/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await loadOverheidCollection(type);
  await loadOverheidSummary();
}

async function deleteOverheidRecord(type, id) {
  if (!window.confirm("Item verwijderen?")) return;
  const config = overheidCollections[type];
  await fetchOverheidJson(config.endpoint + "/" + encodeURIComponent(id), { method: "DELETE" });
  await loadOverheidCollection(type);
  await loadOverheidSummary();
}

function initOverheidAdminForms() {
  document.querySelectorAll("[data-overheid-form]").forEach((form) => {
    const type = form.dataset.overheidForm;
    const config = overheidCollections[type];
    const feedback = document.querySelector('[data-overheid-feedback="' + type + '"]');
    if (!config) return;

    if (window.location.protocol === "file:") {
      if (feedback) feedback.textContent = "Open via de server om op te slaan.";
      return;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (feedback) feedback.textContent = "Opslaan...";
      try {
        const payload = Object.fromEntries(new FormData(form).entries());
        const data = await fetchOverheidJson(config.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!data.ok) throw new Error(data.message || "Opslaan mislukt.");
        form.reset();
        if (feedback) feedback.textContent = "Opgeslagen.";
        await loadOverheidCollection(type);
        await loadOverheidSummary();
      } catch (error) {
        if (feedback) feedback.textContent = error.message || "Opslaan mislukt.";
      }
    });
  });
}

async function initOverheidAdminPanel() {
  if (!document.querySelector("[data-overheid-summary], [data-overheid-form]")) return;
  initOverheidAdminForms();
  await Promise.all(Object.keys(overheidCollections).map(loadOverheidCollection));
  await loadOverheidSummary();
}

function initQuizzes() {
  const dataEl = document.querySelector("#quiz-data");
  const list = document.querySelector("[data-quiz-list]");
  const modal = document.querySelector("[data-quiz-modal]");
  if (!dataEl || !list || !modal) return;

  let quizzes = JSON.parse(dataEl.textContent || "[]");
  const titleEl = document.querySelector("[data-quiz-title]");
  const questionsEl = document.querySelector("[data-quiz-questions]");
  const closeButton = document.querySelector("[data-quiz-close]");
  const storageKey = "amrp-politie-toets-scores";
  let activeQuiz = null;

  function getScores() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "{}");
    } catch {
      return {};
    }
  }

  function saveScore(id, score, max, certificate) {
    const scores = getScores();
    scores[id] = { score, max, certificate: certificate || null, savedAt: new Date().toISOString() };
    try {
      localStorage.setItem(storageKey, JSON.stringify(scores));
    } catch {}
  }

  function renderList() {
    const scores = getScores();
    list.innerHTML = quizzes.map((quiz) => {
      const score = scores[quiz.id];
      const passed = score && score.score / score.max >= 0.8;
      return '<article class="quiz-card">' +
        '<span class="service-meta">' + quiz.rank + '</span>' +
        '<h3>' + quiz.title + '</h3>' +
        '<p>' + quiz.description + '</p>' +
        '<div class="score">' + (score ? 'Score: ' + score.score + '/' + score.max + (passed ? ' - certificaat' : '') : 'Nog niet gemaakt') + '</div>' +
        (score?.certificate?.code ? '<small>Certificaat: ' + score.certificate.code + '</small>' : '') +
        '<button type="button" data-open-quiz="' + quiz.id + '">' + (score ? 'Opnieuw proberen' : 'Start toets') + '</button>' +
      '</article>';
    }).join("");
  }

  function parseManagedQuestions(text) {
    return String(text || "").split(/\r?\n/).map((line) => {
      const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
      if (parts.length < 4) return null;
      const question = parts[0];
      const correctRaw = parts[parts.length - 1];
      const options = parts.slice(1, -1);
      let correct = Number(correctRaw);
      if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
        correct = options.findIndex((option) => option.toLowerCase() === correctRaw.toLowerCase());
      }
      if (correct < 0) correct = 0;
      return [question, options, correct];
    }).filter(Boolean);
  }

  async function loadManagedQuizzes() {
    if (window.location.protocol === "file:") return;
    try {
      const response = await fetchOverheidJson("/api/overheid/quizzes/public");
      const managed = (response.quizzes || []).map((quiz) => ({
        id: "managed-" + quiz.id,
        title: quiz.title,
        rank: quiz.rank || quiz.service || "Overheid",
        description: quiz.description || "Toegevoegd via beheer.",
        questions: parseManagedQuestions(quiz.questionsText),
      })).filter((quiz) => quiz.questions.length);
      if (managed.length) {
        quizzes = quizzes.concat(managed);
        renderList();
      }
    } catch {
      // Statische toetsen blijven bruikbaar.
    }
  }

  function openQuiz(id) {
    activeQuiz = quizzes.find((quiz) => quiz.id === id);
    if (!activeQuiz) return;
    titleEl.textContent = activeQuiz.title + " - Kennistoets";
    questionsEl.innerHTML = activeQuiz.questions.map((question, index) => {
      const options = question[1].map((option, optionIndex) =>
        '<label class="quiz-option"><input type="radio" name="q' + index + '" value="' + optionIndex + '" /> ' + option + '</label>'
      ).join("");
      return '<div class="quiz-question"><strong>' + (index + 1) + '. ' + question[0] + '</strong>' + options + '</div>';
    }).join("") + '<button type="button" data-submit-quiz>Verzenden</button>';
    modal.removeAttribute("hidden");
  }

  async function issueCertificate(quiz, score, max, percent) {
    if (window.location.protocol === "file:") return null;
    const response = await fetchOverheidJson("/api/overheid/certificates/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "Politie",
        quizTitle: quiz.title,
        score,
        maxScore: max,
        passPercent: 80,
        percent,
      }),
    });
    if (!response.ok) throw new Error(response.message || "Certificaat kon niet worden opgeslagen.");
    return response.certificate;
  }

  async function submitQuiz() {
    if (!activeQuiz) return;
    let score = 0;
    activeQuiz.questions.forEach((question, index) => {
      const selected = document.querySelector('input[name="q' + index + '"]:checked');
      if (selected && Number(selected.value) === question[2]) score += 1;
    });
    const max = activeQuiz.questions.length;
    const percent = Math.round((score / max) * 100);
    const passed = percent >= 80;
    let certificate = null;
    if (passed) {
      questionsEl.innerHTML = '<div class="quiz-result"><h3>Score: ' + score + '/' + max + ' (' + percent + '%)</h3><p>Certificaat opslaan...</p></div>';
      try {
        certificate = await issueCertificate(activeQuiz, score, max, percent);
      } catch (error) {
        questionsEl.innerHTML = '<div class="quiz-result"><h3>Score: ' + score + '/' + max + ' (' + percent + '%)</h3><p>Geslaagd, maar certificaat opslaan mislukte: ' + (error.message || "probeer opnieuw") + '</p></div>';
        return;
      }
    }
    saveScore(activeQuiz.id, score, max, certificate);
    questionsEl.innerHTML = '<div class="quiz-result"><h3>Score: ' + score + '/' + max + ' (' + percent + '%)</h3>' +
      (passed ? '<p>Geslaagd. Certificaatcode: <strong>' + certificate.code + '</strong></p><a class="button secondary" href="../verify.html?code=' + encodeURIComponent(certificate.code) + '">Verifieer certificaat</a><button type="button" data-download-cert>Download certificaat</button>' : '<p>Nog niet geslaagd. Lees het handboek en probeer opnieuw.</p>') +
      '</div>';
    renderList();
  }

  function downloadCertificate() {
    if (!activeQuiz) return;
    const scores = getScores();
    const score = scores[activeQuiz.id];
    if (!score) return;
    const name = sessionStorage.getItem("overheidUser") || "Amsterdam Roleplay medewerker";
    const date = new Date().toLocaleDateString("nl-NL");
    const percent = Math.round((score.score / score.max) * 100);
    const certificateId = score.certificate?.code || "AMRP-" + activeQuiz.id.toUpperCase().slice(0, 4) + "-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + score.score + score.max;
    const logoUrl = new URL("../assets/logo-amsterdam-roleplay.png", window.location.href).href;
    const html = '<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Certificaat - ' + activeQuiz.title + '</title><style>' +
      '@page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#d8e2ea;font-family:Inter,Segoe UI,Arial,sans-serif;color:#10202a}.page{width:1123px;min-height:794px;padding:38px;background:linear-gradient(135deg,#f8fbfd,#edf5f8);position:relative;overflow:hidden}.page:before{content:"";position:absolute;inset:22px;border:2px solid #1b8da7}.page:after{content:"";position:absolute;inset:34px;border:1px solid rgba(16,32,42,.18)}.watermark{position:absolute;right:-80px;bottom:-110px;font-size:210px;font-weight:900;color:rgba(27,141,167,.055);letter-spacing:-8px}.cert{position:relative;z-index:1;min-height:718px;padding:42px 58px;border:1px solid rgba(16,32,42,.12);background:rgba(255,255,255,.82);display:grid;grid-template-rows:auto 1fr auto}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:28px}.brand{display:flex;gap:16px;align-items:center}.logo{width:76px;height:76px;border-radius:18px;object-fit:contain;background:#101821;padding:8px}.brand h1{margin:0;font-size:26px;letter-spacing:.04em;text-transform:uppercase}.brand p,.meta p,.footer p{margin:4px 0 0;color:#597080;font-size:13px}.meta{text-align:right}.meta strong{display:block;font-size:13px;text-transform:uppercase;letter-spacing:.16em;color:#1b8da7}.center{text-align:center;align-self:center}.kicker{margin:0 0 12px;color:#b4872d;font-size:14px;font-weight:900;letter-spacing:.22em;text-transform:uppercase}.title{margin:0;font-family:Georgia,serif;font-size:58px;line-height:1;color:#10202a}.subtitle{margin:14px auto 0;max-width:720px;color:#506878;font-size:18px}.name{display:inline-block;margin-top:34px;padding:8px 34px;border-bottom:2px solid #1b8da7;font-family:Georgia,serif;font-size:42px;font-weight:700;color:#0b1720}.training{margin:26px auto 0;padding:18px 26px;width:min(720px,100%);border:1px solid rgba(27,141,167,.35);background:linear-gradient(135deg,rgba(27,141,167,.08),rgba(180,135,45,.08));border-radius:14px}.training span{display:block;color:#597080;font-size:12px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}.training strong{display:block;margin-top:5px;font-size:25px}.score-row{display:flex;justify-content:center;gap:14px;margin-top:22px}.score{min-width:135px;border-radius:12px;padding:12px 16px;background:#10202a;color:white}.score span{display:block;font-size:11px;color:#a7c9d4;text-transform:uppercase;font-weight:900;letter-spacing:.12em}.score strong{display:block;margin-top:4px;font-size:22px}.bottom{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;align-items:end}.signature{border-top:1px solid #708997;padding-top:10px;text-align:center}.signature strong{display:block}.signature span{color:#597080;font-size:12px}.seal{justify-self:center;display:grid;place-items:center;width:116px;height:116px;border-radius:50%;border:2px solid #1b8da7;color:#1b8da7;font-weight:900;text-align:center;text-transform:uppercase;font-size:12px;letter-spacing:.08em}.print{position:fixed;right:18px;top:18px;border:0;border-radius:999px;background:#10202a;color:white;padding:12px 18px;font-weight:800;cursor:pointer}@media print{body{background:white}.page{width:100vw;min-height:100vh}.print{display:none}}@media(max-width:900px){body{display:block}.page{width:100%;min-height:100vh}.title{font-size:42px}.bottom{grid-template-columns:1fr}.meta{text-align:left}.top{flex-direction:column}.seal{justify-self:start}}' +
      '</style></head><body><button class="print" onclick="window.print()">Print / PDF</button><main class="page"><div class="watermark">AMRP</div><section class="cert"><div class="top"><div class="brand"><img class="logo" src="' + logoUrl + '" alt=""><div><h1>Amsterdam Roleplay</h1><p>Politie Opleidingen & Kennistoetsen</p></div></div><div class="meta"><strong>Certificaatnummer</strong><p>' + certificateId + '</p><p>Uitgegeven op ' + date + '</p></div></div><div class="center"><p class="kicker">Certificaat van voldoening</p><h2 class="title">Officieel Trainingscertificaat</h2><p class="subtitle">Hierbij wordt verklaard dat onderstaande medewerker de kennistoets succesvol heeft afgerond volgens de opleidingsnorm van Amsterdam Roleplay.</p><div class="name">' + name + '</div><div class="training"><span>Afgeronde kennistoets</span><strong>' + activeQuiz.title + '</strong></div><div class="score-row"><div class="score"><span>Score</span><strong>' + score.score + '/' + score.max + '</strong></div><div class="score"><span>Resultaat</span><strong>' + percent + '%</strong></div><div class="score"><span>Status</span><strong>Geslaagd</strong></div></div></div><div class="bottom"><div class="signature"><strong>Korpsleiding</strong><span>Amsterdam Roleplay Politie</span></div><div class="seal">AMRP<br>Certified</div><div class="signature"><strong>Opleidingscoordinator</strong><span>Politie Academie</span></div></div></section></main></body></html>';
    const blob = new Blob([html], { type: "text/html" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "certificaat-" + activeQuiz.id + ".html";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-quiz]");
    if (button) openQuiz(button.dataset.openQuiz);
  });

  questionsEl.addEventListener("click", (event) => {
    if (event.target.closest("[data-submit-quiz]")) submitQuiz();
    if (event.target.closest("[data-download-cert]")) downloadCertificate();
  });

  closeButton?.addEventListener("click", () => {
    modal.setAttribute("hidden", "");
    activeQuiz = null;
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      modal.setAttribute("hidden", "");
      activeQuiz = null;
    }
  });

  renderList();
  loadManagedQuizzes();
}

async function loadPublicHandbooks() {
  const root = document.querySelector("[data-public-handbooks]");
  if (!root || window.location.protocol === "file:") return;
  try {
    const data = await fetchOverheidJson("/api/overheid/handbooks/public");
    const handbooks = data.handbooks || [];
    clearNode(root);
    if (!handbooks.length) {
      root.appendChild(textNode("p", "empty-text", "Geen extra handboeken toegevoegd."));
      return;
    }
    handbooks.forEach((item) => {
      const link = document.createElement("a");
      link.className = "pdf-card";
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.appendChild(textNode("span", "", item.category || "PDF"));
      const copy = document.createElement("div");
      copy.appendChild(textNode("h3", "", item.title));
      copy.appendChild(textNode("p", "", [item.service, item.version, item.notes].filter(Boolean).join(" - ")));
      copy.appendChild(textNode("strong", "", "Open handboek"));
      link.appendChild(copy);
      root.appendChild(link);
    });
  } catch {
    root.appendChild(textNode("p", "empty-text", "Extra handboeken konden niet laden."));
  }
}

async function verifyCertificateCode(code, root) {
  if (!code) {
    root.innerHTML = '<p class="empty-text">Vul een certificaatcode in.</p>';
    return;
  }
  try {
    const response = await fetch("/api/overheid/certificates/verify?code=" + encodeURIComponent(code), { cache: "no-store" });
    const data = await response.json();
    if (!data.ok) throw new Error(data.message || "Certificaat niet gevonden.");
    const cert = data.certificate;
    root.innerHTML = '<article class="record-card certificate-result is-valid">' +
      '<header><h3>' + escapeHtml(cert.code) + '</h3><span class="status-badge">' + escapeHtml(cert.status) + '</span></header>' +
      '<div class="record-meta"><span class="status-badge">' + escapeHtml(cert.service) + '</span><span class="status-badge">' + escapeHtml(cert.percent) + '%</span><span class="status-badge">' + escapeHtml(formatDate(cert.issuedAt)) + '</span></div>' +
      '<p><strong>' + escapeHtml(cert.holderName) + '</strong> is geslaagd voor ' + escapeHtml(cert.quizTitle) + ' met score ' + escapeHtml(cert.score) + '/' + escapeHtml(cert.maxScore) + '.</p>' +
      '<div class="record-actions"><button type="button" class="button" data-download-verified-cert>Download certificaat</button></div>' +
      '</article>';
    root.querySelector("[data-download-verified-cert]")?.addEventListener("click", () => downloadVerifiedCertificate(cert));
  } catch (error) {
    root.innerHTML = '<article class="record-card certificate-result is-invalid"><h3>Niet gevonden</h3><p>' + escapeHtml(error.message || "Controleer de code en probeer opnieuw.") + '</p></article>';
  }
}

function downloadVerifiedCertificate(cert) {
  if (!cert) return;
  const logoUrl = new URL("assets/logo-amsterdam-roleplay.png", window.location.href).href;
  const issuedAt = cert.issuedAt ? formatDate(cert.issuedAt) : new Date().toLocaleDateString("nl-NL");
  const filename = "certificaat-" + String(cert.code || "amrp").toLowerCase().replace(/[^a-z0-9-]+/g, "-") + ".html";
  const html = '<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Certificaat - ' + escapeHtml(cert.code) + '</title><style>' +
    '@page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#d9e8ef;font-family:Inter,Segoe UI,Arial,sans-serif;color:#10202a}.page{width:1123px;min-height:794px;padding:38px;background:linear-gradient(135deg,#f8fbfd,#edf7fb);position:relative;overflow:hidden}.page:before{content:"";position:absolute;inset:22px;border:2px solid #1b8da7}.page:after{content:"";position:absolute;inset:34px;border:1px solid rgba(16,32,42,.18)}.watermark{position:absolute;right:-80px;bottom:-110px;font-size:210px;font-weight:900;color:rgba(27,141,167,.055);letter-spacing:-8px}.cert{position:relative;z-index:1;min-height:718px;padding:42px 58px;border:1px solid rgba(16,32,42,.12);background:rgba(255,255,255,.84);display:grid;grid-template-rows:auto 1fr auto}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:28px}.brand{display:flex;gap:16px;align-items:center}.logo{width:76px;height:76px;border-radius:18px;object-fit:contain;background:#101821;padding:8px}.brand h1{margin:0;font-size:26px;letter-spacing:.04em;text-transform:uppercase}.brand p,.meta p{margin:4px 0 0;color:#597080;font-size:13px}.meta{text-align:right}.meta strong{display:block;font-size:13px;text-transform:uppercase;letter-spacing:.16em;color:#1b8da7}.center{text-align:center;align-self:center}.kicker{margin:0 0 12px;color:#b4872d;font-size:14px;font-weight:900;letter-spacing:.22em;text-transform:uppercase}.title{margin:0;font-family:Georgia,serif;font-size:58px;line-height:1;color:#10202a}.subtitle{margin:14px auto 0;max-width:720px;color:#506878;font-size:18px}.name{display:inline-block;margin-top:34px;padding:8px 34px;border-bottom:2px solid #1b8da7;font-family:Georgia,serif;font-size:42px;font-weight:700;color:#0b1720}.training{margin:26px auto 0;padding:18px 26px;width:min(720px,100%);border:1px solid rgba(27,141,167,.35);background:linear-gradient(135deg,rgba(27,141,167,.08),rgba(180,135,45,.08));border-radius:14px}.training span{display:block;color:#597080;font-size:12px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}.training strong{display:block;margin-top:5px;font-size:25px}.score-row{display:flex;justify-content:center;gap:14px;margin-top:22px}.score{min-width:135px;border-radius:12px;padding:12px 16px;background:#10202a;color:white}.score span{display:block;font-size:11px;color:#a7c9d4;text-transform:uppercase;font-weight:900;letter-spacing:.12em}.score strong{display:block;margin-top:4px;font-size:22px}.bottom{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;align-items:end}.signature{border-top:1px solid #708997;padding-top:10px;text-align:center}.signature strong{display:block}.signature span{color:#597080;font-size:12px}.seal{justify-self:center;display:grid;place-items:center;width:116px;height:116px;border-radius:50%;border:2px solid #1b8da7;color:#1b8da7;font-weight:900;text-align:center;text-transform:uppercase;font-size:12px;letter-spacing:.08em}.print{position:fixed;right:18px;top:18px;border:0;border-radius:999px;background:#10202a;color:white;padding:12px 18px;font-weight:800;cursor:pointer}@media print{body{background:white}.page{width:100vw;min-height:100vh}.print{display:none}}@media(max-width:900px){body{display:block}.page{width:100%;min-height:100vh}.title{font-size:42px}.bottom{grid-template-columns:1fr}.meta{text-align:left}.top{flex-direction:column}.seal{justify-self:start}}' +
    '</style></head><body><button class="print" onclick="window.print()">Print / PDF</button><main class="page"><div class="watermark">AMRP</div><section class="cert"><div class="top"><div class="brand"><img class="logo" src="' + logoUrl + '" alt=""><div><h1>Amsterdam Roleplay</h1><p>Overheid Opleidingen & Kennistoetsen</p></div></div><div class="meta"><strong>Certificaatnummer</strong><p>' + escapeHtml(cert.code) + '</p><p>Uitgegeven op ' + escapeHtml(issuedAt) + '</p></div></div><div class="center"><p class="kicker">Geverifieerd certificaat</p><h2 class="title">Officieel Trainingscertificaat</h2><p class="subtitle">Hierbij wordt verklaard dat onderstaande medewerker de kennistoets succesvol heeft afgerond volgens de opleidingsnorm van Amsterdam Roleplay.</p><div class="name">' + escapeHtml(cert.holderName) + '</div><div class="training"><span>Afgeronde kennistoets</span><strong>' + escapeHtml(cert.quizTitle) + '</strong></div><div class="score-row"><div class="score"><span>Score</span><strong>' + escapeHtml(cert.score) + '/' + escapeHtml(cert.maxScore) + '</strong></div><div class="score"><span>Resultaat</span><strong>' + escapeHtml(cert.percent) + '%</strong></div><div class="score"><span>Status</span><strong>' + escapeHtml(cert.status) + '</strong></div></div></div><div class="bottom"><div class="signature"><strong>Korpsleiding</strong><span>' + escapeHtml(cert.service || "Amsterdam Roleplay") + '</span></div><div class="seal">AMRP<br>Verified</div><div class="signature"><strong>Opleidingscoordinator</strong><span>Overheid Portaal</span></div></div></section></main></body></html>';

  const blob = new Blob([html], { type: "text/html" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function initCertificateVerify() {
  const form = document.querySelector("[data-verify-form]");
  const result = document.querySelector("[data-verify-result]");
  if (!form || !result) return;
  const codeInput = form.querySelector("input[name='code']");
  const initialCode = new URLSearchParams(window.location.search).get("code");
  if (initialCode && codeInput) {
    codeInput.value = initialCode;
    verifyCertificateCode(initialCode, result);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    verifyCertificateCode(codeInput?.value || "", result);
  });
}

initServiceChoice();
initAuthStatus();
initQuizzes();
initOverheidAdminPanel();
initCertificateVerify();
loadPublicHandbooks();
