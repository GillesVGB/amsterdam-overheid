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

function initQuizzes() {
  const dataEl = document.querySelector("#quiz-data");
  const list = document.querySelector("[data-quiz-list]");
  const modal = document.querySelector("[data-quiz-modal]");
  if (!dataEl || !list || !modal) return;

  const quizzes = JSON.parse(dataEl.textContent || "[]");
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

  function saveScore(id, score, max) {
    const scores = getScores();
    scores[id] = { score, max, savedAt: new Date().toISOString() };
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
        '<button type="button" data-open-quiz="' + quiz.id + '">' + (score ? 'Opnieuw proberen' : 'Start toets') + '</button>' +
      '</article>';
    }).join("");
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

  function submitQuiz() {
    if (!activeQuiz) return;
    let score = 0;
    activeQuiz.questions.forEach((question, index) => {
      const selected = document.querySelector('input[name="q' + index + '"]:checked');
      if (selected && Number(selected.value) === question[2]) score += 1;
    });
    const max = activeQuiz.questions.length;
    const percent = Math.round((score / max) * 100);
    saveScore(activeQuiz.id, score, max);
    const passed = percent >= 80;
    questionsEl.innerHTML = '<div class="quiz-result"><h3>Score: ' + score + '/' + max + ' (' + percent + '%)</h3>' +
      (passed ? '<p>Geslaagd. Je kunt je certificaat downloaden.</p><button type="button" data-download-cert>Download certificaat</button>' : '<p>Nog niet geslaagd. Lees het handboek en probeer opnieuw.</p>') +
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
    const certificateId = "AMRP-" + activeQuiz.id.toUpperCase().slice(0, 4) + "-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + score.score + score.max;
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
}

initAuthStatus();
initQuizzes();
