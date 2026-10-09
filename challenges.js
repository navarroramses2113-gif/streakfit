// Friend challenges in the app: the Challenges list on the Competition tab,
// New Challenge (type, setup, friends), invites, each challenge's live
// standings, the results, and trophies on Me. Everything comes from and
// goes through the `challenge` server function - every score is the
// server's own.
//
// Four types: Rep Race (most reps), Last One Standing (your own plan, miss
// a day and you're out), Climb (one shared plan that goes up every day,
// last one left wins) and Distance (most distance walked or run).
//
// Shown on localhost while it's tested; set SHOW_ON_SITE to true once the
// challenge tables and functions are live.
//
// Loaded after script.js and uses its helpers (showScreen, showTab,
// callServerFunction, supabaseClient, currentUserId, ForjaCamera,
// saveCameraSet, serverPlan, data, displayDistance, distanceUnitLabel).
const Challenges = (function () {
  const SHOW_ON_SITE = false;
  const ENABLED = SHOW_ON_SITE || ["localhost", "127.0.0.1"].includes(location.hostname);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
  const ordinal = (n) => {
    const tens = n % 100;
    return `${n}${tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
  };

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
    pushups: { name: "Push-ups", color: "var(--ring-pushups)", camera: "pushup" },
    squats: { name: "Squats", color: "var(--ring-squats)", camera: "squat" },
    planks: { name: "Plank", color: "var(--ring-planks)", camera: "plank" },
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
  // How many plan steps a Climb goes up each day (the server checks these).
  const SPEEDS = { slow: { name: "Slow", steps: 1 }, medium: { name: "Medium", steps: 2 }, fast: { name: "Fast", steps: 3 } };
  const STEP = { pushups: 1, squats: 2, planks: 5 };
  const MAX_FRIENDS = 10;
  const ERRORS = {
    too_many: "You're already in 4 challenges.",
    rate_limited: "That's enough new challenges for today.",
    not_friends: "Someone on the list isn't your friend anymore.",
    closed: "That challenge already started.",
    not_invited: "That invite isn't open anymore.",
  };
  const errorText = (reply) => ERRORS[reply && reply.error] || "Couldn't reach the server. Check your connection.";

  // list: the server's challenges (null until loaded), trophies, the draft
  // being set up, and the friends you can invite (null until loaded).
  const state = { userId: null, list: null, trophies: [], error: false, loading: null, draft: null, friends: null, opened: new Set(), view: null, sending: false };

  const signedIn = () => typeof currentUserId !== "undefined" && !!currentUserId;
  const timeZone = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch (error) {
      return "UTC";
    }
  };
  const challengeColor = (c) => (c.type === "rep" ? EXERCISES[c.exercise].color : TYPES[c.type].color);
  const challengeIcon = (c) => TYPES[c.type].icon;
  const nameOf = (c) => ForjaRules.challengeName(c);
  const tile = (color, icon, extra = "") => `<span class="challenge-tile ${extra}" style="--c:${color}">${icon}</span>`;
  const avatar = () => `<span class="leaderboard-avatar">${PERSON_ICON_SVG}</span>`;
  const backButton = (label, to) => `<button class="nav-back" data-ch-go="${to}">${ICON.back}${esc(label)}</button>`;
  const tipButton = (type) => `<button class="tip-btn challenge-tip-btn" data-ch-tip="${type}" aria-label="How it works" aria-expanded="false">i</button>`;
  const shortDate = (day) => {
    const [year, month, date] = day.split("-").map(Number);
    return new Date(year, month - 1, date).toLocaleDateString([], { month: "short", day: "numeric" });
  };

  // A score as people read it: reps, plank time, or distance in their unit.
  function scoreText(c, value) {
    if (c.type === "dist") return displayDistance(value / 1000);
    if (c.type === "rep" && c.exercise === "planks") return mmss(value);
    return String(value);
  }
  const scoreUnit = (c) => (c.type === "dist" ? distanceUnitLabel() : "");

  // ---------- loading ----------
  function load() {
    if (!ENABLED || !signedIn()) return Promise.resolve(null);
    if (state.userId !== currentUserId) {
      Object.assign(state, { userId: currentUserId, list: null, trophies: [], error: false, friends: null, opened: new Set() });
    }
    if (state.loading) return state.loading;
    const asking = currentUserId;
    state.loading = callServerFunction("challenge", { action: "list", timeZone: timeZone() }).then((reply) => {
      state.loading = null;
      // Signed out (or in as someone else) while it loaded: drop it.
      if (asking !== currentUserId) return null;
      if (reply && reply.ok) {
        state.list = reply.challenges;
        state.trophies = reply.trophies;
        state.error = false;
      } else {
        state.error = true;
      }
      return reply;
    });
    return state.loading;
  }

  async function loadFriends() {
    const { data: rows, error } = await supabaseClient
      .from("friendships")
      .select("requester_id, addressee_id")
      .eq("status", "accepted")
      .or(`requester_id.eq.${currentUserId},addressee_id.eq.${currentUserId}`);
    if (error) return null;
    const ids = (rows || []).map((f) => (f.requester_id === currentUserId ? f.addressee_id : f.requester_id));
    if (ids.length === 0) return [];
    const { data: profiles, error: profileError } = await supabaseClient.from("profiles").select("user_id, username").in("user_id", ids);
    if (profileError) return null;
    return (profiles || []).map((p) => ({ id: p.user_id, name: p.username })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- Competition tab ----------
  // Called every time the Competition tab opens (signed in, with a username).
  async function refresh() {
    if (!ENABLED || !signedIn()) {
      $("new-challenge-button").classList.add("hidden");
      $("challenges-section").classList.add("hidden");
      return;
    }
    $("new-challenge-button").classList.remove("hidden");
    $("challenges-section").classList.remove("hidden");
    renderList();
    await load();
    renderList();
    renderTrophies();
    openNewResult();
  }

  // Invites first, then the ones waiting to start, running, and finished.
  const ORDER = (c) => (c.myStatus === "invited" ? 0 : c.status === "pending" ? 1 : c.status === "running" ? 2 : 3);

  function myPlace(c) {
    const me = c.players.find((p) => p.you);
    return me ? 1 + c.players.filter((p) => p.score > me.score).length : null;
  }

  function startsText(c) {
    if (c.dayNumber === 0) return "Starts tomorrow";
    return c.dayNumber < 0 ? `Starts ${shortDate(c.startDay)}` : "Starting";
  }

  // The card's one status line: [plain part, bold part].
  function cardLine(c) {
    if (c.myStatus === "invited") return [`From ${c.from || "a friend"}`, ""];
    if (c.status === "cancelled") return ["Didn't start", "Nobody joined"];
    if (c.status === "ended") return ["Ended", c.myPlace === 1 ? "You won" : `You came ${ordinal(c.myPlace)}`];
    if (c.status === "pending") {
      const friends = c.joinedCount - 1 + c.invitedCount;
      return [startsText(c), c.fromYou ? `${c.joinedCount - 1} of ${friends} in` : "You're in"];
    }
    if (c.type === "rep" || c.type === "dist") {
      const day = c.dayNumber > c.days ? "Last day done" : `Day ${c.dayNumber} of ${c.days}`;
      return [day, `You're ${ordinal(myPlace(c))}`];
    }
    const me = c.players.find((p) => p.you);
    if (me && me.outDay !== null) return [`Day ${c.dayNumber}`, `Out on day ${me.outDay}`];
    const left = c.players.filter((p) => p.outDay === null).length;
    return [`Day ${c.dayNumber}`, c.type === "lms" ? `${left} left` : `${left} of ${c.players.length} still in`];
  }

  function card(c) {
    const [plain, bold] = cardLine(c);
    let end = `<span class="challenge-chevron">${ICON.chevron}</span>`;
    if (c.myStatus === "invited") end = '<span class="challenge-pill is-invite">Invite</span>';
    else if (c.status === "pending") end = '<span class="challenge-pill">Pending</span>';
    else if (c.status === "ended") end = '<span class="challenge-pill is-result">Results</span>';
    else if (c.status === "cancelled") end = "";
    return `
      <button class="challenge-card" data-ch-open="${esc(c.id)}">${tile(challengeColor(c), challengeIcon(c))}
        <span class="challenge-card-text"><span class="challenge-card-name">${esc(nameOf(c))}</span><span class="challenge-card-sub">${esc(plain)}${bold ? ` · <b>${esc(bold)}</b>` : ""}</span></span>
        ${end}
      </button>`;
  }

  function renderList() {
    const listEl = $("challenge-list");
    if (state.list === null) {
      listEl.innerHTML = state.error
        ? `<div class="challenge-message"><span>Couldn't load challenges.</span><button class="challenge-text-button" data-ch-act="retry">Try Again</button></div>`
        : "";
      return;
    }
    if (state.list.length === 0) {
      listEl.innerHTML = `<button class="challenge-new-row" data-ch-act="new">${ICON.plus}New Challenge</button>`;
      return;
    }
    listEl.innerHTML = [...state.list].sort((a, b) => ORDER(a) - ORDER(b)).map(card).join("");
  }

  // A result shows itself once, the first time you open the tab after a
  // challenge ends.
  function openNewResult() {
    const onTab = !$("app-screen").classList.contains("hidden") && !$("tab-competition").classList.contains("hidden");
    const fresh = (state.list || []).find((c) => c.unseenResult && !state.opened.has(c.id));
    if (onTab && fresh) resultView(fresh);
  }

  // ---------- the challenge screen (one screen, redrawn per view) ----------
  function show(html, view) {
    closeTip();
    state.view = view;
    $("challenge-screen").innerHTML = html;
    showScreen("challenge-screen");
    window.scrollTo(0, 0);
  }

  function backToTab() {
    closeTip();
    state.view = null;
    showScreen("app-screen");
    showTab("competition");
  }

  function typeView() {
    show(
      `
      ${backButton("Competition", "tab")}
      <h1 class="large-title">New Challenge</h1>
      <div class="challenge-picks">${Object.entries(TYPES).map(([key, t]) => `
        <button class="challenge-pick" data-ch-type="${key}">${tile(t.color, t.icon)}
          <span class="challenge-pick-text"><b>${t.name}</b><span>${t.line}</span></span>
          <span class="challenge-chevron">${ICON.chevron}</span></button>`).join("")}
      </div>`,
      "type"
    );
  }

  // Climb's Day 1 starts from your own plan (or minimums), never below the
  // floors the server enforces.
  function myTargets() {
    try {
      if (typeof serverPlan !== "undefined" && serverPlan) return { ...ForjaRules.planOn(serverPlan, todayString()).plan.targets };
    } catch (error) {
      // fall through to the minimums
    }
    const m = (typeof data !== "undefined" && data && data.minimums) || {};
    return { pushups: m.pushups || 10, squats: m.squats || 16, planks: m.planks || 30 };
  }

  function newDraft(type, from) {
    const targets = myTargets();
    Object.keys(targets).forEach((key) => (targets[key] = Math.max(ForjaRules.FLOORS[key], targets[key])));
    return { type, exercise: "pushups", days: 7, targets, speed: "medium", friends: new Set(), ...from };
  }

  function segmented(name, options, current, label) {
    return `<div class="plan-pace challenge-seg" style="grid-template-columns:repeat(${options.length},1fr)" role="radiogroup" aria-label="${label}">${options
      .map(([value, text]) => `<button role="radio" aria-checked="${String(value) === String(current)}" data-ch-set="${name}" data-ch-val="${value}">${text}</button>`)
      .join("")}</div>`;
  }

  const climbLine = (n) => `+${n * STEP.pushups} push-up${n > 1 ? "s" : ""} · +${n * STEP.squats} squats · +${mmss(n * STEP.planks)} plank a day`;

  function setupView() {
    const d = state.draft;
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
    show(
      `
      ${backButton("New Challenge", "type")}
      <div class="challenge-setup-head">
        ${tile(challengeColor(d), TYPES[d.type].icon, "is-large")}
        <div class="challenge-title-row"><h1 class="large-title">${esc(nameOf(d))}</h1>${tipButton(d.type)}</div>
      </div>
      ${body}
      <p class="challenge-starts">Starts tomorrow</p>
      <button class="auth-submit-button" data-ch-go="friends">Next</button>`,
      "setup"
    );
  }

  function sendLabel() {
    const n = state.draft.friends.size;
    if (state.sending) return "Sending...";
    return n ? `Send ${n} Invite${n > 1 ? "s" : ""}` : "Pick a Friend";
  }

  async function friendsView() {
    const d = state.draft;
    const draw = () => {
      let rows;
      if (state.friends === null) rows = `<p class="preview-note">Loading friends...</p>`;
      else if (state.friends === false) rows = `<div class="challenge-message"><span>Couldn't load your friends.</span><button class="challenge-text-button" data-ch-act="friends-retry">Try Again</button></div>`;
      else if (state.friends.length === 0) rows = `<p class="preview-note">Add friends on the Competition tab first.</p>`;
      else {
        rows = `<div class="leaderboard">${state.friends.map((f) => `
          <button class="leaderboard-row challenge-friend" role="checkbox" aria-checked="${d.friends.has(f.id)}" data-ch-friend="${esc(f.id)}">
            ${avatar()}<span class="leaderboard-name">${esc(f.name)}</span><span class="challenge-check">${ICON.check}</span></button>`).join("")}
        </div>`;
      }
      show(
        `
        ${backButton(nameOf(d), "setup")}
        <h1 class="large-title">Invite Friends</h1>
        ${rows}
        <button id="challenge-send-button" class="auth-submit-button" data-ch-act="send" ${d.friends.size && !state.sending ? "" : "disabled"}>${sendLabel()}</button>`,
        "friends"
      );
    };
    draw();
    if (!state.friends) {
      state.friends = null;
      const friends = await loadFriends();
      state.friends = friends === null ? false : friends;
      // Drop anyone preselected (a rematch) who isn't a friend anymore.
      if (state.friends) d.friends = new Set([...d.friends].filter((id) => state.friends.some((f) => f.id === id)));
      if (state.view === "friends") draw();
    }
  }

  async function send() {
    const d = state.draft;
    if (state.sending || d.friends.size === 0) return;
    state.sending = true;
    friendsSendButton();
    const body = { action: "create", type: d.type, friendIds: [...d.friends], timeZone: timeZone() };
    if (d.type === "rep") Object.assign(body, { exercise: d.exercise, days: d.days });
    if (d.type === "dist") body.days = d.days;
    if (d.type === "climb") Object.assign(body, { speed: SPEEDS[d.speed].steps, climb: { ...d.targets } });
    const reply = await callServerFunction("challenge", body);
    state.sending = false;
    if (!reply.ok) {
      friendsSendButton();
      return toast(errorText(reply));
    }
    state.draft = null;
    backToTab();
    toast("Invites sent");
  }

  function friendsSendButton() {
    const button = $("challenge-send-button");
    if (!button) return;
    button.textContent = sendLabel();
    button.disabled = state.sending || state.draft.friends.size === 0;
  }

  // ---------- running challenges ----------
  function dayBar(done, total, color) {
    return `<div class="challenge-days" style="--c:${color}">${Array.from({ length: total }, (_, k) => `<span class="${k < done ? "is-done" : ""}"></span>`).join("")}</div>`;
  }

  // Ranked rows with a bar against the leader; `final` drops the "today" line.
  function standings(c, final) {
    const max = Math.max(1, ...c.players.map((p) => p.score));
    return `<div class="challenge-standings" style="--c:${challengeColor(c)}">${c.players.map((p) => {
      const place = 1 + c.players.filter((other) => other.score > p.score).length;
      const today = p.today > 0 ? `${ICON.up}${esc(scoreText(c, p.today))}${c.type === "dist" ? ` ${scoreUnit(c)}` : ""} today` : "Nothing yet today";
      return `
      <div class="challenge-standing ${p.you ? "is-you" : ""}">
        <span class="leaderboard-rank ${place === 1 ? "is-first" : ""}">${place}</span>${avatar()}
        <span class="challenge-standing-who"><span class="leaderboard-name">${esc(p.name)}</span>${final ? "" : `<span class="challenge-standing-note ${p.today > 0 ? "is-up" : ""}">${today}</span>`}</span>
        <span class="challenge-standing-value">${esc(scoreText(c, p.score))}${scoreUnit(c) ? `<small>${scoreUnit(c)}</small>` : ""}</span>
        <span class="challenge-standing-bar"><i style="width:${Math.round((p.score / max) * 100)}%"></i></span>
      </div>`;
    }).join("")}</div>`;
  }

  // Who's still in: done today, not yet, or out (Last One Standing, Climb).
  function inOutRows(c, final) {
    const icon = (p) => (p.outDay !== null ? `<span class="challenge-state is-out">${ICON.x}</span>` : p.doneToday ? `<span class="challenge-state is-done">${ICON.check}</span>` : `<span class="challenge-state is-waiting">${ICON.clock}</span>`);
    const stillIn = c.players.filter((p) => p.outDay === null).length;
    const finalNote = stillIn === 1 ? "Last one standing" : "Made it to the end";
    const note = (p) => (p.outDay !== null ? `Out on day ${p.outDay}` : final ? finalNote : p.doneToday ? "Done today" : "Not yet today");
    return `<div class="challenge-standings">${c.players.map((p) => `
      <div class="challenge-standing no-rank ${p.you ? "is-you" : ""} ${p.outDay !== null ? "is-out" : ""}">
        ${avatar()}
        <span class="challenge-standing-who"><span class="leaderboard-name">${esc(p.name)}</span><span class="challenge-standing-note">${note(p)}</span></span>
        ${final ? "" : icon(p)}
      </div>`).join("")}</div>`;
  }

  function header(c) {
    const long = c.type === "lms";
    return `
      ${backButton("Competition", "tab")}
      <div class="challenge-title-row">${tile(challengeColor(c), challengeIcon(c))}<h1 class="large-title ${long ? "is-long" : ""}">${esc(nameOf(c))}</h1>${tipButton(c.type)}</div>`;
  }

  function raceStatus(c) {
    const me = c.players.find((p) => p.you);
    const others = c.players.filter((p) => !p.you);
    const best = Math.max(...others.map((p) => p.score));
    const unit = scoreUnit(c) ? ` ${scoreUnit(c)}` : "";
    if (me.score > best) return `${scoreText(c, me.score - best)}${unit} ahead`;
    if (me.score === best) return "Tied for 1st";
    const leader = others.find((p) => p.score === best);
    return `${scoreText(c, best - me.score)}${unit} behind ${leader.name}`;
  }

  function detailView(c) {
    const color = challengeColor(c);
    let html;
    if (c.type === "rep" || c.type === "dist") {
      const day = Math.min(c.dayNumber, c.days);
      html = `
        ${header(c)}
        ${dayBar(day, c.days, color)}
        <p class="challenge-status">Day ${day} of ${c.days} · <b>${esc(raceStatus(c))}</b></p>
        ${standings(c, false)}
        ${c.type === "rep"
          ? `<button class="auth-submit-button challenge-icon-button" data-ch-act="camera" data-ch-exercise="${EXERCISES[c.exercise].camera}">${ICON.camera}Do a Set</button>`
          : `<button class="auth-submit-button" data-ch-act="record">Start a Walk</button>`}`;
    } else {
      const left = c.players.filter((p) => p.outDay === null).length;
      const me = c.players.find((p) => p.you);
      const targets = c.targets
        ? `<div class="plan-card"><div class="plan-targets">${Object.entries(EXERCISES)
            .map(([key, ex]) => `<div><div class="plan-target-value">${key === "planks" ? mmss(c.targets.today[key]) : c.targets.today[key]}</div><div class="plan-target-name"><i style="background:${ex.color}"></i>${ex.name}</div></div>`)
            .join("")}</div>
            <p class="challenge-tomorrow">Tomorrow <b>${c.targets.tomorrow.pushups} · ${c.targets.tomorrow.squats} · ${mmss(c.targets.tomorrow.planks)}</b></p></div>`
        : "";
      html = `
        ${header(c)}
        <p class="challenge-status is-spaced">Day ${c.dayNumber} · <b>${c.type === "lms" ? `${left} of ${c.players.length} left` : `${left} of ${c.players.length} still in`}</b></p>
        ${targets}
        ${inOutRows(c, false)}
        ${me && me.outDay === null ? `<button class="auth-submit-button" data-ch-act="today">Do Today's Plan</button>` : ""}`;
    }
    show(html, `detail:${c.id}`);
  }

  // Shown from the list straight away, then again with fresh numbers.
  async function openDetail(c) {
    detailView(c);
    await load();
    const fresh = (state.list || []).find((x) => x.id === c.id);
    if (fresh && fresh.status === "running" && state.view === `detail:${c.id}`) detailView(fresh);
  }

  // ---------- results ----------
  function resultView(c) {
    state.opened.add(c.id);
    if (c.unseenResult) {
      c.unseenResult = false;
      callServerFunction("challenge", { action: "seen", challengeId: c.id });
    }
    const won = c.myPlace === 1;
    const colors = ["var(--trophy)", "var(--accent)", "var(--ring-pushups)", "var(--ring-squats)"];
    const sparks = won
      ? Array.from({ length: 16 }, (_, k) => {
          const angle = (k / 16) * Math.PI * 2;
          const r = 64 + (k % 3) * 10;
          return `<i style="--dx:${Math.round(Math.cos(angle) * r)}px;--dy:${Math.round(Math.sin(angle) * r)}px;--k:${colors[k % 4]}"></i>`;
        }).join("")
      : "";
    const racing = c.type === "rep" || c.type === "dist";
    show(
      `
      ${backButton("Competition", "tab")}
      <div class="challenge-result">
        ${won ? `<div class="challenge-burst">${sparks}<span class="challenge-trophy">${ICON.trophy}</span></div>` : tile(challengeColor(c), challengeIcon(c), "is-large challenge-result-tile")}
        <h1 class="large-title">${won ? "You won!" : `${ordinal(c.myPlace)} place`}</h1>
        <p class="screen-subtitle">${esc(nameOf(c))}${racing ? ` · ${c.days} days` : ""}</p>
        ${racing ? standings(c, true) : inOutRows(c, true)}
      </div>
      <button class="auth-submit-button" data-ch-act="rematch" data-ch-id="${esc(c.id)}">Rematch</button>
      <button class="challenge-text-button" data-ch-go="tab">Done</button>`,
      `result:${c.id}`
    );
  }

  // ---------- invite sheet ----------
  function openInvite(c) {
    const scrim = document.createElement("div");
    scrim.className = "challenge-scrim";
    scrim.dataset.chAct = "close-sheet";
    const players = c.joinedCount + c.invitedCount;
    scrim.innerHTML = `
      <div class="challenge-sheet" role="dialog" aria-modal="true" aria-label="Challenge invite">
        <span class="challenge-grabber"></span>
        ${tile(challengeColor(c), challengeIcon(c), "is-large")}
        <p class="challenge-sheet-from"><b>${esc(c.from || "A friend")}</b> challenged you</p>
        <h2>${esc(nameOf(c))}</h2>
        <div class="challenge-faces">${avatar().repeat(Math.min(players, 6))}</div>
        <p class="challenge-sheet-meta">${players} players · ${esc(startsText(c))}</p>
        <button class="auth-submit-button" data-ch-act="accept" data-ch-id="${esc(c.id)}">Accept</button>
        <button class="challenge-text-button is-muted" data-ch-act="decline" data-ch-id="${esc(c.id)}">Decline</button>
      </div>`;
    document.body.appendChild(scrim);
    scrim.querySelector("[data-ch-act=accept]").focus();
  }
  const closeInvite = () => document.querySelectorAll(".challenge-scrim").forEach((el) => el.remove());

  async function respond(id, accept, button) {
    if (button.disabled) return;
    button.disabled = true;
    const reply = await callServerFunction("challenge", { action: "respond", challengeId: id, accept, timeZone: timeZone() });
    closeInvite();
    if (!reply.ok) toast(errorText(reply));
    else if (accept) toast("You're in. Starts tomorrow");
    await load();
    renderList();
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

  // ---------- Me tab ----------
  async function showTrophies() {
    if (!ENABLED || !signedIn()) return $("trophies-section").classList.add("hidden");
    renderTrophies();
    if (state.list === null) {
      await load();
      renderTrophies();
    }
  }

  function renderTrophies() {
    const section = $("trophies-section");
    if (!ENABLED || !signedIn() || state.trophies.length === 0) return section.classList.add("hidden");
    $("trophy-shelf").innerHTML = state.trophies
      .map((t) => `<div class="trophy-tile">${ICON.trophy}<b>${esc(t.name)}</b><span>${esc(new Date(t.endedAt).toLocaleDateString([], { month: "short", day: "numeric" }))}</span></div>`)
      .join("");
    section.classList.remove("hidden");
  }

  // ---------- taps ----------
  const find = (id) => (state.list || []).find((c) => c.id === id);

  document.addEventListener("click", (event) => {
    if (!ENABLED) return;
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
    if (el.dataset.chOpen) {
      const c = find(el.dataset.chOpen);
      if (!c) return;
      if (c.myStatus === "invited") return openInvite(c);
      if (c.status === "pending") return toast(startsText(c));
      if (c.status === "cancelled") return toast("Nobody joined, so it didn't start");
      if (c.status === "ended") return resultView(c);
      return openDetail(c);
    }
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
      const id = el.dataset.chFriend;
      if (d.friends.has(id)) d.friends.delete(id);
      else if (d.friends.size < MAX_FRIENDS) d.friends.add(id);
      el.setAttribute("aria-checked", String(d.friends.has(id)));
      return friendsSendButton();
    }

    switch (el.dataset.chAct) {
      case "new":
        return typeView();
      case "retry":
        state.error = false;
        return refresh();
      case "friends-retry":
        state.friends = null;
        return friendsView();
      case "close-sheet":
        if (event.target === el) closeInvite();
        return;
      case "accept":
        return respond(el.dataset.chId, true, el);
      case "decline":
        return respond(el.dataset.chId, false, el);
      case "send":
        return send();
      case "rematch": {
        // Same settings and the same people, ready to adjust and send.
        const c = find(el.dataset.chId);
        if (!c) return;
        const friends = new Set(c.players.filter((p) => !p.you).map((p) => p.userId));
        const speed = Object.keys(SPEEDS).find((key) => SPEEDS[key].steps === c.speed) || "medium";
        state.draft = newDraft(c.type, { exercise: c.exercise || "pushups", days: c.days || 7, speed, friends });
        return setupView();
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

  return { refresh, showTrophies };
})();
