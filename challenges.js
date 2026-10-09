// Friend challenges - a PREVIEW of the screens from the challenges mockup,
// running on sample data. Only shown when the app runs on localhost: the
// server side (challenge tables, scoring, the hourly check) isn't built
// yet, so on the real site none of this appears.
//
// Four types: Rep Race (most reps), Last One Standing (your own plan, miss
// a day and you're out), Climb (one shared plan that goes up every day,
// last one left wins) and Distance (most distance walked or run).
//
// Loaded after script.js and uses its helpers (showScreen, showTab,
// ForjaCamera, saveCameraSet, serverPlan, data, myUsername).
const Challenges = (function () {
  const PREVIEW = ["localhost", "127.0.0.1"].includes(location.hostname);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const I = (d, width = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    back: I('<path d="M15 18l-6-6 6-6"/>', 2.4),
    chevron: I('<path d="M9 6l6 6-6 6"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>', 2.4),
    minus: I('<path d="M5 12h14"/>', 2.4),
    bolt: I('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
    crown: I('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/><path d="M5 19h14"/>'),
    climb: I('<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>'),
    route: I('<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/>'),
    check: I('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.6),
    clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    x: I('<path d="M18 6L6 18M6 6l12 12"/>'),
    up: I('<path d="M12 19V5M5 12l7-7 7 7"/>', 2.4),
    camera: I('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
    trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 3h10v7a5 5 0 0 1-10 0V3z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M7 5H4.5a2 2 0 0 0 0 4.5H7M17 5h2.5a2 2 0 0 1 0 4.5H17"/><path fill="currentColor" d="M11 14.5h2V18h-2z"/><rect fill="currentColor" x="8" y="18" width="8" height="3" rx="1"/></svg>',
  };

  const EXERCISES = {
    pushups: { name: "Push-ups", race: "Push-up Race", color: "var(--ring-pushups)", camera: "pushup" },
    squats: { name: "Squats", race: "Squat Race", color: "var(--ring-squats)", camera: "squat" },
    planks: { name: "Plank", race: "Plank Race", color: "var(--ring-planks)", camera: "plank" },
  };
  const TYPES = {
    rep: { name: "Rep Race", line: "Most reps wins", icon: ICON.bolt, color: EXERCISES.pushups.color },
    lms: { name: "Last One Standing", line: "Miss your plan and you're out", icon: ICON.crown, color: "var(--ember)" },
    climb: { name: "Climb", line: "Same workout, harder every day", icon: ICON.climb, color: "var(--accent)" },
    dist: { name: "Distance", line: "Most distance walked or run wins", icon: ICON.route, color: "var(--ring-walkrun)" },
  };
  const TIPS = {
    rep: "Camera-verified reps only. Everyone starts at 0 on day 1. Most reps when it ends wins.",
    lms: "Hit your own plan every day. Miss one and you're out. Last one left wins.",
    climb: "Everyone does the same targets, and they go up every day. Miss a day and you're out. Last one left wins.",
    dist: "Tracked walks and runs count. Most distance when it ends wins.",
  };
  const DAY_OPTIONS = [3, 7, 14, 30];
  // How many plan steps a Climb goes up each day. One step is the same as
  // a plan level-up: +1 push-up, +2 squats, +5 seconds of plank.
  const SPEEDS = { slow: { name: "Slow", steps: 1 }, medium: { name: "Medium", steps: 2 }, fast: { name: "Fast", steps: 3 } };
  const STEP = { pushups: 1, squats: 2, planks: 5 };
  const MAX_FRIENDS = 10;

  // ---------- sample data (made up) ----------
  const FRIENDS = ["jess_runs", "marco_lifts", "dani_k", "theo22", "sam_fit", "lena_m"];
  const state = {
    invite: { type: "lms", from: "marco_lifts", players: 5 },
    list: [
      { id: "race", type: "rep", exercise: "pushups", status: "running", sub: ["Day 4 of 7", "You're 2nd"] },
      { id: "lms", type: "lms", status: "running", sub: ["Day 9", "3 left"] },
      { id: "climb", type: "climb", status: "running", sub: ["Day 5", "4 of 5 still in"] },
      { id: "dist", type: "dist", status: "running", sub: ["Day 10 of 14", "You're 1st"] },
      { id: "ended", type: "rep", exercise: "squats", days: 7, status: "ended", sub: ["Ended", "You won"] },
    ],
    draft: null,
  };

  const me = () => (typeof myUsername === "string" && myUsername) || "You";
  const challengeName = (c) => (c.type === "rep" ? EXERCISES[c.exercise].race : c.type === "dist" ? "Distance Race" : TYPES[c.type].name);
  const challengeColor = (c) => (c.type === "rep" ? EXERCISES[c.exercise].color : TYPES[c.type].color);
  const tile = (color, icon, extra = "") => `<span class="challenge-tile ${extra}" style="--c:${color}">${icon}</span>`;
  const avatar = () => `<span class="leaderboard-avatar">${PERSON_ICON_SVG}</span>`;
  const backButton = (label, to) => `<button class="nav-back" data-ch-go="${to}">${ICON.back}${esc(label)}</button>`;
  const tipButton = (type) => `<button class="tip-btn challenge-tip-btn" data-ch-tip="${type}" aria-label="How it works" aria-expanded="false">i</button>`;

  // Distance follows the unit the Record tab uses.
  const useMiles = () => typeof data !== "undefined" && data && data.units === "miles";
  const distanceText = (km) => (useMiles() ? (km * 0.621371).toFixed(1) : km.toFixed(1));
  const distanceUnit = () => (useMiles() ? "mi" : "km");

  // ---------- Competition tab ----------
  function card(c) {
    const pill = c.status === "pending" ? '<span class="challenge-pill">Pending</span>' : c.status === "ended" ? '<span class="challenge-pill is-result">Results</span>' : `<span class="challenge-chevron">${ICON.chevron}</span>`;
    const icon = c.type === "rep" ? ICON.bolt : TYPES[c.type].icon;
    return `
      <button class="challenge-card" data-ch-open="${c.id}">${tile(challengeColor(c), icon)}
        <span class="challenge-card-text"><span class="challenge-card-name">${esc(challengeName(c))}</span><span class="challenge-card-sub">${esc(c.sub[0])} · <b>${esc(c.sub[1])}</b></span></span>
        ${pill}
      </button>`;
  }

  function renderTab() {
    if (!PREVIEW) return;
    $("new-challenge-button").classList.remove("hidden");
    $("challenges-section").classList.remove("hidden");
    const invite = state.invite
      ? `<button class="challenge-card" data-ch-act="invite">${tile(TYPES[state.invite.type].color, TYPES[state.invite.type].icon)}
          <span class="challenge-card-text"><span class="challenge-card-name">${esc(TYPES[state.invite.type].name)}</span><span class="challenge-card-sub">From ${esc(state.invite.from)}</span></span>
          <span class="challenge-pill is-invite">Invite</span></button>`
      : "";
    $("challenge-list").innerHTML = invite + state.list.map(card).join("");
  }

  // ---------- the challenge screen (one screen, redrawn per view) ----------
  function show(html) {
    closeTip();
    $("challenge-screen").innerHTML = html;
    showScreen("challenge-screen");
    window.scrollTo(0, 0);
  }

  function backToTab() {
    closeTip();
    renderTab();
    showScreen("app-screen");
    showTab("competition");
  }

  function typeView() {
    show(`
      ${backButton("Competition", "tab")}
      <h1 class="large-title">New Challenge</h1>
      <div class="challenge-picks">${Object.entries(TYPES).map(([key, t]) => `
        <button class="challenge-pick" data-ch-type="${key}">${tile(t.color, t.icon)}
          <span class="challenge-pick-text"><b>${t.name}</b><span>${t.line}</span></span>
          <span class="challenge-chevron">${ICON.chevron}</span></button>`).join("")}
      </div>`);
  }

  // Climb's Day 1 starts from your own plan (or minimums), never below the
  // floors the server already enforces.
  function myTargets() {
    try {
      if (typeof serverPlan !== "undefined" && serverPlan) return { ...ForjaRules.planOn(serverPlan, todayString()).plan.targets };
    } catch (error) {
      // fall through to the minimums
    }
    const m = (typeof data !== "undefined" && data && data.minimums) || {};
    return { pushups: m.pushups || 10, squats: m.squats || 16, planks: m.planks || 30 };
  }

  function newDraft(type) {
    const targets = myTargets();
    Object.keys(targets).forEach((key) => (targets[key] = Math.max(ForjaRules.FLOORS[key], targets[key])));
    return { type, exercise: "pushups", days: 7, targets, speed: "medium", friends: new Set(["jess_runs", "marco_lifts", "dani_k"]) };
  }

  function segmented(name, options, current, label) {
    return `<div class="plan-pace challenge-seg" style="grid-template-columns:repeat(${options.length},1fr)" role="radiogroup" aria-label="${label}">${options
      .map(([value, text]) => `<button role="radio" aria-checked="${String(value) === String(current)}" data-ch-set="${name}" data-ch-val="${value}">${text}</button>`)
      .join("")}</div>`;
  }

  function climbLine(steps) {
    const n = steps;
    return `+${n * STEP.pushups} push-up${n > 1 ? "s" : ""} · +${n * STEP.squats} squats · +${mmss(n * STEP.planks)} plank a day`;
  }

  function setupView() {
    const d = state.draft;
    const t = TYPES[d.type];
    const days = `<p class="section-heading">Days</p>${segmented("days", DAY_OPTIONS.map((n) => [n, n]), d.days, "Days")}`;
    let body = "";
    if (d.type === "rep") {
      body = `
        <div class="challenge-field"><p class="section-heading">Exercise</p>${segmented("exercise", Object.entries(EXERCISES).map(([key, ex]) => [key, ex.name]), d.exercise, "Exercise")}</div>
        <div class="challenge-field">${days}</div>`;
    } else if (d.type === "dist") {
      body = `<div class="challenge-field">${days}</div>`;
    } else if (d.type === "lms") {
      body = `<p class="challenge-rule">Miss your plan once and you're out.</p>`;
    } else {
      body = `
        <div class="challenge-field"><p class="section-heading">Day 1</p>
          <div class="challenge-steppers">${Object.entries(EXERCISES).map(([key, ex]) => {
            const value = d.targets[key];
            return `
            <div class="challenge-stepper" style="--c:${ex.color}">
              <span class="challenge-dot"></span><span class="challenge-stepper-name">${ex.name}</span>
              <button class="challenge-step-button" data-ch-step="${key}" data-ch-dir="-1" aria-label="Fewer" ${value - STEP[key] < ForjaRules.FLOORS[key] ? "disabled" : ""}>${ICON.minus}</button>
              <span class="challenge-step-value">${key === "planks" ? mmss(value) : value}</span>
              <button class="challenge-step-button" data-ch-step="${key}" data-ch-dir="1" aria-label="More">${ICON.plus}</button>
            </div>`;
          }).join("")}</div>
        </div>
        <div class="challenge-field"><p class="section-heading">Goes up every day</p>
          ${segmented("speed", Object.entries(SPEEDS).map(([key, s]) => [key, s.name]), d.speed, "How fast it goes up")}
          <p class="challenge-climb-line">${climbLine(SPEEDS[d.speed].steps)}</p>
        </div>`;
    }
    const name = challengeName(d);
    show(`
      ${backButton("New Challenge", "type")}
      <div class="challenge-setup-head">
        ${tile(challengeColor(d), d.type === "rep" ? ICON.bolt : t.icon, "is-large")}
        <div class="challenge-title-row"><h1 class="large-title">${esc(name)}</h1>${tipButton(d.type)}</div>
      </div>
      ${body}
      <p class="challenge-starts">Starts tomorrow</p>
      <button class="auth-submit-button" data-ch-go="friends">Next</button>`);
  }

  function sendLabel() {
    const n = state.draft.friends.size;
    return n ? `Send ${n} Invite${n > 1 ? "s" : ""}` : "Pick a Friend";
  }

  function friendsView() {
    const d = state.draft;
    show(`
      ${backButton(challengeName(d), "setup")}
      <h1 class="large-title">Invite Friends</h1>
      <div class="leaderboard">${FRIENDS.map((name) => `
        <button class="leaderboard-row challenge-friend" role="checkbox" aria-checked="${d.friends.has(name)}" data-ch-friend="${esc(name)}">
          ${avatar()}<span class="leaderboard-name">${esc(name)}</span><span class="challenge-check">${ICON.check}</span></button>`).join("")}
      </div>
      <button id="challenge-send-button" class="auth-submit-button" data-ch-act="send" ${d.friends.size ? "" : "disabled"}>${sendLabel()}</button>`);
  }

  // ---------- live challenges ----------
  function dayBar(done, total, color) {
    return `<div class="challenge-days" style="--c:${color}">${Array.from({ length: total }, (_, k) => `<span class="${k < done ? "is-done" : ""}"></span>`).join("")}</div>`;
  }

  // Ranked rows with a bar against the leader. `final` drops the "today" line.
  function standings(rows, color, unit = "", final = false) {
    const max = Math.max(...rows.map((r) => r.value));
    return `<div class="challenge-standings" style="--c:${color}">${rows.map((r, k) => `
      <div class="challenge-standing ${r.you ? "is-you" : ""}">
        <span class="leaderboard-rank ${k === 0 ? "is-first" : ""}">${k + 1}</span>${avatar()}
        <span class="challenge-standing-who"><span class="leaderboard-name">${esc(r.you ? me() : r.name)}</span>${final ? "" : `<span class="challenge-standing-note ${r.today ? "is-up" : ""}">${r.today ? `${ICON.up}${r.today} today` : "Nothing yet today"}</span>`}</span>
        <span class="challenge-standing-value">${r.shown || r.value}${unit ? `<small>${unit}</small>` : ""}</span>
        <span class="challenge-standing-bar"><i style="width:${Math.round((r.value / max) * 100)}%"></i></span>
      </div>`).join("")}</div>`;
  }

  // Who's still in: done today, not yet, or out (Last One Standing, Climb).
  function inOutRows(people) {
    const stateIcon = (p) => (p.out ? `<span class="challenge-state is-out">${ICON.x}</span>` : p.done ? `<span class="challenge-state is-done">${ICON.check}</span>` : `<span class="challenge-state is-waiting">${ICON.clock}</span>`);
    const note = (p) => (p.out ? `Out on day ${p.out}` : p.done ? "Done today" : "Not yet today");
    return `<div class="challenge-standings">${people.map((p) => `
      <div class="challenge-standing no-rank ${p.you ? "is-you" : ""} ${p.out ? "is-out" : ""}">
        ${avatar()}
        <span class="challenge-standing-who"><span class="leaderboard-name">${esc(p.you ? me() : p.name)}</span><span class="challenge-standing-note">${note(p)}</span></span>
        ${stateIcon(p)}
      </div>`).join("")}</div>`;
  }

  function header(c, longTitle = false) {
    return `
      ${backButton("Competition", "tab")}
      <div class="challenge-title-row">${tile(challengeColor(c), c.type === "rep" ? ICON.bolt : TYPES[c.type].icon)}<h1 class="large-title ${longTitle ? "is-long" : ""}">${esc(challengeName(c))}</h1>${tipButton(c.type)}</div>`;
  }

  const DETAILS = {
    race: (c) => `
      ${header(c)}
      ${dayBar(4, 7, challengeColor(c))}
      <p class="challenge-status">Day 4 of 7 · <b>14 behind jess_runs</b></p>
      ${standings([
        { name: "jess_runs", value: 212, today: 38 },
        { you: true, value: 198, today: 25 },
        { name: "marco_lifts", value: 161, today: 0 },
        { name: "dani_k", value: 97, today: 12 },
      ], challengeColor(c))}
      <button class="auth-submit-button challenge-icon-button" data-ch-act="camera" data-ch-exercise="${EXERCISES[c.exercise].camera}">${ICON.camera}Do a Set</button>`,
    lms: (c) => `
      ${header(c, true)}
      <p class="challenge-status is-spaced">Day 9 · <b>3 of 5 left</b></p>
      ${inOutRows([
        { name: "marco_lifts", done: true },
        { you: true },
        { name: "jess_runs", done: true },
        { name: "theo22", out: 6 },
        { name: "sam_fit", out: 3 },
      ])}
      <button class="auth-submit-button" data-ch-act="today">Do Today's Plan</button>`,
    // Example: started at 12 · 20 · 0:40 on Medium (+2 steps a day), now day 5.
    climb: (c) => `
      ${header(c)}
      <p class="challenge-status is-spaced">Day 5 · <b>4 of 5 still in</b></p>
      <div class="plan-card"><div class="plan-targets">${[["20", "pushups"], ["36", "squats"], ["1:20", "planks"]]
        .map(([value, key]) => `<div><div class="plan-target-value">${value}</div><div class="plan-target-name"><i style="background:${EXERCISES[key].color}"></i>${EXERCISES[key].name}</div></div>`)
        .join("")}</div>
        <p class="challenge-tomorrow">Tomorrow <b>22 · 40 · 1:30</b></p>
      </div>
      ${inOutRows([
        { name: "jess_runs", done: true },
        { you: true },
        { name: "dani_k", done: true },
        { name: "lena_m" },
        { name: "theo22", out: 3 },
      ])}
      <button class="auth-submit-button" data-ch-act="today">Do Today's Plan</button>`,
    dist: (c) => `
      ${header(c)}
      ${dayBar(10, 14, challengeColor(c))}
      <p class="challenge-status">Day 10 of 14 · <b>${distanceText(2.1)} ${distanceUnit()} ahead</b></p>
      ${standings([
        { you: true, value: 31.4, shown: distanceText(31.4), today: `${distanceText(3.2)} ${distanceUnit()}` },
        { name: "jess_runs", value: 29.3, shown: distanceText(29.3), today: `${distanceText(5)} ${distanceUnit()}` },
        { name: "lena_m", value: 12.8, shown: distanceText(12.8), today: 0 },
      ], challengeColor(c), distanceUnit())}
      <button class="auth-submit-button" data-ch-act="record">Start a Walk</button>`,
  };

  // Shown once after a challenge ends (here: whenever its card is tapped).
  function resultView(c) {
    const colors = ["var(--trophy)", "var(--accent)", "var(--ring-pushups)", "var(--ring-squats)"];
    const sparks = Array.from({ length: 16 }, (_, k) => {
      const angle = (k / 16) * Math.PI * 2;
      const r = 64 + (k % 3) * 10;
      return `<i style="--dx:${Math.round(Math.cos(angle) * r)}px;--dy:${Math.round(Math.sin(angle) * r)}px;--k:${colors[k % 4]}"></i>`;
    }).join("");
    show(`
      <div class="challenge-result">
        <div class="challenge-burst">${sparks}<span class="challenge-trophy">${ICON.trophy}</span></div>
        <h1 class="large-title">You won!</h1>
        <p class="screen-subtitle">${esc(challengeName(c))} · ${c.days} days</p>
        ${standings([
          { you: true, value: 352 },
          { name: "jess_runs", value: 341 },
          { name: "marco_lifts", value: 280 },
          { name: "dani_k", value: 190 },
        ], challengeColor(c), "", true)}
      </div>
      <button class="auth-submit-button" data-ch-act="rematch" data-ch-id="${c.id}">Rematch</button>
      <button class="challenge-text-button" data-ch-go="tab">Done</button>`);
  }

  function open(id) {
    const c = state.list.find((x) => x.id === id);
    if (!c) return;
    if (c.status === "pending") return toast("Starts tomorrow");
    if (c.status === "ended") return resultView(c);
    show(DETAILS[c.id](c));
  }

  // ---------- invite sheet ----------
  function openInvite() {
    const inv = state.invite;
    if (!inv) return;
    const scrim = document.createElement("div");
    scrim.className = "challenge-scrim";
    scrim.dataset.chAct = "close-sheet";
    scrim.innerHTML = `
      <div class="challenge-sheet" role="dialog" aria-modal="true" aria-label="Challenge invite">
        <span class="challenge-grabber"></span>
        ${tile(TYPES[inv.type].color, TYPES[inv.type].icon, "is-large")}
        <p class="challenge-sheet-from"><b>${esc(inv.from)}</b> challenged you</p>
        <h2>${esc(TYPES[inv.type].name)}</h2>
        <div class="challenge-faces">${avatar().repeat(inv.players)}</div>
        <p class="challenge-sheet-meta">${inv.players} players · Starts tomorrow</p>
        <button class="auth-submit-button" data-ch-act="accept">Accept</button>
        <button class="challenge-text-button is-muted" data-ch-act="decline">Decline</button>
      </div>`;
    document.body.appendChild(scrim);
    scrim.querySelector("[data-ch-act=accept]").focus();
  }
  function closeInvite() {
    document.querySelectorAll(".challenge-scrim").forEach((el) => el.remove());
  }

  // ---------- tips and toasts ----------
  function closeTip() {
    document.querySelectorAll(".challenge-tip").forEach((tip) => tip.remove());
    document.querySelectorAll(".challenge-tip-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
  // Same look and placement as My Plan's tips: under the ⓘ, arrow pointing at it.
  function openTip(button) {
    const holder = button.closest(".challenge-title-row");
    const tip = document.createElement("div");
    tip.className = "plan-tip challenge-tip";
    tip.setAttribute("role", "note");
    tip.textContent = TIPS[button.dataset.chTip];
    holder.appendChild(tip);
    const holderBox = holder.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const tipBox = tip.getBoundingClientRect();
    tip.style.top = `${buttonBox.bottom - holderBox.top + 10}px`;
    const arrowX = buttonBox.left + buttonBox.width / 2 - tipBox.left;
    tip.style.setProperty("--arrow-x", `${Math.max(18, Math.min(tipBox.width - 18, arrowX))}px`);
    button.setAttribute("aria-expanded", "true");
  }

  function toast(text) {
    document.querySelectorAll(".challenge-toast").forEach((el) => el.remove());
    const el = document.createElement("div");
    el.className = "challenge-toast";
    el.setAttribute("role", "status");
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2300);
  }

  // ---------- Feed and Me ----------
  // The post the server will write for a challenge winner. Feed reloads
  // wipe the list, so script.js calls this after every load.
  function decorateFeed(listEl) {
    if (!PREVIEW || !listEl) return;
    listEl.querySelectorAll(".challenge-feed-card").forEach((el) => el.remove());
    const post = document.createElement("article");
    post.className = "feed-card is-you challenge-feed-card";
    post.innerHTML = `
      <div class="feed-card-header">${avatar()}
        <div class="feed-card-who"><span class="feed-card-name">You</span><span class="feed-card-when">Today</span></div>
      </div>
      <div><span class="feed-card-kind is-challenge">Challenge won</span><p class="feed-card-headline">Won the Squat Race</p></div>
      <div class="feed-card-stats">${[["352", "Squats"], ["7", "Days"], ["3", "Friends beaten"]]
        .map(([value, label]) => `<div class="feed-stat"><span class="feed-stat-value">${value}</span><span class="feed-stat-label">${label}</span></div>`)
        .join("")}</div>
      <div class="feed-card-footer"><span class="kudos-summary">jess_runs and 4 others gave kudos</span></div>`;
    listEl.prepend(post);
    $("feed-message").classList.add("hidden");
  }

  function renderTrophies() {
    if (!PREVIEW) return;
    const trophies = [["Squat Race", "Oct 8"], ["Distance Race", "Sep 28"], ["Last One Standing", "Sep 14"]];
    $("trophy-shelf").innerHTML = trophies.map(([name, date]) => `<div class="trophy-tile">${ICON.trophy}<b>${name}</b><span>${date}</span></div>`).join("");
    $("trophies-section").classList.remove("hidden");
  }

  // ---------- taps ----------
  document.addEventListener("click", (event) => {
    if (!PREVIEW) return;
    const tipButtonEl = event.target.closest("[data-ch-tip]");
    const wasOpen = tipButtonEl && tipButtonEl.getAttribute("aria-expanded") === "true";
    closeTip();
    if (tipButtonEl) {
      if (!wasOpen) openTip(tipButtonEl);
      return;
    }

    const el = event.target.closest("[data-ch-go], [data-ch-open], [data-ch-type], [data-ch-set], [data-ch-step], [data-ch-friend], [data-ch-act], #new-challenge-button");
    if (!el) return;
    const d = state.draft;

    if (el.id === "new-challenge-button") return typeView();
    if (el.dataset.chOpen) return open(el.dataset.chOpen);
    if (el.dataset.chType) {
      state.draft = newDraft(el.dataset.chType);
      return setupView();
    }
    if (el.dataset.chGo) {
      const views = { tab: backToTab, type: typeView, setup: setupView, friends: friendsView };
      return views[el.dataset.chGo]();
    }
    if (el.dataset.chSet) {
      d[el.dataset.chSet] = el.dataset.chSet === "days" ? Number(el.dataset.chVal) : el.dataset.chVal;
      return setupView();
    }
    if (el.dataset.chStep) {
      const key = el.dataset.chStep;
      d.targets[key] = Math.max(ForjaRules.FLOORS[key], d.targets[key] + STEP[key] * Number(el.dataset.chDir));
      return setupView();
    }
    if (el.dataset.chFriend) {
      // Only this row's check and the button change; nothing else redraws.
      const name = el.dataset.chFriend;
      if (d.friends.has(name)) d.friends.delete(name);
      else if (d.friends.size < MAX_FRIENDS) d.friends.add(name);
      el.setAttribute("aria-checked", String(d.friends.has(name)));
      const send = $("challenge-send-button");
      send.textContent = sendLabel();
      send.disabled = d.friends.size === 0;
      return;
    }

    switch (el.dataset.chAct) {
      case "invite":
        return openInvite();
      case "close-sheet":
        if (event.target === el) closeInvite();
        return;
      case "accept":
        state.list.unshift({ id: `joined-${Date.now()}`, type: state.invite.type, status: "pending", sub: ["Starts tomorrow", "You're in"] });
        state.invite = null;
        closeInvite();
        renderTab();
        return toast("You're in. Starts tomorrow");
      case "decline":
        state.invite = null;
        closeInvite();
        return renderTab();
      case "send":
        state.list.unshift({ id: `new-${Date.now()}`, type: d.type, exercise: d.exercise, status: "pending", sub: ["Starts tomorrow", `0 of ${d.friends.size} in`] });
        backToTab();
        return toast("Invites sent");
      case "rematch": {
        const ended = state.list.find((x) => x.id === el.dataset.chId);
        state.list.unshift({ id: `new-${Date.now()}`, type: ended.type, exercise: ended.exercise, status: "pending", sub: ["Starts tomorrow", "0 of 3 in"] });
        backToTab();
        return toast("Rematch sent");
      }
      case "camera":
        return ForjaCamera.open(el.dataset.chExercise, saveCameraSet);
      case "today":
        showScreen("app-screen");
        return showTab("today");
      case "record":
        showScreen("app-screen");
        return showTab("record");
    }
  });

  if (PREVIEW) {
    renderTab();
    renderTrophies();
  }

  return { decorateFeed, renderTab };
})();
