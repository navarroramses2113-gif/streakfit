// STEP 1: Connect to Supabase and load the signed-in user's data.
//
// Data used to live only in this browser's localStorage. Now it lives in
// a real database, so it works across devices and survives clearing your
// browser. localStorage is still read ONCE, as a one-time source to carry
// over any progress you already had into your new account.

const SUPABASE_URL = "https://wiixtjykewtqvpxqwtor.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpaXh0anlrZXd0cXZweHF3dG9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyMTI3ODIsImV4cCI6MjEwNTc4ODc4Mn0.WKij4ltTLv_qNfKrT5vO8y1tyjQk2IAdz7WYDTemS80";

// The PUBLIC half of a VAPID key pair - safe to expose client-side, same
// trust level as the Supabase anon key above. It just proves to the push
// service (Apple's, Google's, etc.) which server is allowed to send to a
// given subscription; it can't be used to send anything by itself. The
// PRIVATE half lives only server-side, never in this file.
const VAPID_PUBLIC_KEY = "BDbknJwLFn1rKbU5fImh75k6LHtrktnNi_kMwOAWonpds6RyrzuOa16QBIfqbR4rOWSNEuXccvgCM1fJfFGF2PY";

// A password reset link opens the app with "type=recovery" in the address
// (or with an error, when the link expired or was already used). Read it
// before Supabase takes it out of the address: while a reset is under way,
// nothing may drop the person into the app until they've set a new
// password - Supabase reports the link's session first, and only then
// that it's a reset.
const linkParams = new URLSearchParams(window.location.hash.slice(1));
let inPasswordRecovery = linkParams.get("type") === "recovery";
let resetLinkFailed = linkParams.has("error") && !inPasswordRecovery;

// An invite link (?i=<code>) and where a visitor came from (?src=tiktok,
// for the numbers). Both are kept on this phone until they're used: the
// person may sign up later, or log in to an account they already have.
// They're taken out of the address so a reload or a screenshot of the
// address bar doesn't carry them on.
const INVITE_KEY = "forja-invite";
const SOURCE_KEY = "forja-signup-source";
(function readInviteLink() {
  const params = new URLSearchParams(window.location.search);
  const code = (params.get("i") || "").trim().toLowerCase();
  const source = (params.get("src") || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  try {
    if (/^[a-f0-9]{10}$/.test(code)) localStorage.setItem(INVITE_KEY, JSON.stringify({ code, at: Date.now() }));
    // The first place someone came from is the one that counts.
    if (!localStorage.getItem(SOURCE_KEY) && (source || code)) localStorage.setItem(SOURCE_KEY, source || "invite");
  } catch (e) {
    // storage blocked - the link just won't be remembered
  }
  if (params.has("i") || params.has("src")) {
    params.delete("i");
    params.delete("src");
    const rest = params.toString();
    history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
  }
})();

// `supabase` (lowercase, no "Client") is the global the CDN script tag
// creates. We name OUR instance `supabaseClient` so the two don't clash.
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Which user is currently logged in, and their data. Both start out
// empty - they only get filled in once we hear back from Supabase about
// who (if anyone) is signed in.
let currentUserId = null;
let data = null;
// The account whose data finished loading onto the screen (see showApp).
let shownUserId = null;

// Today logs itself (see maybeCompleteDay): true while it's being saved,
// and true after a save that failed, until the next attempt.
let savingDay = false;
let saveDayFailed = false;
// A guest's first completed day earns a sign-up invite (inviteGuestToSignUp).
let signupInvitePending = false;
// A signed-in player's progressive overload plan, as the server keeps it
// (see applyPlanTargets). Guests don't have one yet.
let serverPlan = null;

// `minimums.walkRun` is either a number of minutes (tracking enabled)
// or null (not tracking walk/run at all).
function defaultData() {
  return {
    streak: 0,
    bestStreak: 0,
    lastLoggedDate: null,
    history: [],
    minimums: { pushups: 10, planks: 30, squats: 10, walkRun: null },
    restDaysUsed: 0,
    weekStartDate: null,
    units: "miles",
    // Every KEPT route, forever - {date, distanceKm, durationMs,
    // encodedRoute}. encodedRoute is a compressed string (see the
    // simplifyRoute/encodePolyline functions below), not raw GPS points.
    routes: [],
    // The local hour (0-23) the daily reminder push should fire at, and
    // the IANA timezone (e.g. "America/New_York") to interpret it in -
    // captured automatically when reminders are enabled, not asked for
    // directly. reminderTimezone is null until reminders are turned on at
    // least once; the server-side reminder function treats that as "never
    // configured" and skips sending to that user.
    reminderHour: 19,
    reminderTimezone: null,
    // Today's camera-verified totals, kept here (not in the page) so they
    // survive a reload and sync with the account:
    // {date, pushups, planks (best single hold, seconds), squats, walkRun
    // (minutes), sets: [{exercise, value, at}]}. Replaced by a fresh one
    // the first time it's read on a new day - see todayProgress().
    today: null,
  };
}

// Fills in any fields older saved data (local OR cloud) might be missing,
// so the rest of the app can always assume every field exists. Shared by
// both data sources below instead of duplicating the same checks twice.
function migrateData(parsed) {
  if (!parsed.history) parsed.history = [];
  if (!parsed.minimums) parsed.minimums = { pushups: 10, planks: 30, squats: 10, walkRun: null };
  // Planks replaced sit-ups. The old value was a rep count, so carrying it
  // over as seconds would make the minimum trivially easy - start at 30s.
  if (parsed.minimums.planks === undefined) parsed.minimums.planks = 30;
  delete parsed.minimums.situps;
  if (parsed.minimums.walkRun === undefined) parsed.minimums.walkRun = null;
  if (parsed.restDaysUsed === undefined) {
    parsed.restDaysUsed = 0;
    parsed.weekStartDate = null;
  }
  if (!parsed.units) parsed.units = "miles";
  if (parsed.reminderHour === undefined) parsed.reminderHour = 19;
  if (parsed.reminderTimezone === undefined) parsed.reminderTimezone = null;
  if (parsed.today === undefined) parsed.today = null;

  // One-time migration from the old lastRoute/routeLog fields (which
  // only ever kept one full route plus a distance-only log of the rest)
  // into the new permanent `routes` array.
  if (!parsed.routes) {
    parsed.routes = (parsed.routeLog || []).map((entry) => ({
      date: entry.date,
      distanceKm: entry.distanceKm,
      durationMs: null,
      encodedRoute: null, // the old log never stored the actual path
    }));

    if (parsed.lastRoute) {
      const encodedRoute = encodePolyline(simplifyRoute(parsed.lastRoute.route, ROUTE_SIMPLIFY_TOLERANCE));
      const existing = parsed.routes.find((r) => r.date === parsed.lastRoute.date);
      if (existing) {
        existing.durationMs = parsed.lastRoute.durationMs;
        existing.encodedRoute = encodedRoute;
      } else {
        parsed.routes.push({
          date: parsed.lastRoute.date,
          distanceKm: parsed.lastRoute.distanceKm,
          durationMs: parsed.lastRoute.durationMs,
          encodedRoute,
        });
      }
    }
  }
  delete parsed.lastRoute;
  delete parsed.routeLog;

  return parsed;
}

// Reads whatever THIS BROWSER saved before accounts existed. Used only
// once per account, to migrate a first-time user's existing progress
// instead of silently starting them over at zero.
function loadLocalData() {
  const saved = localStorage.getItem("streakfit-data");
  if (!saved) return null;
  return migrateData(JSON.parse(saved));
}

// Fetches this user's row from the database. `async` marks this as a
// function that does its work over time (a network request) rather than
// instantly - callers use `await` to pause until it's actually done.
//
// Returns null if the row can't be read. A failed read (no signal, or a
// login token that expired while the phone slept) must never be taken
// for "brand new account": that once saved empty data over a real
// account's history.
async function loadUserData(userId) {
  const readRow = () => supabaseClient.from("user_progress").select("data").eq("user_id", userId).maybeSingle();

  for (let attempt = 1; ; attempt++) {
    const { data: row, error } = await readRow();
    if (!error && row) return { data: migrateData(row.data), isNewAccount: false };
    if (!error) break; // read fine, there's just no row yet
    if (attempt === 3) return null;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }

  // Brand new account - seed it from any existing local progress, or
  // plain defaults if there isn't any. Insert only: if a row turns out to
  // exist after all, it's left alone and read instead.
  const initialData = loadLocalData() || defaultData();
  const { data: inserted, error: insertError } = await supabaseClient
    .from("user_progress")
    .upsert({ user_id: userId, data: initialData, updated_at: new Date().toISOString() }, { onConflict: "user_id", ignoreDuplicates: true })
    .select("user_id");
  if (insertError) return null;
  if (inserted.length > 0) return { data: initialData, isNewAccount: true };
  const { data: row, error } = await readRow();
  return !error && row ? { data: migrateData(row.data), isNewAccount: false } : null;
}

// When a signed-in player's data can't be loaded: say so, with a way to
// try again, instead of opening the app on empty data (which would then
// be saved over theirs).
function showLoadError(retry) {
  let screen = document.getElementById("load-error-screen");
  if (!screen) {
    screen = document.createElement("div");
    screen.id = "load-error-screen";
    screen.className = "load-error-screen";
    screen.setAttribute("role", "alertdialog");
    screen.setAttribute("aria-labelledby", "load-error-text");
    screen.innerHTML = `<p id="load-error-text">Couldn't load your account. Check your connection.</p><button class="auth-submit-button">Try Again</button>`;
    document.body.appendChild(screen);
  }
  const button = screen.querySelector("button");
  button.disabled = false;
  button.onclick = () => {
    button.disabled = true;
    screen.remove();
    retry();
  };
  hideSplash();
  button.focus();
}

// Saves the given data into this user's row, creating it if it doesn't
// exist yet ("upsert" = update if present, insert if not).
async function saveUserData(userId, dataToSave) {
  await supabaseClient.from("user_progress").upsert({
    user_id: userId,
    data: dataToSave,
    updated_at: new Date().toISOString(),
  });
}

// Called the exact same way it always was everywhere else in this file.
// Logged in -> saves to the database. Not logged in (guest) -> saves to
// this browser's localStorage, exactly like the app worked before
// accounts existed - so you can use it fully before ever signing up.
function saveData(dataToSave) {
  if (currentUserId) {
    saveUserData(currentUserId, dataToSave);
  } else {
    localStorage.setItem("streakfit-data", JSON.stringify(dataToSave));
  }
}


// STEP 2: Grab references to the HTML elements we need to update.
//
// document.getElementById(...) finds an element by its `id` attribute
// (the same ids we wrote in index.html) so we can read or change it
// from JavaScript.

const streakCountEl = document.getElementById("streak-count");
const statusMessageEl = document.getElementById("status-message");
const retryLogButtonEl = document.getElementById("retry-log-button");
const errorMessageEl = document.getElementById("error-message");
const bestStreakCountEl = document.getElementById("best-streak-count");

const pushupsEl = document.getElementById("pushups");
const planksEl = document.getElementById("planks");
const squatsEl = document.getElementById("squats");
const walkrunEl = document.getElementById("walkrun");
const walkrunRowEl = document.getElementById("walkrun-row");

// Closure ring: ONE circle's worth of circumference, divided into equal
// arc segments (one per active exercise) instead of Apple's separate
// concentric ring per metric. All segments share the same radius, so
// "dividing the ring" just means giving each segment its own slice of
// one shared circumference via dasharray/dashoffset.
const RING_RADIUS = 50;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
// Gap between segments, in the same path-length units as the
// circumference above. Needs to be at least roughly one stroke-width so
// the rounded caps on either side of a gap (which each bulge outward by
// half the stroke-width) don't visually touch or overlap.
const RING_SEGMENT_GAP = 20;

const RING_CONFIG = [
  { key: "pushups", trackEl: document.getElementById("segment-track-pushups"), progressEl: document.getElementById("ring-pushups") },
  { key: "planks", trackEl: document.getElementById("segment-track-planks"), progressEl: document.getElementById("ring-planks") },
  { key: "squats", trackEl: document.getElementById("segment-track-squats"), progressEl: document.getElementById("ring-squats") },
  { key: "walkrun", trackEl: document.getElementById("segment-track-walkrun"), progressEl: document.getElementById("ring-walkrun") },
];

RING_CONFIG.forEach((ring) => {
  ring.wasClosed = false;
});

// Carves this ring's own slice out of the shared circle: `startOffset` is
// how far clockwise (in path-length units) this slice begins, `span` is
// how much of the circle it's allotted, and `fraction` (0-1) is how much
// of ITS OWN slice is currently filled. Plays the "closure" pulse exactly
// once, the moment this segment crosses from not-yet-done into done.
// A slice whose set was just saved stays where it was until Today is back
// on screen; then celebrations.js grows it (see Celebrations.ringShown).
function setSegmentProgress(ring, startOffset, span, fraction, ignoreHold) {
  const trackLength = Math.max(span - RING_SEGMENT_GAP, 0);
  const shown = !ignoreHold && typeof Celebrations !== "undefined" ? Celebrations.ringShown(ring.key, fraction) : fraction;
  const clamped = Math.max(0, Math.min(1, shown));
  const progressLength = trackLength * clamped;

  ring.trackEl.style.strokeDasharray = `${trackLength} ${RING_CIRCUMFERENCE - trackLength}`;
  ring.trackEl.style.strokeDashoffset = `${-startOffset}`;

  ring.progressEl.style.strokeDasharray = `${progressLength} ${RING_CIRCUMFERENCE - progressLength}`;
  ring.progressEl.style.strokeDashoffset = `${-startOffset}`;

  const isClosed = clamped >= 1;
  if (isClosed && !ring.wasClosed) {
    ring.progressEl.classList.remove("ring-closed");
    // Forces the browser to acknowledge the class is gone before adding
    // it back, so the animation replays instead of silently no-op'ing
    // (a class that's already present doesn't restart a CSS animation).
    void ring.progressEl.offsetWidth;
    ring.progressEl.classList.add("ring-closed");
  }
  ring.wasClosed = isClosed;
}

// `forceComplete` mirrors how the old single progress bar worked: once
// the day is actually logged, every segment shows fully closed regardless
// of the (now-disabled) input values - including when a rest day was used
// to cover a gap rather than every exercise truly hitting its minimum.
function updateRings(forceComplete) {
  const walkRunEnabled = data.minimums.walkRun !== null;
  document.getElementById("segment-track-walkrun").classList.toggle("hidden", !walkRunEnabled);
  document.getElementById("ring-walkrun").classList.toggle("hidden", !walkRunEnabled);
  document.getElementById("rings-legend-walkrun").classList.toggle("hidden", !walkRunEnabled);

  const activeRings = walkRunEnabled ? RING_CONFIG : RING_CONFIG.slice(0, 3);
  const segmentSpan = RING_CIRCUMFERENCE / activeRings.length;

  const fractions = forceComplete
    ? activeRings.map(() => 1)
    : [
        Number(pushupsEl.value) / Math.max(data.minimums.pushups, 1),
        Number(planksEl.value) / Math.max(data.minimums.planks, 1),
        Number(squatsEl.value) / Math.max(data.minimums.squats, 1),
        walkRunEnabled ? Number(walkrunEl.value) / Math.max(data.minimums.walkRun, 1) : 0,
      ];

  activeRings.forEach((ring, index) => {
    setSegmentProgress(ring, index * segmentSpan, segmentSpan, fractions[index]);
  });
}

// Draws one slice at `fraction` right now, held or not - one frame of the
// fill animation in celebrations.js.
function drawRingSlice(key, fraction) {
  const activeRings = data.minimums.walkRun !== null ? RING_CONFIG : RING_CONFIG.slice(0, 3);
  const index = activeRings.findIndex((ring) => ring.key === key);
  if (index === -1) return;
  const span = RING_CIRCUMFERENCE / activeRings.length;
  setSegmentProgress(activeRings[index], index * span, span, fraction, true);
}

// The day closing: every slice grows across the gap after it until the
// ring is whole (t 0 -> 1) - one frame of it, for celebrations.js.
function drawRingClosing(t) {
  const activeRings = data.minimums.walkRun !== null ? RING_CONFIG : RING_CONFIG.slice(0, 3);
  const span = RING_CIRCUMFERENCE / activeRings.length;
  activeRings.forEach((ring, index) => {
    const length = span - RING_SEGMENT_GAP + (RING_SEGMENT_GAP + 0.5) * t;
    ring.progressEl.style.strokeDasharray = `${length} ${RING_CIRCUMFERENCE - length}`;
    ring.progressEl.style.strokeDashoffset = `${-index * span}`;
  });
}

const pushupsMinTagEl = document.getElementById("pushups-min-tag");
const planksMinTagEl = document.getElementById("planks-min-tag");
const squatsMinTagEl = document.getElementById("squats-min-tag");
const walkrunMinTagEl = document.getElementById("walkrun-min-tag");

const minPushupsEl = document.getElementById("min-pushups");
const minPlanksEl = document.getElementById("min-planks");
const minSquatsEl = document.getElementById("min-squats");
const enableWalkrunEl = document.getElementById("enable-walkrun");
const minWalkrunEl = document.getElementById("min-walkrun");
const minWalkrunRowEl = document.getElementById("min-walkrun-row");
const distanceUnitsEl = document.getElementById("distance-units");
const saveMinimumsEl = document.getElementById("save-minimums");

// Shows/hides the minutes input the instant the checkbox is toggled,
// without waiting for Save - so it's obvious what you're about to set.
enableWalkrunEl.addEventListener("change", () => {
  minWalkrunRowEl.classList.toggle("hidden", !enableWalkrunEl.checked);
});

// STEP 2b: Account menu on the Me tab - Edit Profile, Share Profile,
// Daily Minimums (what a day asks of you) and Settings (how the app
// behaves). Opening one panel closes the others.

const editProfilePanelEl = document.getElementById("edit-profile-panel");
const minimumsPanelEl = document.getElementById("minimums-panel");
const settingsPanelEl = document.getElementById("settings-panel");

function showOnlyPanel(panelToShow) {
  [editProfilePanelEl, minimumsPanelEl, settingsPanelEl].forEach((panel) => {
    if (panel !== panelToShow) panel.classList.add("hidden");
  });
}

document.getElementById("open-account-screen-button").addEventListener("click", () => {
  showScreen("account-screen");
});

document.getElementById("account-screen-close-button").addEventListener("click", () => {
  showScreen("app-screen");
});

// Light/Dark appearance. Stored on this device (localStorage) rather than
// in the account data, because it's a per-screen preference - someone can
// reasonably want a dark phone and a light laptop. The inline script in
// index.html's <head> applies it before first paint; this handles
// changing it afterward.
const themeSelectEl = document.getElementById("theme-select");

function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

themeSelectEl.value = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";

// Everything in Settings saves the moment it changes; this little note
// confirms it.
function showSettingSaved() {
  const statusEl = document.getElementById("settings-status");
  statusEl.textContent = "Saved.";
  statusEl.classList.add("success");
}

themeSelectEl.addEventListener("change", () => {
  applyTheme(themeSelectEl.value);
  try {
    localStorage.setItem("forja-theme", themeSelectEl.value);
  } catch (e) {
    // Storage blocked (private browsing etc.) - the theme still applies
    // for this session, it just won't be remembered.
  }
  showSettingSaved();
});

// Units change how every distance reads - your walks, your charts, and
// friends' runs in the Feed - so redraw what shows distances right away.
distanceUnitsEl.addEventListener("change", () => {
  data.units = distanceUnitsEl.value;
  saveData(data);
  renderDistanceChart();
  renderPastRoutesList();
  renderBodyWeightInput(); // lb <-> kg
  showSettingSaved();
});

document.getElementById("open-minimums-button").addEventListener("click", () => {
  // Signed in, this menu item is "My Plan"; guests set their own minimums.
  if (currentUserId) {
    openMyPlan();
    return;
  }
  showOnlyPanel(minimumsPanelEl);
  minimumsPanelEl.classList.toggle("hidden");
  if (!minimumsPanelEl.classList.contains("hidden")) {
    // Always open on what's actually saved, with no leftover message.
    renderSettingsInputs();
    document.getElementById("minimums-status").textContent = "";
  }
});

document.getElementById("open-settings-button").addEventListener("click", () => {
  showOnlyPanel(settingsPanelEl);
  settingsPanelEl.classList.toggle("hidden");
  if (!settingsPanelEl.classList.contains("hidden")) {
    renderSettingsInputs();
    document.getElementById("settings-status").textContent = "";
    refreshRemindersToggle();
    refreshLeaguesSetting();
  }
});

document.getElementById("edit-profile-button").addEventListener("click", async () => {
  showOnlyPanel(editProfilePanelEl);
  document.getElementById("edit-profile-error").textContent = "";

  const {
    data: { user },
  } = await supabaseClient.auth.getUser();
  document.getElementById("profile-email").value = user ? user.email : "";

  // Fetch straight from the database rather than trusting the in-memory
  // `myUsername` variable - it's only ever set after visiting the
  // Competition tab, so it could still be null here even for someone
  // who already has a saved username.
  const { data: profile } = await supabaseClient
    .from("profiles")
    .select("username, avatar_color")
    .eq("user_id", currentUserId)
    .maybeSingle();

  if (profile) {
    myUsername = profile.username;
    rememberAvatarColors([profile]);
  }
  document.getElementById("profile-username").value = myUsername || "";


  editProfilePanelEl.classList.toggle("hidden");
});

document.getElementById("save-profile-button").addEventListener("click", async () => {
  const errorEl = document.getElementById("edit-profile-error");
  const newUsername = document.getElementById("profile-username").value.trim();
  const newEmail = document.getElementById("profile-email").value.trim();


  errorEl.textContent = "";
  errorEl.classList.remove("success");

  if (!USERNAME_PATTERN.test(newUsername)) {
    errorEl.textContent = "Username must be 3-20 characters: letters, numbers, underscores only.";
    return;
  }

  // The username lives in our own `profiles` table - a plain
  // update, no special verification needed. (There used to be an optional
  if (newUsername !== myUsername) {
    // upsert (not update): someone who opened Edit Profile without ever
    // setting a username has no `profiles` row yet, so a plain update
    // would silently affect zero rows instead of actually saving anything.
    const { error } = await supabaseClient
      .from("profiles")
      .upsert({ user_id: currentUserId, username: newUsername });

    if (error) {
      errorEl.textContent = error.code === "23505" ? "That username is already taken." : "Couldn't save your profile. Try again.";
      return;
    }
    myUsername = newUsername;
    // Refresh the Me tab's profile header in case a username was just
    // set for the first time here rather than on the Competition tab.
    enterMeTab();
  }

  // Email is your actual login credential, so Supabase requires
  // confirming the change via a link sent to the NEW address before it
  // actually takes effect - it does NOT change instantly.
  const {
    data: { user },
  } = await supabaseClient.auth.getUser();

  if (user && newEmail !== user.email) {
    const { error } = await supabaseClient.auth.updateUser({ email: newEmail });
    if (error) {
      errorEl.textContent = error.message;
      return;
    }
    errorEl.textContent = "Profile saved. Check your new email to confirm the email change.";
    errorEl.classList.add("success");
    return;
  }

  errorEl.textContent = "Profile saved.";
  errorEl.classList.add("success");
});

document.getElementById("share-profile-button").addEventListener("click", async () => {
  const shareText = myUsername
    ? `Add me on Forja! My username is ${myUsername}`
    : "Check out Forja - a daily workout streak tracker!";

  // Web Share API opens the phone's native share sheet (Messages, etc.)
  // where supported; otherwise fall back to copying the text so it can
  // still be pasted anywhere.
  if (navigator.share) {
    try {
      await navigator.share({ text: shareText });
    } catch (error) {
      // The user simply canceling the share sheet also lands here -
      // nothing to show an error for in that case.
    }
  } else {
    await navigator.clipboard.writeText(shareText);
    alert("Copied to clipboard!");
  }
});

// Shows the current minimums next to each exercise (e.g. "min 15").
function renderMinTags() {
  pushupsMinTagEl.textContent = `min ${data.minimums.pushups}`;
  planksMinTagEl.textContent = `min ${data.minimums.planks}s`;
  squatsMinTagEl.textContent = `min ${data.minimums.squats}`;
  if (data.minimums.walkRun !== null) {
    walkrunMinTagEl.textContent = `min ${data.minimums.walkRun}`;
  }
  // Signed in, the targets come from My Plan - tapping one opens it.
  [pushupsMinTagEl, planksMinTagEl, squatsMinTagEl].forEach((tag) => {
    tag.classList.toggle("is-link", !!currentUserId);
    if (currentUserId) {
      tag.setAttribute("role", "button");
      tag.setAttribute("tabindex", "0");
    } else {
      tag.removeAttribute("role");
      tag.removeAttribute("tabindex");
    }
  });
}

// The Daily Minimums section now lives permanently in the "Me" tab, so
// the input boxes need to start out showing the saved values right away
// instead of only being filled in when a toggle was clicked.
function renderSettingsInputs() {
  minPushupsEl.value = data.minimums.pushups;
  minPlanksEl.value = data.minimums.planks;
  minSquatsEl.value = data.minimums.squats;

  const walkRunEnabled = data.minimums.walkRun !== null;
  enableWalkrunEl.checked = walkRunEnabled;
  minWalkrunEl.value = walkRunEnabled ? data.minimums.walkRun : 15;
  minWalkrunRowEl.classList.toggle("hidden", !walkRunEnabled);
  distanceUnitsEl.value = data.units;
  renderBodyWeightInput();
}

// ---- Body weight (optional, for walk/run calories) ----
//
// Kept only on this device - never sent to the server - because the only
// thing that uses it is the walk/run summary screen. Saved per account
// (or "guest") in case two people share a phone. Stored in kg; shown in
// lb when distances are in miles.
const BODY_WEIGHT_KEY = "forja-body-weight";
const KG_PER_LB = 0.45359237;
const bodyWeightEl = document.getElementById("body-weight");

function savedBodyWeights() {
  try {
    return JSON.parse(localStorage.getItem(BODY_WEIGHT_KEY)) || {};
  } catch {
    return {};
  }
}

// This account's weight in kg, or null if it was never entered.
function bodyWeightKg() {
  const kg = savedBodyWeights()[currentUserId || "guest"];
  return Number.isFinite(kg) ? kg : null;
}

function renderBodyWeightInput() {
  const inPounds = data.units !== "km";
  document.getElementById("body-weight-label").textContent = inPounds ? "Weight (lb)" : "Weight (kg)";
  const kg = bodyWeightKg();
  bodyWeightEl.value = kg === null ? "" : String(Math.round(inPounds ? kg / KG_PER_LB : kg));
}

bodyWeightEl.addEventListener("change", () => {
  const weights = savedBodyWeights();
  const who = currentUserId || "guest";
  const typed = bodyWeightEl.value.trim();
  const statusEl = document.getElementById("settings-status");
  if (typed === "") {
    delete weights[who];
  } else {
    const kg = Number(typed) * (data.units === "km" ? 1 : KG_PER_LB);
    const [lightest, heaviest] = ForjaRules.ESTIMATES.WEIGHT_KG;
    if (!(kg >= lightest && kg <= heaviest)) {
      statusEl.textContent = `Enter your weight as a number, like ${data.units === "km" ? 70 : 160}.`;
      statusEl.classList.remove("success");
      renderBodyWeightInput();
      return;
    }
    weights[who] = Math.round(kg * 10) / 10;
  }
  try {
    localStorage.setItem(BODY_WEIGHT_KEY, JSON.stringify(weights));
  } catch {
    // Storage blocked: calories keep using the average weight.
  }
  renderBodyWeightInput();
  showSettingSaved();
});

const minimumsStatusEl = document.getElementById("minimums-status");

saveMinimumsEl.addEventListener("click", () => {
  // Minimums can be raised, never lowered below the game's floors -
  // otherwise someone could rank on a day that asks for 1 push-up.
  const floors = ForjaRules.FLOORS;
  const typed = [Number(minPushupsEl.value) || 0, Number(minPlanksEl.value) || 0, Number(minSquatsEl.value) || 0];
  data.minimums.pushups = Math.max(typed[0], floors.pushups);
  data.minimums.planks = Math.max(typed[1], floors.planks);
  data.minimums.squats = Math.max(typed[2], floors.squats);
  const raised = typed[0] < floors.pushups || typed[1] < floors.planks || typed[2] < floors.squats;
  data.minimums.walkRun = enableWalkrunEl.checked ? (Number(minWalkrunEl.value) || 1) : null;

  saveData(data);
  // Show what was actually saved - a minimum raised to its floor must not
  // keep displaying the lower number that was typed.
  renderSettingsInputs();
  renderMinTags();
  render();

  minimumsStatusEl.textContent = raised
    ? `Minimums saved. They can't go below ${floors.pushups} push-ups, a ${floors.planks}s plank and ${floors.squats} squats, so yours were raised to fit.`
    : "Minimums saved.";
  minimumsStatusEl.classList.add("success");

  // Lowering a minimum (or turning walk/run off) can complete today.
  maybeCompleteDay();
});

// The "saved" note goes away as soon as anything is changed again, so it
// never claims unsaved edits are saved.
minimumsPanelEl.addEventListener("input", () => {
  minimumsStatusEl.textContent = "";
});

// ---------- My Plan ----------
// A signed-in player's plan, kept minimal: today's targets, the next
// level-up, pace and walk/run. Every number comes from the same rules the
// server uses (ForjaRules), so what's shown is exactly what will be checked.
// Each ⓘ opens one short tip; any tap closes it.

const PACE_LINES = {
  easy: "Levels up every 4th day",
  regular: "Levels up every 3rd day",
  serious: "Levels up every 2nd day",
  intense: "Levels up 2 of every 3 days",
};
// What the level-up tip says depends on the player's own pace - and only
// mentions a held exercise when one is actually showing in amber.
const LEVEL_UP_TIP = {
  easy: "On Easy, your targets go up every 4th day you complete.",
  regular: "On Regular, your targets go up every 3rd day you complete.",
  serious: "On Serious, your targets go up every 2nd day you complete.",
  intense: "On Intense, your targets go up on 2 of every 3 days you complete.",
};
function levelUpTip() {
  let text = (LEVEL_UP_TIP[serverPlan && serverPlan.pace] || LEVEL_UP_TIP.regular) + " This comes from the pace you picked below.";
  const next = serverPlan && ForjaRules.nextLevelUp(serverPlan, myPlanDay());
  if (next && next.held.length) {
    const names = PLAN_EXERCISES.filter((ex) => next.held.includes(ex.key)).map((ex) => ex.name);
    const list = names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    text += ` <span class="amber">${list}</span> ${names.length === 1 ? "stays" : "stay"} the same this time because ${names.length === 1 ? "it" : "they"} took 3+ sets.`;
  }
  return text;
}
// The paces as a short list, with the player's own in bold.
const PACE_TIP_LINES = [
  ["easy", "Easy: every 4th day"],
  ["regular", "Regular: every 3rd day"],
  ["serious", "Serious: every 2nd day"],
  ["intense", "Intense: 2 of every 3 days"],
];
function paceTip() {
  const mine = serverPlan && serverPlan.pace;
  const items = PACE_TIP_LINES.map(([pace, line]) => `<li${pace === mine ? ' class="mine"' : ""}>${line}</li>`).join("");
  return `How often you level up:<ul>${items}</ul><span class="tip-note">Today's targets don't change.</span>`;
}

// The day My Plan shows: today, or tomorrow once today is logged.
function myPlanDay() {
  const today = todayString();
  return data && data.lastLoggedDate === today ? ForjaRules.addDays(today, 1) : today;
}

const PLAN_TIPS = {
  today: "Set by your plan. Reps add up across all your sets; the plank is your best single hold.",
  levelup: levelUpTip,
  pace: paceTip,
  walk: "Track it on the Record tab. Minutes stay the same; they don't level up.",
};
const PLAN_EXERCISES = [
  { key: "pushups", name: "Push-ups", color: "var(--ring-pushups)" },
  { key: "squats", name: "Squats", color: "var(--ring-squats)" },
  { key: "planks", name: "Plank", color: "var(--ring-planks)" },
];
const planValue = (key, value) => (key === "planks" ? formatDuration(value * 1000) : String(value));
let paceMessageTimer = null;

async function openMyPlan() {
  if (!serverPlan) await loadServerPlan();
  if (!serverPlan) {
    // No signal and no plan yet: the plain minimums are better than nothing.
    showScreen("account-screen");
    showOnlyPanel(minimumsPanelEl);
    minimumsPanelEl.classList.remove("hidden");
    renderSettingsInputs();
    return;
  }
  closePlanTip();
  renderMyPlan();
  showScreen("my-plan-screen");
}

function renderMyPlan() {
  if (!serverPlan || !data) return;
  // Once today is logged the plan already looks ahead, so show tomorrow.
  const doneToday = data.lastLoggedDate === todayString();
  const day = myPlanDay();
  const on = ForjaRules.planOn(serverPlan, day);

  document.getElementById("plan-today-label").classList.toggle("hidden", !doneToday);
  const targetsEl = document.getElementById("plan-targets");
  targetsEl.innerHTML = "";
  PLAN_EXERCISES.forEach((ex) => {
    const cell = document.createElement("div");
    const value = document.createElement("div");
    value.className = "plan-target-value";
    value.textContent = planValue(ex.key, on.plan.targets[ex.key]);
    const name = document.createElement("div");
    name.className = "plan-target-name";
    name.innerHTML = `<i style="background:${ex.color}"></i>`;
    name.append(ex.name);
    cell.append(value, name);
    targetsEl.appendChild(cell);
  });
  document.getElementById("plan-eased").classList.toggle("hidden", !(on.easedSteps && on.missed >= 2));

  const next = ForjaRules.nextLevelUp(serverPlan, day);
  const titleEl = document.getElementById("plan-levelup-title");
  const barEl = document.getElementById("plan-bar");
  const nextEl = document.getElementById("plan-next");
  barEl.classList.toggle("hidden", !next);
  nextEl.classList.toggle("hidden", !next);
  if (!next) {
    titleEl.textContent = "Maintaining your level";
  } else {
    titleEl.textContent = next.inDays > 1 ? `Level up in ${next.inDays} days` : doneToday ? "Level up after tomorrow" : "Level up after today";
    const percent = Math.round(Math.min(1, on.plan.credit) * 100);
    barEl.setAttribute("aria-valuenow", String(percent));
    barEl.querySelector("i").style.width = `${percent}%`;
    nextEl.innerHTML = "";
    PLAN_EXERCISES.forEach((ex, i) => {
      if (i) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "·";
        nextEl.appendChild(sep);
      }
      const span = document.createElement("span");
      span.textContent = planValue(ex.key, next.targets[ex.key]);
      span.classList.toggle("held", next.held.includes(ex.key));
      nextEl.appendChild(span);
    });
  }

  document.querySelectorAll("#plan-pace [data-pace]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.pace === serverPlan.pace));
  });
  if (!paceMessageTimer) document.getElementById("plan-pace-line").textContent = PACE_LINES[serverPlan.pace] || "";

  const walkOn = data.minimums.walkRun !== null;
  document.getElementById("plan-walk-switch").setAttribute("aria-checked", String(walkOn));
  document.getElementById("plan-walk-minutes").classList.toggle("hidden", !walkOn);
  document.querySelectorAll("#plan-walk-minutes [data-minutes]").forEach((button) => {
    button.setAttribute("aria-checked", String(walkOn && Number(button.dataset.minutes) === data.minimums.walkRun));
  });
}

function showPaceMessage(text) {
  clearTimeout(paceMessageTimer);
  document.getElementById("plan-pace-line").textContent = text;
  paceMessageTimer = setTimeout(() => {
    paceMessageTimer = null;
    renderMyPlan();
  }, 1600);
}

// Pace is the one part of the plan a player chooses; the server saves it.
// Today's targets don't jump - a faster pace just levels up more often.
document.getElementById("plan-pace").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-pace]");
  if (!button || !serverPlan || button.dataset.pace === serverPlan.pace) return;
  const previous = serverPlan;
  serverPlan = { ...serverPlan, pace: button.dataset.pace };
  renderMyPlan();
  const reply = await callServerFunction("plan", { pace: button.dataset.pace });
  if (reply.ok && reply.plan) {
    serverPlan = reply.plan;
    showPaceMessage("Pace saved.");
  } else {
    serverPlan = previous;
    showPaceMessage("Couldn't change your pace. Try again.");
  }
  renderMyPlan();
});

// Walk/run minutes are the player's own (they don't level up), saved on tap.
function setWalkRun(minutes) {
  data.minimums.walkRun = minutes;
  saveData(data);
  renderMinTags();
  render();
  renderMyPlan();
  // Turning walk/run off (or lowering it) can complete today.
  maybeCompleteDay();
}
document.getElementById("plan-walk-switch").addEventListener("click", () => {
  setWalkRun(data.minimums.walkRun === null ? 15 : null);
});
document.getElementById("plan-walk-minutes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-minutes]");
  if (button) setWalkRun(Number(button.dataset.minutes));
});

document.getElementById("my-plan-back").addEventListener("click", () => {
  closePlanTip();
  showScreen("account-screen");
});

// Tapping a "min" tag on Today opens My Plan (signed in).
[pushupsMinTagEl, planksMinTagEl, squatsMinTagEl].forEach((tag) => {
  const open = () => currentUserId && openMyPlan();
  tag.addEventListener("click", open);
  tag.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
});

// ⓘ tips: one open at a time, inside the card it explains.
let openTipId = null;
function closePlanTip() {
  document.querySelectorAll(".plan-tip").forEach((tip) => tip.remove());
  document.querySelectorAll("#my-plan-screen .tip-btn").forEach((button) => button.setAttribute("aria-expanded", "false"));
  openTipId = null;
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("#my-plan-screen .tip-btn");
  const wasOpen = openTipId;
  if (openTipId) closePlanTip();
  if (!button || wasOpen === button.dataset.tip) return;
  const tip = document.createElement("div");
  tip.className = "plan-tip";
  tip.setAttribute("role", "note");
  const content = PLAN_TIPS[button.dataset.tip];
  tip.innerHTML = typeof content === "function" ? content() : content;
  const holder = button.closest(".plan-card, .plan-pace-wrap");
  holder.appendChild(tip);
  // Open right under the ⓘ, with the arrow pointing at it - or, if there
  // isn't room below on the screen, right above it (arrow pointing down).
  const holderBox = holder.getBoundingClientRect();
  const buttonBox = button.getBoundingClientRect();
  const tipBox = tip.getBoundingClientRect();
  const roomBelow = window.innerHeight - buttonBox.bottom;
  const above = roomBelow < tipBox.height + 24 && buttonBox.top > tipBox.height + 24;
  tip.classList.toggle("above", above);
  tip.style.top = above ? `${buttonBox.top - holderBox.top - tipBox.height - 10}px` : `${buttonBox.bottom - holderBox.top + 10}px`;
  const arrowX = buttonBox.left + buttonBox.width / 2 - tipBox.left;
  tip.style.setProperty("--arrow-x", `${Math.max(18, Math.min(tipBox.width - 18, arrowX))}px`);
  button.setAttribute("aria-expanded", "true");
  openTipId = button.dataset.tip;
});

// STEP 2c: Push notification reminders. Requires an account (subscriptions
// are tied to a user_id in the database) and, on iOS specifically, requires
// the app to have been added to the Home Screen - regular Safari tabs never
// receive Web Push on iOS regardless of permission.

const enableRemindersEl = document.getElementById("enable-reminders");
const remindersStatusEl = document.getElementById("reminders-status");
const reminderHourRowEl = document.getElementById("reminder-hour-row");
const reminderHourEl = document.getElementById("reminder-hour");

// Populate the hour dropdown once, in 12-hour display form but storing
// the 24-hour value the server actually compares against.
for (let hour = 0; hour < 24; hour++) {
  const option = document.createElement("option");
  option.value = hour;
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  option.textContent = `${displayHour}:00 ${hour < 12 ? "AM" : "PM"}`;
  reminderHourEl.appendChild(option);
}

// atob() gives raw bytes for a base64 string, but the push API wants a
// Uint8Array in its own url-safe base64 variant - this converts between
// the two. Boilerplate every Web Push implementation needs.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// Shared by the Settings toggle and the one-time onboarding prompt, so
// there's exactly one place that knows how to turn reminders on. Returns
// true/false so each caller can update its own surrounding UI.
async function enableReminderNotifications() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const subscriptionJson = subscription.toJSON();
  const { error } = await supabaseClient.from("push_subscriptions").upsert({
    endpoint: subscriptionJson.endpoint,
    user_id: currentUserId,
    p256dh: subscriptionJson.keys.p256dh,
    auth_key: subscriptionJson.keys.auth,
  });
  if (error) return false;

  // Captured automatically rather than asked for - this is what lets the
  // server-side function compare against each person's own local time
  // instead of one fixed hour for everyone.
  data.reminderTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  saveData(data);

  return true;
}

async function disableReminderNotifications() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await supabaseClient.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
    await subscription.unsubscribe();
  }
}

// Reflects whatever this browser's actual subscription state is (not just
// a saved preference) into the checkbox, every time Settings is opened.
async function refreshRemindersToggle() {
  remindersStatusEl.textContent = "";

  if (!currentUserId) {
    enableRemindersEl.checked = false;
    enableRemindersEl.disabled = true;
    reminderHourRowEl.classList.add("hidden");
    remindersStatusEl.textContent = "Sign in to enable reminders.";
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    enableRemindersEl.checked = false;
    enableRemindersEl.disabled = true;
    reminderHourRowEl.classList.add("hidden");
    remindersStatusEl.textContent = "Reminders aren't supported in this browser. On iPhone, add Forja to your Home Screen first.";
    return;
  }

  enableRemindersEl.disabled = false;
  const registration = await navigator.serviceWorker.ready;
  const existingSubscription = await registration.pushManager.getSubscription();
  enableRemindersEl.checked = !!existingSubscription;
  reminderHourEl.value = data.reminderHour;
  reminderHourRowEl.classList.toggle("hidden", !existingSubscription);
}

enableRemindersEl.addEventListener("change", async () => {
  // This toggle reports its own result just below it.
  document.getElementById("settings-status").textContent = "";
  remindersStatusEl.textContent = "";
  remindersStatusEl.classList.remove("success");

  if (enableRemindersEl.checked) {
    const success = await enableReminderNotifications();
    if (!success) {
      enableRemindersEl.checked = false;
      remindersStatusEl.textContent = "Couldn't enable reminders. Try again.";
      return;
    }
    reminderHourEl.value = data.reminderHour;
    reminderHourRowEl.classList.remove("hidden");
    remindersStatusEl.textContent = "Reminders enabled.";
    remindersStatusEl.classList.add("success");
  } else {
    await disableReminderNotifications();
    reminderHourRowEl.classList.add("hidden");
    remindersStatusEl.textContent = "Reminders turned off.";
  }
  refreshNotifAskMode();
});

// ---------- asking for notifications again ----------
// Most people never got asked: sign-up skips the question when the phone
// can't do notifications yet (on iPhone a Safari tab never can, only the
// Home Screen app). So Forja asks again at good moments - the ring just
// closed, or a friend nudged you. Where one tap is enough the pet asks in
// its bubble (celebrations.js); in iPhone Safari a sheet shows how to add
// Forja to the Home Screen. At most every 3 days, and never again after 3
// "no"s or once reminders are on. Kept per account on this phone.
const NOTIF_ASK_KEY = "forja-notif-ask";
const NOTIF_ASK_EVERY_DAYS = 3;
const NOTIF_ASK_MAX_NO = 3;
let notifAskMode = null; // "app" (one tap), "safari" (Home Screen steps) or null (don't ask)

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isHomeScreenApp = () => navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;

function readNotifAsk() {
  try {
    return JSON.parse(localStorage.getItem(NOTIF_ASK_KEY) || "{}")[currentUserId] || {};
  } catch (e) {
    return {};
  }
}

function writeNotifAsk(changes) {
  try {
    const all = JSON.parse(localStorage.getItem(NOTIF_ASK_KEY) || "{}");
    all[currentUserId] = { ...(all[currentUserId] || {}), ...changes };
    localStorage.setItem(NOTIF_ASK_KEY, JSON.stringify(all));
  } catch (e) {
    // storage blocked - it may just ask again
  }
}

// What this phone can do right now; checked when the app opens, comes back
// on screen, or the Settings switch changes.
async function refreshNotifAskMode() {
  const viewerId = currentUserId;
  notifAskMode = null;
  if (!viewerId) return;
  const pushReady = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIOS() && !isHomeScreenApp()) {
    notifAskMode = "safari";
    return;
  }
  // No notifications in this browser at all, or turned down for good
  // (only the phone's Settings can undo that).
  if (!pushReady || Notification.permission === "denied") return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (viewerId === currentUserId) notifAskMode = subscription ? null : "app";
  } catch (e) {
    // can't tell - don't ask
  }
}

// "app" or "safari" when it's a good time to ask, otherwise null.
function notifAskNow() {
  if (!notifAskMode || !currentUserId || Onboarding.isActive()) return null;
  const asked = readNotifAsk();
  if (asked.done || (asked.no || 0) >= NOTIF_ASK_MAX_NO) return null;
  if (asked.last && ForjaRules.addDays(asked.last, NOTIF_ASK_EVERY_DAYS) > todayString()) return null;
  return notifAskMode;
}

const notifAskShown = () => writeNotifAsk({ last: todayString() });
const notifAskDeclined = () => writeNotifAsk({ last: todayString(), no: (readNotifAsk().no || 0) + 1 });

// The pet's "Yes" button. Starts inside the tap, which iPhone needs to show
// its own prompt. True once reminders are on.
async function turnOnRemindersFromAsk() {
  let on = false;
  try {
    on = await enableReminderNotifications();
  } catch (e) {
    on = false;
  }
  const refused = "Notification" in window && Notification.permission === "denied";
  if (on || refused) {
    notifAskMode = null;
    writeNotifAsk({ done: true });
  }
  if (!on) showToast(refused ? "No problem. You can turn them on later in Settings." : "Couldn't turn on reminders. Try again in Settings.");
  return on;
}

const SHARE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
const ADD_SQUARE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

// iPhone Safari: how to get Forja onto the Home Screen. Only over Today.
// "Got It" isn't a no (they may be about to do it); Not Now or a tap
// outside is.
function openHomeScreenSheet(moment) {
  const todayShown = !document.getElementById("app-screen").classList.contains("hidden") && !TABS.today.panel.classList.contains("hidden");
  if (!todayShown || document.getElementById("notif-sheet") || !notifAskNow()) return;
  notifAskShown();
  const scrim = document.createElement("div");
  scrim.id = "notif-sheet";
  scrim.className = "challenge-scrim";
  scrim.innerHTML = `
    <div class="challenge-sheet notif-sheet" role="dialog" aria-modal="true" aria-labelledby="notif-sheet-title">
      <span class="challenge-grabber"></span>
      <span class="notif-sheet-pet">${Onboarding.mascot("happy")}</span>
      <h2 id="notif-sheet-title">${moment === "done" ? "Keep your streak going tomorrow" : "Never miss a nudge"}</h2>
      <p class="notif-sheet-sub">iPhone only sends reminders to apps on your Home Screen. Takes 20 seconds:</p>
      <ol class="notif-steps">
        <li><span class="notif-step-n">1</span><span>Tap <span class="notif-step-icon">${SHARE_ICON_SVG}</span> Share in Safari<small>Don't see it? Tap ••• first.</small></span></li>
        <li><span class="notif-step-n">2</span><span>Tap <span class="notif-step-icon">${ADD_SQUARE_ICON_SVG}</span> Add to Home Screen</span></li>
        <li><span class="notif-step-n">3</span><span>Open Forja from your Home Screen<small>Log in once more, then turn on reminders.</small></span></li>
      </ol>
      <button class="auth-submit-button" data-notif-sheet="ok">Got It</button>
      <button class="challenge-text-button is-muted" data-notif-sheet="later">Not Now</button>
    </div>`;
  scrim.addEventListener("click", (event) => {
    const button = event.target.closest("[data-notif-sheet]");
    if (event.target !== scrim && !button) return;
    if (!button || button.dataset.notifSheet === "later") notifAskDeclined();
    scrim.remove();
  });
  document.body.appendChild(scrim);
  scrim.querySelector("[data-notif-sheet=ok]").focus();
}

reminderHourEl.addEventListener("change", () => {
  data.reminderHour = Number(reminderHourEl.value);
  // Timezones aren't permanent - re-capturing it here as well means
  // someone who's since traveled gets corrected the next time they touch
  // this setting, not just the first time they ever enabled it.
  data.reminderTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  saveData(data);
  showSettingSaved();
});

document.getElementById("reminder-setup-enable-button").addEventListener("click", async () => {
  const statusEl = document.getElementById("reminder-setup-status");
  const success = await enableReminderNotifications();
  if (!success) {
    statusEl.textContent = "Couldn't enable reminders. You can try again anytime in Settings.";
    return;
  }
  showScreen("app-screen");
});

document.getElementById("reminder-setup-skip-button").addEventListener("click", () => {
  showScreen("app-screen");
});

// Turns a Date object into a "YYYY-MM-DD" string using LOCAL time.
// (We build it manually instead of using toISOString(), which converts
// to UTC and can silently land on the wrong calendar day depending on
// your time zone and the time of day.)
function dateToString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Returns today's date as a "YYYY-MM-DD" string, so we can easily
// compare "did I already log today?" without worrying about the time.
function todayString() {
  return dateToString(new Date());
}

// Today's camera-verified totals. Lives in `data` so it survives a reload;
// a new day starts a fresh set of zeros the first time it's read.
function todayProgress() {
  const today = todayString();
  if (!data.today || data.today.date !== today) {
    data.today = { date: today, pushups: 0, planks: 0, squats: 0, walkRun: 0, sets: [] };
  }
  return data.today;
}

// The only way an exercise count gets into the app: called with the
// result of a set the camera verified. Reps add up across sets (two sets
// of 5 is 10); a plank keeps the best single hold, since the minimum is
// one unbroken hold, not a total.
function recordVerifiedSet(exerciseKey, value) {
  if (data.lastLoggedDate === todayString() || !(value > 0)) return;

  // A guest's best single set, for "New best set" (signed in, the server's
  // verified sets say it - see loadBestSet).
  data.bestSets = data.bestSets || {};
  data.bestSets[exerciseKey] = Math.max(data.bestSets[exerciseKey] || 0, value);

  const progress = todayProgress();
  if (exerciseKey === "pushup") progress.pushups += value;
  else if (exerciseKey === "squat") progress.squats += value;
  else if (exerciseKey === "plank") progress.planks = Math.max(progress.planks, value);
  else return;

  progress.sets.push({ exercise: exerciseKey, value, at: new Date().toISOString() });
  saveData(data);
  render();
  maybeCompleteDay();
}

// For a signed-in player the server is the source of truth for the streak:
// replace the local copy with what it has. If the request fails (offline,
// or the table doesn't exist yet) leave the local numbers alone rather
// than overwriting a real streak with zeros.
async function loadServerStats() {
  if (!currentUserId) return;
  const { data: row, error } = await supabaseClient.from("player_stats").select("*").eq("user_id", currentUserId).maybeSingle();
  if (error) return;
  applyStats({
    streak: row ? row.streak : 0,
    bestStreak: row ? row.best_streak : 0,
    lastLoggedDate: row ? row.last_logged_date : null,
    restDaysUsed: row ? row.rest_days_used : 0,
    weekStartDate: row ? row.week_start_date : null,
  });
}

// A signed-in player's targets come from their plan on the server, which
// raises them as days are completed. (The server starts a plan from the
// minimums they already had the first time it's asked.)
async function loadServerPlan(pace) {
  if (!currentUserId) return;
  const reply = await callServerFunction("plan", pace ? { pace } : {});
  if (reply.ok && reply.plan) {
    serverPlan = reply.plan;
    applyPlanTargets();
  }
}

// Today's minimums = the plan's targets for today, including any ease-back
// for missed days (the same rules the server checks against). Once today
// is logged they stay put, so the screen keeps showing what today asked
// for rather than tomorrow's new numbers.
function applyPlanTargets() {
  if (!currentUserId || !serverPlan || !data) return;
  if (data.lastLoggedDate === todayString()) return;
  const targets = ForjaRules.planOn(serverPlan, todayString()).plan.targets;
  data.minimums.pushups = targets.pushups;
  data.minimums.planks = targets.planks;
  data.minimums.squats = targets.squats;
  renderMinTags();
}

// Today's totals for a signed-in player come from the sets the server
// verified, not from anything stored on this device.
async function refreshVerifiedProgress() {
  if (!currentUserId) return;
  const { data: sets, error } = await supabaseClient
    .from("verified_sets")
    .select("exercise, value")
    .eq("user_id", currentUserId)
    .eq("day", todayString());
  if (error) return;
  const totals = ForjaRules.totalsFromSets(sets);
  const progress = todayProgress();
  progress.pushups = totals.pushups;
  progress.planks = totals.planks;
  progress.squats = totals.squats;
  render();
}

// What the camera screen calls when a set is saved. Signed in: send the
// recorded movement to the server, which recounts it and replies with the
// number it actually verified. Guest: nothing to verify against, so it's
// kept locally - along with the recording, so an account made later today
// can still have the server verify it (see claimGuestSets).
async function saveCameraSet({ exercise, value, trace }) {
  // The "+25" on Today is queued before anything redraws, so it plays
  // before the green check and the day-complete moment it can lead to.
  const key = { pushup: "pushups", plank: "planks", squat: "squats" }[exercise];
  const before = todayProgress()[key];
  const celebrate = (counted) => {
    if (typeof Celebrations === "undefined" || data.lastLoggedDate === todayString()) return;
    Celebrations.setSaved(exercise, before, key === "planks" ? Math.max(before, counted) : before + counted);
  };
  if (!currentUserId) {
    keepGuestTrace(trace);
    celebrate(value);
    recordVerifiedSet(exercise, value);
    return { ok: true, value };
  }
  const reply = await callServerFunction("submit-set", { trace, day: todayString() });
  if (!reply.ok) return { ok: false, error: serverErrorMessage(reply), code: reply.error };
  celebrate(reply.value);
  await refreshVerifiedProgress();
  // Not awaited: the camera screen can close while the day is being saved.
  maybeCompleteDay();
  return { ok: true, value: reply.value };
}

// A guest's camera recordings from today, kept on this phone. Signing up
// the same day sends them to the server to recount like any other set, so
// a Day 1 done before having an account still counts on the leaderboard.
const GUEST_SETS_KEY = "forja-guest-sets";

function keepGuestTrace(trace) {
  if (!trace) return;
  const today = todayString();
  try {
    let kept = JSON.parse(localStorage.getItem(GUEST_SETS_KEY) || "null");
    if (!kept || kept.day !== today) kept = { day: today, traces: [] };
    if (kept.traces.length >= ForjaRules.MAX_SETS_PER_DAY) return;
    kept.traces.push(trace);
    localStorage.setItem(GUEST_SETS_KEY, JSON.stringify(kept));
  } catch (e) {
    // storage full or blocked - the set still counts on this phone
  }
}

// Recordings from an earlier day can never be claimed - don't keep them.
function dropOldGuestSets() {
  try {
    const kept = JSON.parse(localStorage.getItem(GUEST_SETS_KEY) || "null");
    if (kept && kept.day !== todayString()) localStorage.removeItem(GUEST_SETS_KEY);
  } catch (e) {
    // storage blocked - nothing kept anyway
  }
}

// Run once for a brand new account. Today's sets only: the server accepts
// sets for the current day, and earlier guest days were never verified.
async function claimGuestSets() {
  let kept = null;
  try {
    kept = JSON.parse(localStorage.getItem(GUEST_SETS_KEY) || "null");
    // Removed first, so a second sign-in event can't send them twice.
    localStorage.removeItem(GUEST_SETS_KEY);
  } catch (e) {
    return;
  }
  if (!kept || kept.day !== todayString()) return;
  for (const trace of kept.traces) {
    await callServerFunction("submit-set", { trace, day: kept.day });
  }
}

// The username typed on the sign-up screen, saved once the account exists.
// Returns whether someone else already has it.
async function claimPendingUsername() {
  const username = localStorage.getItem("forja-pending-username");
  localStorage.removeItem("forja-pending-username");
  if (!username || !USERNAME_PATTERN.test(username)) return { taken: false };
  const { error } = await supabaseClient.from("profiles").insert({ user_id: currentUserId, username });
  if (error) return { taken: error.code === "23505" };
  myUsername = username;
  return { taken: false };
}

// Updates everything visible on the page to match the current `data`.
function render() {
  // Keeps the targets right if the app stays open past midnight.
  applyPlanTargets();
  streakCountEl.textContent = currentStreak();
  bestStreakCountEl.textContent = data.bestStreak;

  const progress = todayProgress();
  // A set saved behind the camera screen counts up once Today is seen.
  const shown = (key) => (typeof Celebrations !== "undefined" ? Celebrations.heldValue(key, progress[key]) : progress[key]);
  pushupsEl.value = shown("pushups");
  planksEl.value = shown("planks");
  squatsEl.value = shown("squats");
  walkrunEl.value = progress.walkRun;

  const loggedToday = data.lastLoggedDate === todayString();

  // The line under the ring only shows while the day saves (and "Day
  // complete!" when the pet coach isn't there to say it).
  if (loggedToday) {
    statusMessageEl.textContent = "Day complete! See you tomorrow.";
  } else if (savingDay) {
    statusMessageEl.textContent = "Minimums hit! Saving your day...";
  } else {
    statusMessageEl.textContent = "";
  }
  statusMessageEl.classList.toggle("is-done", loggedToday);
  statusMessageEl.classList.toggle("hidden", !loggedToday && !savingDay);
  retryLogButtonEl.classList.toggle("hidden", loggedToday || savingDay || !saveDayFailed);

  updateRings(loggedToday);
  if (typeof Celebrations !== "undefined") Celebrations.renderToday(loggedToday, progress);

  document.querySelectorAll(".verify-button").forEach((button) => {
    button.disabled = loggedToday;
  });

  const walkRunEnabled = data.minimums.walkRun !== null;
  walkrunRowEl.classList.toggle("hidden", !walkRunEnabled);
  startTrackingButtonEl.disabled = loggedToday;

  renderGraceStatus();
}

// Number of days between two "YYYY-MM-DD" strings (dateStr2 - dateStr1).
function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

// Rest days left this week (Monday to Sunday), counting days already
// missed since the last workout - what logging today would leave. (The
// saved numbers are left alone: a missed Sunday still uses last week's.)
function renderGraceStatus() {
  const restDaysCountEl = document.getElementById("rest-days-count");
  const used = ForjaRules.nextStats(streakStats(), todayString()).restDaysUsed;
  restDaysCountEl.textContent = ForjaRules.REST_DAYS_PER_WEEK - used;
}

document.querySelectorAll(".verify-button").forEach((button) => {
  button.addEventListener("click", () => openSetCamera(button.dataset.exercise));
});

// ---------- what a finished set earned (the camera's review screen) ----------
// Opens the camera for a set that counts toward today. Its best single set
// so far is looked up on the way in, so the finished set can be compared.
function openSetCamera(exercise, options = {}) {
  loadBestSet(exercise);
  ForjaCamera.open(exercise, saveCameraSet, { ...options, reward: setReward, backup: { user: currentUserId || "guest", day: todayString() } });
}

// A set the app closed on before it was saved (crash, iOS reclaiming
// memory, a reload) comes back on the review screen the next time the app
// opens, for the same account on the same day. If it was already on its
// way to the server when the app closed, the server may have it: a set of
// that exercise and number saved since then means it did.
let recoveringSet = false;

async function recoverUnsavedSet() {
  if (recoveringSet || cameraIsOpen() || Onboarding.isActive() || !data) return;
  const kept = ForjaCamera.unsavedSet();
  if (!kept) {
    ForjaCamera.dropUnsavedSet(); // nothing in it would count
    return;
  }
  if (kept.tag.day !== todayString()) {
    ForjaCamera.dropUnsavedSet(); // sets only count on their own day
    return;
  }
  const who = currentUserId || "guest";
  if (kept.tag.user !== who) return; // someone else's - kept for when they're back
  recoveringSet = true;
  try {
    if (kept.sentAt && currentUserId) {
      const { data: rows, error } = await supabaseClient
        .from("verified_sets")
        .select("value")
        .eq("user_id", currentUserId)
        .eq("day", kept.tag.day)
        .eq("exercise", kept.exercise)
        .gte("created_at", new Date(kept.sentAt - 60000).toISOString());
      if (error || who !== (currentUserId || "guest")) return; // try again next time
      if (rows.some((row) => row.value === kept.value)) {
        ForjaCamera.dropUnsavedSet();
        return;
      }
    }
    if (cameraIsOpen() || Onboarding.isActive()) return;
    loadBestSet(kept.exercise);
    ForjaCamera.recover(saveCameraSet, {
      reward: (exercise, value) => {
        const reward = setReward(exercise, value);
        if (reward) {
          reward.line = `The app closed mid-set, but <b>I kept your ${value}${exercise === "plank" ? "s" : ""}</b>. Save it?`;
          reward.face = "happy";
        }
        return reward;
      },
    });
  } finally {
    recoveringSet = false;
  }
}

const SET_KEY = { pushup: "pushups", plank: "planks", squat: "squats" };
const SET_NAMES = { pushups: "Push-ups", planks: "Plank", squats: "Squats" };
const DAY_KEYS = ["pushups", "planks", "squats"];
const bestSetBefore = {}; // exercise -> best single set before this one (0 = none yet)

// Signed in: the best set the server ever verified. A guest: the best this
// phone has seen (data.bestSets, kept by recordVerifiedSet).
async function loadBestSet(exercise) {
  bestSetBefore[exercise] = 0;
  if (!currentUserId) {
    bestSetBefore[exercise] = (data && data.bestSets && data.bestSets[exercise]) || 0;
    return;
  }
  const viewerId = currentUserId;
  const { data: rows, error } = await supabaseClient
    .from("verified_sets")
    .select("value")
    .eq("user_id", viewerId)
    .eq("exercise", exercise)
    .order("value", { ascending: false })
    .limit(1);
  if (error || viewerId !== currentUserId) return;
  bestSetBefore[exercise] = rows && rows[0] ? rows[0].value : 0;
}

// What a set of `value` would mean for today, for camera-verify.js's
// review screen. Lines are in the pet's voice and contain only numbers and
// fixed words (they're drawn as HTML).
function setReward(exercise, value) {
  if (!data) return null;
  const key = SET_KEY[exercise];
  const m = data.minimums;
  const progress = todayProgress();
  const before = progress[key];
  // Reps add up across sets; a plank is the best single hold.
  const total = key === "planks" ? Math.max(before, value) : before + value;
  const target = Math.max(m[key], 1);
  const totalOf = (k) => (k === key ? total : progress[k]);
  const walkLeft = m.walkRun !== null && progress.walkRun < m.walkRun;
  const unit = key === "planks" ? "s" : "";
  const lower = key === "planks" ? "plank" : SET_NAMES[key].toLowerCase();
  const was = key === "planks" ? "was" : "were";
  const best = bestSetBefore[exercise] || 0;

  const finishesIt = value > 0 && before < m[key] && total >= m[key];
  const newBest = value > 0 && best > 0 && value > best;
  const dayDone = finishesIt && data.lastLoggedDate !== todayString() && DAY_KEYS.every((k) => totalOf(k) >= m[k]) && !walkLeft;
  const dayNumber = dayDone ? ForjaRules.nextStats({ streak: data.streak, bestStreak: data.bestStreak, lastLoggedDate: data.lastLoggedDate, restDaysUsed: data.restDaysUsed, weekStartDate: data.weekStartDate }, todayString()).streak : 0;

  const badges = [];
  if (newBest) badges.push({ kind: "best", text: `New best set · ${value}${unit}` });
  if (dayDone) badges.push({ kind: "day", text: `Day ${dayNumber} done!` });
  else if (finishesIt) badges.push({ kind: "done", text: `${SET_NAMES[key]} done` });

  // What's still left today after this set, for "Next: ...".
  const left = DAY_KEYS.filter((k) => totalOf(k) < m[k]).map((k) => (k === "planks" ? "plank" : SET_NAMES[k].toLowerCase()));
  if (walkLeft) left.push("the walk");

  let line;
  let face = "happy";
  if (value <= 0) {
    face = "worried";
    line = key === "planks" ? "Didn't catch a hold. <b>Side-on, whole body</b> in frame." : "Didn't catch any reps. <b>Side-on, whole body</b> in frame.";
  } else if (dayDone) {
    face = "wow";
    line = `That's the day! <b>Day ${dayNumber}</b> is yours.`;
  } else if (newBest) {
    face = "wow";
    line = key === "planks" ? `<b>${value}s</b> without stopping. <span class="gold">New record.</span>` : `<b>${value}</b> in one go. <span class="gold">New record.</span> I felt that.`;
  } else if (finishesIt) {
    line = key === "planks" ? `${value} seconds of not quitting. Plank's done.` : `That's ${lower} done for today.`;
    if (left.length) line += ` Next: <b>${left[0]}</b>.`;
  } else if (before >= m[key]) {
    line = `Extra credit. ${SET_NAMES[key]} ${was} already done.`;
  } else if (key === "planks") {
    line = value > before ? `${value}s. You need one <b>${m.planks}s</b> hold.` : `${value}s. Your best today is still <b>${before}s</b>.`;
  } else {
    line = `+${value}. <b>${m[key] - total} more</b> and ${lower} are done.`;
  }

  return {
    key,
    from: before / target,
    to: total / target,
    total,
    target: m[key],
    badges,
    line,
    face,
    day: DAY_KEYS.map((k) => ({ key: k, name: SET_NAMES[k], done: totalOf(k) >= m[k] })),
  };
}

// The days a rest day kept the streak going (nothing stores them; see
// ForjaRules.restDays). The current streak's own numbers settle the
// latest stretch, and days missed since then show as rest days right away
// if the streak can still be saved today.
function restDaySet() {
  return new Set(ForjaRules.restDays(data.history, { ...streakStats(), today: todayString() }));
}

function streakStats() {
  return { streak: data.streak, bestStreak: data.bestStreak, lastLoggedDate: data.lastLoggedDate, restDaysUsed: data.restDaysUsed, weekStartDate: data.weekStartDate };
}

// The streak as it stands today: 0 once it ran out of rest days, even
// before the next workout updates the saved number.
function currentStreak() {
  return ForjaRules.shownStreak(streakStats(), todayString());
}

// Builds the "last 12 weeks" grid of small squares, one per day, colored
// based on whether that day is in data.history (or was a rest day).
function renderHeatmap() {
  const heatmapEl = document.getElementById("heatmap");

  // Clear out anything already there before rebuilding it from scratch.
  heatmapEl.innerHTML = "";

  const totalDays = 56; // 8 weeks * 7 days
  const rested = restDaySet();

  // Loop from the oldest day (83 days ago) up to today, creating one
  // square per day in order. CSS Grid (set up in style.css) is what
  // arranges these into 7-row columns automatically.
  for (let daysAgo = totalDays - 1; daysAgo >= 0; daysAgo--) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const dateStr = dateToString(date);

    // document.createElement makes a new HTML element in memory - it
    // doesn't appear on the page until we attach it with appendChild.
    const cell = document.createElement("div");
    cell.className = "heatmap-day";

    if (data.history.includes(dateStr)) {
      cell.classList.add("completed");
    } else if (rested.has(dateStr)) {
      cell.classList.add("rest");
    }

    // The "title" attribute shows as a small tooltip when you hover.
    cell.title = rested.has(dateStr) ? `${dateStr} · rest day` : dateStr;

    heatmapEl.appendChild(cell);
  }
}

// The Me tab's distance chart: walk/run distance as bars for this week, this
// month, the last 6 months or this year, like the Health app. One series,
// one color. The headline shows the total; tapping or dragging across the
// bars shows a single bar's number instead.
const DISTANCE_RANGES = ["W", "M", "6M", "Y"];
const DISTANCE_RANGE_KEY = "forja-distance-range";
let distanceRange = "W";
try {
  if (DISTANCE_RANGES.includes(localStorage.getItem(DISTANCE_RANGE_KEY))) distanceRange = localStorage.getItem(DISTANCE_RANGE_KEY);
} catch (e) {
  // storage blocked - starts on Week
}
let distanceBuckets = [];
let distanceSelected = null; // the tapped bar's index, or null for the total

function startOfWeek(date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

function plusDays(date, n) {
  const next = new Date(date);
  next.setDate(next.getDate() + n);
  return next;
}

const shortDate = (date, extra = {}) => date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...extra });

// One bucket per bar: its first and last day, the label under it, what the
// headline says when it's tapped, and the distance walked/run in it.
function buildDistanceBuckets(range) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets = [];
  if (range === "W") {
    const monday = startOfWeek(today);
    for (let i = 0; i < 7; i++) {
      const day = plusDays(monday, i);
      buckets.push({ start: day, end: day, label: ["M", "T", "W", "T", "F", "S", "S"][i], title: day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) });
    }
  } else if (range === "M") {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    for (let i = 0; i < daysInMonth; i++) {
      const day = plusDays(first, i);
      buckets.push({ start: day, end: day, label: [1, 8, 15, 22, 29].includes(i + 1) ? String(i + 1) : "", title: day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) });
    }
  } else if (range === "6M") {
    const thisWeek = startOfWeek(today);
    for (let i = 25; i >= 0; i--) {
      const start = plusDays(thisWeek, -7 * i);
      const newMonth = i === 25 || start.getMonth() !== plusDays(start, -7).getMonth();
      buckets.push({ start, end: plusDays(start, 6), label: newMonth ? start.toLocaleDateString(undefined, { month: "narrow" }) : "", title: "Week of " + shortDate(start) });
    }
  } else {
    for (let month = 0; month < 12; month++) {
      const start = new Date(today.getFullYear(), month, 1);
      buckets.push({ start, end: new Date(today.getFullYear(), month + 1, 0), label: start.toLocaleDateString(undefined, { month: "narrow" }), title: start.toLocaleDateString(undefined, { month: "long" }) });
    }
  }

  for (const bucket of buckets) {
    const from = dateToString(bucket.start);
    const to = dateToString(bucket.end);
    const routes = data.routes.filter((route) => route.date >= from && route.date <= to);
    const km = routes.reduce((total, route) => total + route.distanceKm, 0);
    bucket.value = data.units === "km" ? km : milesFromKm(km);
    bucket.count = routes.length;
    bucket.future = bucket.start > today;
  }
  return buckets;
}

// What the whole range covers, under the total ("Oct 6 – 12, 2026").
function distanceRangeText(range, buckets) {
  const first = buckets[0].start;
  const last = buckets[buckets.length - 1].end;
  if (range === "W") {
    const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
    // formatRange writes it the way the phone does ("Oct 5 – 11, 2026").
    return format.formatRange ? format.formatRange(first, last) : `${shortDate(first)} – ${shortDate(last, { year: "numeric" })}`;
  }
  if (range === "M") return first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (range === "6M") return `${first.toLocaleDateString(undefined, { month: "short" })} – ${new Date().toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
  return String(first.getFullYear());
}

const formatChartDistance = (value) => (value === 0 ? "0" : value < 100 ? value.toFixed(1) : String(Math.round(value)));
// Grid numbers drop a needless ".0" (5, 2.5, 0.25).
const formatChartAxis = (value) => String(Number(value.toFixed(2)));

// A round number just above the biggest bar, for the top grid line. Each
// choice halves to a round number too, for the middle line.
function niceChartMax(max) {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 3, 4, 5, 6, 8, 10].find((n) => n * power >= max - 1e-9);
  return step * power;
}

// Rebuilds the bars (a new range, new routes, other units). The bars grow
// up from the baseline each time.
function renderDistanceChart() {
  const chart = document.getElementById("distance-chart");
  if (!data) return;
  distanceBuckets = buildDistanceBuckets(distanceRange);
  if (distanceSelected !== null && (distanceSelected >= distanceBuckets.length || distanceBuckets[distanceSelected].future)) distanceSelected = null;
  const top = niceChartMax(Math.max(...distanceBuckets.map((bucket) => bucket.value)));

  chart.dataset.range = distanceRange;
  chart.innerHTML = `
    <div class="dc-plot">
      ${[1, 0.5, 0].map((share) => `<div class="dc-grid${share === 0 ? " dc-baseline" : ""}" style="bottom:${share * 100}%"><span>${formatChartAxis(top * share)}</span></div>`).join("")}
      <div class="dc-bars">${distanceBuckets.map((bucket, i) => `<div class="dc-slot" data-index="${i}"><div class="dc-bar"></div></div>`).join("")}</div>
    </div>
    <div class="dc-labels" aria-hidden="true">${distanceBuckets.map((bucket) => `<span>${bucket.label}</span>`).join("")}</div>`;

  void chart.offsetHeight; // start from zero height, so the change animates
  chart.querySelectorAll(".dc-bar").forEach((bar, i) => {
    const value = distanceBuckets[i].value;
    // Any distance at all shows as at least a sliver.
    bar.style.height = value > 0 ? Math.max(1.5, (value / top) * 100) + "%" : "0";
  });

  document.querySelectorAll("#distance-range button").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.range === distanceRange));
  });
  updateDistanceSummary();
}

// The headline: the range's total, or the tapped bar.
function updateDistanceSummary() {
  const chart = document.getElementById("distance-chart");
  const unit = distanceUnitLabel();
  const total = distanceBuckets.reduce((sum, bucket) => sum + bucket.value, 0);
  const picked = distanceSelected === null ? null : distanceBuckets[distanceSelected];

  document.getElementById("distance-summary-label").textContent = picked ? picked.title : "Total";
  document.getElementById("distance-summary-value").textContent = formatChartDistance(picked ? picked.value : total);
  document.getElementById("distance-summary-unit").textContent = unit;
  document.getElementById("distance-summary-sub").textContent = picked
    ? picked.count === 1 ? "1 walk or run" : `${picked.count} walks or runs`
    : distanceRangeText(distanceRange, distanceBuckets);

  chart.classList.toggle("has-selection", !!picked);
  chart.querySelectorAll(".dc-slot").forEach((slot, i) => slot.classList.toggle("selected", i === distanceSelected));
  chart.setAttribute("aria-label", `Distance, ${distanceRangeText(distanceRange, distanceBuckets)}: ${formatChartDistance(total)} ${unit}`);
}

function selectDistanceBar(index) {
  if (index !== null && (index < 0 || index >= distanceBuckets.length || distanceBuckets[index].future)) return;
  distanceSelected = index;
  updateDistanceSummary();
}

document.querySelectorAll("#distance-range button").forEach((button) => {
  button.addEventListener("click", () => {
    distanceRange = button.dataset.range;
    distanceSelected = null;
    try {
      localStorage.setItem(DISTANCE_RANGE_KEY, distanceRange);
    } catch (e) {
      // not remembered next time
    }
    renderDistanceChart();
  });
});

// Touch a bar to read it; slide along to read the others. Tapping the
// bar that's already showing goes back to the total.
(function wireDistanceChart() {
  const chart = document.getElementById("distance-chart");
  let pressing = false;
  let moved = false;
  let wasSelected = false;

  const barAt = (x) => {
    const slots = [...chart.querySelectorAll(".dc-slot")];
    let best = null;
    let bestGap = Infinity;
    slots.forEach((slot, i) => {
      if (distanceBuckets[i].future) return;
      const rect = slot.getBoundingClientRect();
      const gap = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    return best;
  };

  chart.addEventListener("pointerdown", (event) => {
    const index = barAt(event.clientX);
    if (index === null) return;
    pressing = true;
    moved = false;
    wasSelected = index === distanceSelected;
    selectDistanceBar(index);
  });
  chart.addEventListener("pointermove", (event) => {
    if (!pressing) return;
    const index = barAt(event.clientX);
    if (index !== null && index !== distanceSelected) {
      moved = true;
      selectDistanceBar(index);
    }
  });
  window.addEventListener("pointerup", () => {
    if (pressing && !moved && wasSelected) selectDistanceBar(null);
    pressing = false;
  });
  // The page took over (a scroll) - keep whatever bar is showing.
  window.addEventListener("pointercancel", () => {
    pressing = false;
  });

  // Keyboard: arrows move between bars, Escape goes back to the total.
  chart.addEventListener("keydown", (event) => {
    const lastPast = distanceBuckets.reduce((last, bucket, i) => (bucket.future ? last : i), 0);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.key === "ArrowLeft" ? -1 : 1;
      const from = distanceSelected === null ? (step < 0 ? lastPast + 1 : -1) : distanceSelected;
      selectDistanceBar(Math.min(lastPast, Math.max(0, from + step)));
    } else if (event.key === "Escape") {
      selectDistanceBar(null);
    }
  });
})();

// Full calendar view (opened by tapping the small heatmap) - shows every
// day of a given month with actual date numbers, not just colored
// squares, and lets you page between months to see any date's history.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Which month is currently being viewed - reset to today's month every
// time the calendar is opened.
let calendarViewDate = new Date();

function renderCalendarMonth() {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();

  document.getElementById("calendar-month-label").textContent = `${MONTH_NAMES[month]} ${year}`;

  const gridEl = document.getElementById("calendar-grid");
  gridEl.innerHTML = "";

  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate(); // day 0 of next month = last day of this one
  const startWeekday = firstOfMonth.getDay(); // 0 = Sunday, matching the Su-Sa header

  // Empty filler cells so day 1 lines up under its correct weekday column.
  for (let i = 0; i < startWeekday; i++) {
    const filler = document.createElement("div");
    filler.className = "calendar-day empty";
    gridEl.appendChild(filler);
  }

  const todayStr = todayString();
  const rested = restDaySet();

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = dateToString(new Date(year, month, day));

    const cell = document.createElement("div");
    cell.className = "calendar-day";
    if (data.history.includes(dateStr)) {
      cell.classList.add("completed");
    } else if (rested.has(dateStr)) {
      cell.classList.add("rest");
      cell.title = "Rest day";
    }
    if (dateStr === todayStr) {
      cell.classList.add("is-today");
    }
    cell.textContent = day;

    gridEl.appendChild(cell);
  }
}

document.getElementById("heatmap-section").addEventListener("click", () => {
  calendarViewDate = new Date();
  renderCalendarMonth();
  showScreen("calendar-screen");
});

document.getElementById("calendar-prev-month").addEventListener("click", () => {
  // setMonth handles year rollover automatically (e.g. January - 1
  // correctly becomes December of the previous year).
  calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
  renderCalendarMonth();
});

document.getElementById("calendar-next-month").addEventListener("click", () => {
  calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
  renderCalendarMonth();
});

document.getElementById("calendar-close-button").addEventListener("click", () => {
  showScreen("app-screen");
});


// Fades the splash screen out - guarded so it only ever runs once, and
// wrapped in a brief timeout so it displays for at least a fraction of a
// second instead of flashing away instantly if things resolved quickly.
let splashHidden = false;
function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  setTimeout(() => {
    const splash = document.getElementById("splash-screen");
    splash.classList.add("splash-fade-out");
    // Removed once it has faded, so the turning logo stops running.
    setTimeout(() => splash.remove(), 450);
  }, 500);
}

// The 4 mutually-exclusive full-screen views. Listing them once here
// means adding a 5th screen later only needs one new line, not a matching
// "hide this one" line added into every other show-a-different-screen
// function (which is exactly how the reset-password screen almost got
// left out of revealApp() below).
const SCREEN_IDS = ["onboarding-screen", "auth-screen", "forgot-password-screen", "reset-password-screen", "app-screen", "tracking-summary-screen", "share-route-screen", "calendar-screen", "follow-list-screen", "user-actions-screen", "account-screen", "my-plan-screen", "challenge-screen", "reminder-setup-screen", "camera-screen"];

function showScreen(idToShow) {
  SCREEN_IDS.forEach((id) => {
    document.getElementById(id).classList.toggle("hidden", id !== idToShow);
  });
  hideSplash();
  if (idToShow === "app-screen" && signupInvitePending && !currentUserId) inviteGuestToSignUp();
}

// Shows the app's main tabs and fills in every part of the page from
// whatever `data` currently holds - shared by both the logged-in path
// and the guest path below, since both end up needing the exact same
// on-screen setup once `data` is ready.
function revealApp(show = true) {
  render();
  renderHeatmap();
  renderDistanceChart();
  renderMinTags();
  renderSettingsInputs();
  updateMeTabAuthSection();
  if (show) showScreen("app-screen");
}

// Runs once we know someone is logged in: loads their data from the
// database, then reveals the app.
async function showApp(userId) {
  // A different account than the last one (logged out, then in as someone
  // else): its username must be looked up again, not carried over.
  if (userId !== currentUserId) {
    myUsername = null;
    friendIds = [];
  }
  currentUserId = userId;
  const result = await loadUserData(userId);
  if (!result) {
    showLoadError(() => showApp(userId));
    return;
  }
  data = result.data;
  shownUserId = userId;
  // A brand new account brings along what this phone did as a guest today
  // (its plan's starting numbers came with `data`), and the username typed
  // when signing up.
  let username = { taken: false };
  if (result.isNewAccount) {
    await claimGuestSets();
    username = await claimPendingUsername();
    recordSignupSource();
  }
  // The streak and today's verified totals belong to the server - pull
  // them in before the first draw so nothing shows a stale local copy.
  // A new account's plan starts at the pace picked during sign-up.
  await Promise.all([loadServerStats(), refreshVerifiedProgress(), loadServerPlan(result.isNewAccount ? data.startPace : undefined)]);
  const signingUp = Onboarding.isActive();
  revealApp(!signingUp && !cameraIsOpen());
  // Catches a day that hit its minimums but didn't get saved (no signal).
  maybeCompleteDay();
  updateFriendRequestBadge();
  updateFeedBadge();
  refreshNotifAskMode();
  loadReceivedNudges();
  refreshMyColor();
  syncTimeZone();
  acceptPendingInvite();
  loadWeekRecap();

  if (signingUp) {
    // The sign-up flow carries on (reminders, friends) from here.
    Onboarding.accountReady({ isNewAccount: result.isNewAccount, usernameTaken: username.taken });
  } else if (result.isNewAccount) {
    // A brand new account (not a returning login) gets one chance to turn
    // on reminders right away, instead of needing to find the toggle
    // buried in Settings themselves.
    showScreen("reminder-setup-screen");
  } else {
    recoverUnsavedSet();
  }
}

// Checked right away on app load (not just when the Competition tab
// happens to be opened) so a pending friend request is actually visible
// somewhere, instead of silently sitting in the database until someone
// happens to tap into that specific tab.
async function updateFriendRequestBadge() {
  const badgeEl = document.getElementById("competition-tab-badge");
  if (!currentUserId) {
    badgeEl.classList.add("hidden");
    return;
  }

  const { count } = await supabaseClient
    .from("friendships")
    .select("id", { count: "exact", head: true })
    .eq("addressee_id", currentUserId)
    .eq("status", "pending");

  badgeEl.classList.toggle("hidden", !count);
}

// The same dot on the Feed tab when a friend has posted since this phone
// last had the Feed open. "Seen" is the newest friend post's own time (the
// server's clock, so a phone set a few minutes off can't hide a post),
// kept per account on this phone. On a phone that has never opened the
// Feed, nothing that's already there counts as new.
const FEED_SEEN_KEY = "forja-feed-seen";

function readFeedSeen() {
  try {
    return JSON.parse(localStorage.getItem(FEED_SEEN_KEY) || "{}")[currentUserId] ?? null;
  } catch (e) {
    return null;
  }
}

function writeFeedSeen(ms) {
  try {
    const seen = JSON.parse(localStorage.getItem(FEED_SEEN_KEY) || "{}");
    seen[currentUserId] = ms;
    localStorage.setItem(FEED_SEEN_KEY, JSON.stringify(seen));
  } catch (e) {
    // storage blocked - the dot just may show again
  }
}

const feedOnScreen = () => !document.getElementById("app-screen").classList.contains("hidden") && !TABS.feed.panel.classList.contains("hidden");

async function updateFeedBadge() {
  const badgeEl = document.getElementById("feed-tab-badge");
  const viewerId = currentUserId;
  if (!viewerId) {
    badgeEl.classList.add("hidden");
    return;
  }
  // Friends' posts only (RLS already limits the Feed to you and your friends).
  const { data: rows, error } = await supabaseClient
    .from("feed_events")
    .select("created_at")
    .neq("user_id", viewerId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || viewerId !== currentUserId) return;
  const newest = rows && rows[0] ? Date.parse(rows[0].created_at) : 0;
  const seen = readFeedSeen();
  if (seen === null || feedOnScreen()) {
    if (newest > (seen || 0)) writeFeedSeen(newest);
    if (seen === null && !newest) writeFeedSeen(0);
    badgeEl.classList.add("hidden");
    return;
  }
  badgeEl.classList.toggle("hidden", !(newest > seen));
}

// Friends who nudged you today: the pet on Today says so until you start
// training. "Today" is the date nudges are saved under (your own).
async function loadReceivedNudges() {
  const viewerId = currentUserId;
  const day = todayString();
  if (!viewerId || typeof Celebrations === "undefined") return;
  const { data: rows, error } = await supabaseClient
    .from("nudges")
    .select("sender_id")
    .eq("receiver_id", viewerId)
    .eq("day", day)
    .order("created_at", { ascending: true });
  if (error || viewerId !== currentUserId) return;
  const ids = (rows || []).map((row) => row.sender_id);
  let names = [];
  if (ids.length) {
    const { data: profiles, error: profileError } = await supabaseClient.from("profiles").select("user_id, username, avatar_color").in("user_id", ids);
    if (profileError || viewerId !== currentUserId) return;
    rememberAvatarColors(profiles);
    const nameById = new Map((profiles || []).map((p) => [p.user_id, p.username]));
    names = ids.map((id) => nameById.get(id)).filter(Boolean);
  }
  Celebrations.setNudgers(names, viewerId, day);
}

// Coming back to the app: friends may have posted, sent a request or
// nudged you since.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !currentUserId) return;
  updateFeedBadge();
  updateFriendRequestBadge();
  refreshNotifAskMode();
  loadReceivedNudges();
  refreshMyColor();
  loadWeekRecap();
  refreshServerNumbers();
});

// The streak, today's verified sets and the plan, fresh from the server -
// the Home Screen app can stay open for days, and another phone may have
// logged in between. Never mid-set or while a day saves, and it redraws
// in place without changing screens.
async function refreshServerNumbers() {
  if (cameraIsOpen() || savingDay || shownUserId !== currentUserId) return;
  const viewerId = currentUserId;
  await Promise.all([loadServerStats(), refreshVerifiedProgress(), loadServerPlan()]);
  if (viewerId !== currentUserId || !data) return;
  revealApp(false);
}

function cameraIsOpen() {
  return !document.getElementById("camera-screen").classList.contains("hidden");
}

// Lets someone use the full app without an account yet. Their data is
// only saved to this browser (via saveData's guest branch) until they
// eventually sign up, at which point loadUserData migrates it in.
function showAppAsGuest() {
  currentUserId = null;
  dropOldGuestSets();
  data = loadLocalData() || defaultData();
  revealApp();
  maybeCompleteDay();
  recoverUnsavedSet();
}

// Shows/hides the right button at the bottom of the Me tab depending on
// whether you're logged in or just browsing as a guest.
function updateMeTabAuthSection() {
  document.querySelector("#open-minimums-button span").textContent = currentUserId ? "My Plan" : "Daily Minimums";
  document.getElementById("log-out-button").classList.toggle("hidden", !currentUserId);
  document.getElementById("guest-signup-button").classList.toggle("hidden", !!currentUserId);
  // Editing/sharing a profile only makes sense for a real account - a
  // guest has no username or email stored anywhere yet.
  document.getElementById("edit-profile-button").classList.toggle("hidden", !currentUserId);
  document.getElementById("share-profile-button").classList.toggle("hidden", !currentUserId);
  // Deleting an account only makes sense for someone who has one.
  document.getElementById("delete-account-button").classList.toggle("hidden", !currentUserId);
  if (!currentUserId) document.getElementById("delete-account-panel").classList.add("hidden");
}

// Runs when nobody is logged in. Opened from the sign-up flow's welcome
// screen, it has a Back link to it instead of "Skip for now".
function showAuthScreen({ fromOnboarding = false } = {}) {
  document.getElementById("auth-back").classList.toggle("hidden", !fromOnboarding);
  document.getElementById("auth-skip").classList.toggle("hidden", fromOnboarding);
  showScreen("auth-screen");
}

// Shown after clicking a password reset link from email.
function showResetPasswordScreen() {
  showScreen("reset-password-screen");
}

function showForgotPasswordScreen() {
  showScreen("forgot-password-screen");
}

// Set right before a deliberate log-out, so the handler below knows to
// show the login screen instead of dropping back into guest mode.
let justLoggedOut = false;

// This is the actual entry point for the whole app. onAuthStateChange
// fires once immediately with whatever the current login state is (so it
// covers the very first page load), and again every time someone logs
// in or out - one listener handles all three cases below.
supabaseClient.auth.onAuthStateChange((event, session) => {
  // Clicking a password reset link logs you into a special temporary
  // session. Supabase announces that session (INITIAL_SESSION) BEFORE it
  // says it's a reset (PASSWORD_RECOVERY), so the link itself is what
  // counts (inPasswordRecovery, read from the address at start-up) -
  // otherwise the first event would start loading the app, and it would
  // open over this screen a moment later.
  if (event === "PASSWORD_RECOVERY") inPasswordRecovery = true;
  if (inPasswordRecovery && session) {
    showResetPasswordScreen();
    return;
  }

  if (session) {
    justLoggedOut = false;
    // The same account again: supabase-js renews the login every hour
    // (TOKEN_REFRESHED) and can announce it again when the app comes back
    // on screen. Loading the whole app again would jump off whatever screen
    // is open - mid-set, the camera closed and the reps were lost
    // (2026-10-16). Coming back on screen refreshes what the server owns
    // instead (see the visibilitychange listener).
    if (session.user.id === shownUserId) return;
    showApp(session.user.id);
    return;
  }

  shownUserId = null;
  currentUserId = null;
  data = null;
  serverPlan = null;
  myUsername = null; // or the next account (or a guest) would show and share this one's name
  friendIds = [];
  // Nothing from the last account's Feed may linger for whoever signs in next.
  document.getElementById("feed-list").innerHTML = "";
  document.getElementById("feed-tab-badge").classList.add("hidden");

  if (justLoggedOut) {
    justLoggedOut = false;
    showAuthScreen();
    return;
  }

  // A reset link that expired or was already used: say so where a new one
  // can be sent, instead of quietly opening the app.
  if (resetLinkFailed) {
    resetLinkFailed = false;
    showForgotPasswordScreen();
    forgotPasswordErrorEl.classList.remove("success");
    forgotPasswordErrorEl.textContent = "That reset link has expired or was already used. Send yourself a new one.";
    return;
  }

  // First-time visitors get the sign-up flow (questions, plan, Day 1);
  // anyone who has already been through it (including a guest just
  // reopening the app) goes straight into using the app.
  if (localStorage.getItem("streakfit-seen-onboarding")) {
    showAppAsGuest();
  } else if (!Onboarding.isActive()) {
    Onboarding.start();
  }
});


// STEP 3: Handle the button click and the actual streak logic.

// Copies the streak numbers (from the server, or computed for a guest)
// into the local data the rest of the screen reads from.
function applyStats(stats) {
  data.streak = stats.streak;
  data.bestStreak = stats.bestStreak;
  data.lastLoggedDate = stats.lastLoggedDate;
  data.restDaysUsed = stats.restDaysUsed;
  data.weekStartDate = stats.weekStartDate;
}

// Calls an Edge Function and always hands back an object with `ok`. A
// failed call (non-2xx) still carries the server's error code in its
// body, which supabase-js tucks inside the error's response - read it
// back out so callers can show a real reason instead of "something broke".
async function callServerFunction(name, body) {
  const { data: reply, error } = await supabaseClient.functions.invoke(name, { body });
  if (!error && reply) return reply;
  if (error && error.context && typeof error.context.json === "function") {
    try {
      return await error.context.json();
    } catch (e) {
      // not JSON - fall through to the generic failure
    }
  }
  return { ok: false, error: "network" };
}

function serverErrorMessage(reply) {
  switch (reply.error) {
    case "below_minimum":
      return "The server doesn't have enough verified sets for today yet.";
    case "already_logged":
      return "Today is already logged.";
    case "bad_day":
      return "Your phone's date looks wrong - check it and try again.";
    case "too_many_sets":
    case "daily_limit":
      return "You've hit today's limit for verified sets.";
    case "implausible":
      return "That set didn't look like real reps, so it wasn't counted.";
    case "bad_trace":
      return "That recording couldn't be verified. Try the set again.";
    case "unauthorized":
      return "Please log in again.";
    default:
      return "Couldn't reach the server. Check your connection and try again.";
  }
}

// Has today reached every minimum - the camera-verified exercises, plus
// walk/run minutes if that goal is turned on?
function minimumsMet() {
  const progress = todayProgress();
  const walkRunEnabled = data.minimums.walkRun !== null;
  return (
    progress.pushups >= data.minimums.pushups &&
    progress.planks >= data.minimums.planks &&
    progress.squats >= data.minimums.squats &&
    (!walkRunEnabled || progress.walkRun >= data.minimums.walkRun)
  );
}

// Today logs itself: there's no button to remember to press. This runs
// after anything that can complete the day (a saved set, a finished walk,
// lowered minimums, opening the app) and logs it the moment every minimum
// is hit. If saving fails - no signal, say - a Try Again button appears,
// and the next app open tries again on its own.
async function maybeCompleteDay() {
  if (!data || savingDay || data.lastLoggedDate === todayString() || !minimumsMet()) return;

  const today = todayString();
  savingDay = true;
  saveDayFailed = false;
  errorMessageEl.textContent = "";
  render();

  // A signed-in player's day is logged by the server, which checks ITS OWN
  // record of their verified sets before moving the streak - the numbers
  // on this screen are just a copy of what it says. A guest has no server
  // record (and isn't ranked), so their day is logged here, with the same
  // streak rules.
  let stats;
  let levelUp = false;
  if (currentUserId) {
    const reply = await callServerFunction("log-day", { day: today });
    savingDay = false;
    if (!reply.ok) {
      if (reply.error === "already_logged" && reply.stats) {
        // Already done (e.g. from another device) - nothing went wrong.
        applyStats(reply.stats);
        saveData(data);
      } else {
        saveDayFailed = true;
        errorMessageEl.textContent = serverErrorMessage(reply);
        // The server's targets win (e.g. the plan moved on another device):
        // fetch its plan so the screen shows what's still missing.
        if (reply.error === "below_minimum") loadServerPlan();
      }
      render();
      return;
    }
    stats = reply.stats;
    // The server moved the plan forward; tomorrow's targets come from it.
    if (reply.plan) serverPlan = reply.plan;
    levelUp = !!(reply.planEvents && reply.planEvents.levelUp);
  } else {
    stats = ForjaRules.nextStats(
      {
        streak: data.streak,
        bestStreak: data.bestStreak,
        lastLoggedDate: data.lastLoggedDate,
        restDaysUsed: data.restDaysUsed,
        weekStartDate: data.weekStartDate,
      },
      today
    );
    savingDay = false;
  }
  applyStats(stats);

  if (!data.history.includes(today)) {
    data.history.push(today);
  }

  saveData(data);
  // Queued before render() so the ring waits to close until the moment
  // plays on Today (the day often completes while the camera is open).
  if (typeof Celebrations !== "undefined") Celebrations.dayComplete({ streak: data.streak, levelUp });
  render();
  renderHeatmap();

  // (The sign-up flow asks for an account its own way.)
  if (!currentUserId && data.history.length === 1 && !Onboarding.isActive()) {
    signupInvitePending = true;
    if (!document.getElementById("app-screen").classList.contains("hidden")) inviteGuestToSignUp();
  }
}

retryLogButtonEl.addEventListener("click", maybeCompleteDay);

// A guest who just completed their very first day gets invited to create
// an account right at that "high point" - after a short pause so they
// actually get to see the streak update first, not instead of it. The day
// can complete on another screen (the camera, or a finished walk's
// summary), so the invite waits until they're back on the main screen
// rather than interrupting whatever they're doing (see showScreen).
function inviteGuestToSignUp() {
  signupInvitePending = false;
  setTimeout(() => {
    authMode = "signup";
    applyAuthMode();
    authSubtitleEl.textContent = "Day 1 complete! Create an account today to keep your streak and compete with friends.";
    showAuthScreen();
  }, 1800);
}


// STEP 4: Tabs (Today / Feed / Competition / Record / Me) and the leaderboard.

// Each tab's name maps to its button and panel elements, so showTab()
// can loop over them instead of needing a separate if/else per tab.
const TABS = {
  today: {
    button: document.getElementById("tab-btn-today"),
    panel: document.getElementById("tab-today"),
  },
  feed: {
    button: document.getElementById("tab-btn-feed"),
    panel: document.getElementById("tab-feed"),
  },
  competition: {
    button: document.getElementById("tab-btn-competition"),
    panel: document.getElementById("tab-competition"),
  },
  me: {
    button: document.getElementById("tab-btn-me"),
    panel: document.getElementById("tab-me"),
  },
  record: {
    button: document.getElementById("tab-btn-record"),
    panel: document.getElementById("tab-record"),
  },
};

function showTab(tabName) {
  for (const name in TABS) {
    const isActive = name === tabName;
    TABS[name].panel.classList.toggle("hidden", !isActive);
    TABS[name].button.classList.toggle("active", isActive);
  }

  if (tabName === "today" && typeof Celebrations !== "undefined") {
    Celebrations.enterToday(); // the pet hops back in and says where things stand
  }
  if (tabName === "feed") {
    enterFeedTab();
  }
  if (tabName === "competition") {
    enterCompetitionTab();
  }
  if (tabName === "record") {
    enterRecordTab();
  }
  if (tabName === "me") {
    // Redrawn on the way in, so the bars grow in where they can be seen.
    renderDistanceChart();
    enterMeTab();
  }
}

TABS.today.button.addEventListener("click", () => showTab("today"));
TABS.feed.button.addEventListener("click", () => showTab("feed"));
TABS.competition.button.addEventListener("click", () => showTab("competition"));
TABS.me.button.addEventListener("click", () => showTab("me"));
TABS.record.button.addEventListener("click", () => showTab("record"));

// Reusable icon markup - defined once, inserted wherever needed via
// template literals, instead of repeating the same SVG code every time.
const PERSON_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>';
// The streak's mark: Today's ring, small (a streak = days the ring closed).
// Three slices from 12 o'clock, a gap after each (r 15: 94.25 around).
const STREAK_RING_SVG = `<svg viewBox="0 0 40 40" fill="none" stroke-width="6" stroke-linecap="round" aria-hidden="true"><g transform="rotate(-90 20 20)">${["pushups", "planks", "squats"]
  .map((key, i) => `<circle cx="20" cy="20" r="15" stroke="var(--ring-${key})" stroke-dasharray="22.4 71.85" stroke-dashoffset="${(-i * 31.42 - 4.5).toFixed(2)}"/>`)
  .join("")}</g></svg>`;

// Everyone gets a colored circle with their first letter, like WhatsApp.
// Each account has its own color (profiles.avatar_color: random to start,
// changeable from the Me tab). These are the 12 allowed, each dark enough
// for a white letter.
const AVATAR_COLORS = {
  red: "#dc2626", orange: "#ea580c", amber: "#d97706", lime: "#65a30d",
  green: "#16a34a", teal: "#0d9488", cyan: "#0891b2", blue: "#2563eb",
  indigo: "#4f46e5", violet: "#7c3aed", pink: "#db2777", graphite: "#52525b",
};

// username -> color name, from every profiles row the app has loaded, so
// any screen showing a name can draw that person's circle. Kept on the
// phone too, so circles open in the right color instead of a guess from
// the name until the server answers.
const AVATAR_COLORS_KEY = "forja-avatar-colors";
const avatarColorByName = new Map(readSavedAvatarColors());

function readSavedAvatarColors() {
  try {
    return Object.entries(JSON.parse(localStorage.getItem(AVATAR_COLORS_KEY) || "{}")).filter(([, color]) => AVATAR_COLORS[color]);
  } catch (e) {
    return [];
  }
}

function saveAvatarColors() {
  try {
    localStorage.setItem(AVATAR_COLORS_KEY, JSON.stringify(Object.fromEntries(avatarColorByName)));
  } catch (e) {
    // storage blocked - colors just load a moment later next time
  }
}

function rememberAvatarColors(rows) {
  let changed = false;
  (rows || []).forEach((row) => {
    if (!row || !row.username || !AVATAR_COLORS[row.avatar_color] || avatarColorByName.get(row.username) === row.avatar_color) return;
    avatarColorByName.set(row.username, row.avatar_color);
    changed = true;
  });
  if (changed) saveAvatarColors();
}

// Someone's saved color - or, before it's loaded, one picked from their name.
function avatarColor(name) {
  const saved = avatarColorByName.get(name);
  if (saved) return AVATAR_COLORS[saved];
  const shades = Object.values(AVATAR_COLORS);
  let hash = 0;
  for (const ch of String(name).toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return shades[hash % shades.length];
}

// Only a letter or digit ever reaches the HTML; anything else (or no name)
// gets the plain person icon.
function avatarHtml(name, className = "leaderboard-avatar") {
  const letter = (String(name || "").match(/[a-z0-9]/i) || [""])[0].toUpperCase();
  if (!letter) return `<span class="${className}">${PERSON_ICON_SVG}</span>`;
  return `<span class="${className} has-letter" style="--avatar: ${avatarColor(name)}" aria-hidden="true">${letter}</span>`;
}

// Real friends: usernames (so nobody's email is ever exposed), a
// request/accept flow, and a leaderboard built from actual streak data.

let myUsername = null;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

// Usernames are typed by OTHER real people now, not our own hardcoded
// mock data - so unlike the old fake leaderboard, this text can't be
// trusted. Building rows with a blank name span and setting it via
// textContent (never interpolated into innerHTML) means a maliciously
// crafted username can never inject HTML/scripts into someone else's page.
// Number(...) on the streak is a second guard behind the database rule that
// streaks must be numbers: whatever arrives, only a number reaches the HTML.
// `doneToday`: they've trained today. A friend who hasn't gets a Nudge
// button (once a day; `nudged` = already sent today).
function buildLeaderboardRow({ name, streak, isYou, userId, doneToday, nudged }, rank) {
  const row = document.createElement("div");
  row.className = "leaderboard-row";
  if (isYou) row.classList.add("is-you");

  row.innerHTML = `
    <span class="leaderboard-rank">#${rank}</span>
    ${avatarHtml(name)}
    <span class="leaderboard-who">
      <span class="leaderboard-name"></span>
      <span class="leaderboard-today ${doneToday ? "is-done" : ""}">${doneToday ? "Done today" : "Not yet today"}</span>
    </span>
    ${isYou || doneToday ? "" : `<button class="nudge-button"></button>`}
    <span class="leaderboard-streak">${Number(streak) || 0} ${STREAK_RING_SVG}</span>
    ${isYou ? '<span class="row-options-spacer" aria-hidden="true"></span>' : '<button class="row-options-button" aria-label="More options">&#8942;</button>'}
  `;
  row.querySelector(".leaderboard-name").textContent = name;

  if (!isYou) {
    row.querySelector(".row-options-button").addEventListener("click", () => openUserActions(userId, name, "app-screen", null));
  }
  const nudgeButton = row.querySelector(".nudge-button");
  if (nudgeButton) {
    drawNudgeButton(nudgeButton, name, nudged);
    nudgeButton.addEventListener("click", () => sendNudge(nudgeButton, row, userId, name));
  }

  return row;
}

// ---------- friend nudges ----------
// A green "Nudge" pill (the look of every action); once sent, a quiet gray
// "Nudged" with a check. (It used to copy Kudos, lit once sent - which read
// as the opposite: the nudged friends looked like the ones to tap.) Words
// only so names keep their room. The name only reaches the label through
// setAttribute, never HTML.
function drawNudgeButton(button, name, nudged) {
  button.disabled = nudged;
  button.classList.toggle("is-sent", nudged);
  button.innerHTML = nudged ? CHECK_SMALL_SVG + "Nudged" : "Nudge";
  button.setAttribute("aria-label", nudged ? `Nudged ${name}` : `Nudge ${name}`);
}

// A short message at the top of the screen (same look as challenges').
function showToast(text) {
  document.querySelectorAll(".challenge-toast").forEach((el) => el.remove());
  const el = document.createElement("div");
  el.className = "challenge-toast";
  el.setAttribute("role", "status");
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2300);
}

async function sendNudge(button, row, friendId, name) {
  button.disabled = true;
  const viewerId = currentUserId;
  const reply = await callServerFunction("nudge", { friendId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  if (viewerId !== currentUserId) return;
  if (reply.ok || reply.error === "already_nudged") {
    drawNudgeButton(button, name, true);
    button.classList.add("pop");
    if (reply.ok) showToast(`Nudge sent to ${name}`);
    return;
  }
  if (reply.error === "already_done") {
    // They trained in the meantime (or it's already tomorrow where they are).
    button.remove();
    const today = row.querySelector(".leaderboard-today");
    today.textContent = "Done today";
    today.classList.add("is-done");
    showToast(`${name} already trained today`);
    return;
  }
  button.disabled = false;
  showToast(reply.error === "not_friends" ? "You can only nudge friends" : "Couldn't send the nudge. Try again.");
}

// ---------- invite links ----------
// Your link is <this site>/?i=<code>. Only you can read your code
// (invite_codes); the `invite` function turns a code into a friendship.
// Whoever opens a link sees who sent it on the welcome screen, and once
// they're signed in (new account or not) they're friends.
let inviteCode = { userId: null, code: null };
let inviteFrom = null; // { name } of whoever's link brought this visitor

function pendingInvite() {
  try {
    const saved = JSON.parse(localStorage.getItem(INVITE_KEY) || "null");
    // A month is plenty of time to sign up; older links are let go.
    if (saved && /^[a-f0-9]{10}$/.test(saved.code) && Date.now() - saved.at < 30 * 86400000) return saved.code;
  } catch (e) {
    // unreadable - treat as none
  }
  return null;
}

function dropPendingInvite() {
  try {
    localStorage.removeItem(INVITE_KEY);
  } catch (e) {
    // storage blocked - nothing to drop
  }
}

// Who sent the link, for the welcome screen (no account needed).
async function peekInvite() {
  const code = pendingInvite();
  if (!code) return;
  const reply = await callServerFunction("invite", { action: "peek", code });
  if (!reply.ok) {
    if (reply.error === "unknown_code") dropPendingInvite();
    return;
  }
  rememberAvatarColors([{ username: reply.name, avatar_color: reply.color }]);
  inviteFrom = { name: reply.name };
  if (Onboarding.isActive()) Onboarding.refresh();
}

// Signed in with a link waiting: become friends with whoever sent it. Kept
// for later when there's no username yet or the network failed.
let acceptingInvite = false;
async function acceptPendingInvite() {
  const code = pendingInvite();
  const viewerId = currentUserId;
  if (!code || !viewerId || acceptingInvite) return;
  acceptingInvite = true;
  const reply = await callServerFunction("invite", { action: "accept", code });
  acceptingInvite = false;
  if (viewerId !== currentUserId) return;
  if (!reply.ok && ["no_username", "network", "server_error"].includes(reply.error)) return;
  dropPendingInvite();
  if (reply.ok && !reply.already) showToast(`You and ${reply.name} are friends now`);
}

// A brand new account remembers where it came from (a video's ?src=, an
// invite, or "direct"), for the numbers.
function recordSignupSource() {
  let source = null;
  try {
    source = localStorage.getItem(SOURCE_KEY);
    localStorage.removeItem(SOURCE_KEY);
  } catch (e) {
    // storage blocked
  }
  data.signupSource = source || "direct";
  if (inviteFrom) data.invitedBy = inviteFrom.name;
  saveData(data);
}

const inviteLinkFor = (code) => `${window.location.origin}${window.location.pathname.replace(/index\.html$/, "")}?i=${code}`;
const cachedInviteLink = () => (inviteCode.userId === currentUserId && inviteCode.code ? inviteLinkFor(inviteCode.code) : null);

// Fetched ahead (Me tab, sign-up's invite step): the share sheet must open
// right inside the tap on iPhone, with nothing slow before it.
async function loadInviteLink() {
  const viewerId = currentUserId;
  if (!viewerId) return null;
  if (cachedInviteLink()) return cachedInviteLink();
  const { data: row } = await supabaseClient.from("invite_codes").select("code").eq("user_id", viewerId).maybeSingle();
  if (viewerId !== currentUserId || !row) return null;
  inviteCode = { userId: viewerId, code: row.code };
  return inviteLinkFor(row.code);
}

function inviteText() {
  const streak = data ? currentStreak() : 0;
  return streak > 1
    ? `I'm on a ${streak}-day streak on Forja. Every rep is checked by the camera. Think you can keep up?`
    : "Join me on Forja. Every rep is checked by the camera, so every streak is real.";
}

// True once the link went somewhere (shared or copied).
async function shareInviteLink() {
  const url = cachedInviteLink() || (await loadInviteLink());
  if (!url) {
    showToast("Couldn't get your link. Try again.");
    return false;
  }
  if (navigator.share) {
    try {
      await navigator.share({ title: "Forja", text: inviteText(), url });
      return true;
    } catch (error) {
      if (error && error.name === "AbortError") return false; // closed the sheet
    }
  }
  try {
    await navigator.clipboard.writeText(`${inviteText()} ${url}`);
    showToast("Invite link copied");
    return true;
  } catch (error) {
    showToast("Couldn't share your link. Try again.");
    return false;
  }
}

document.getElementById("invite-share-button").addEventListener("click", shareInviteLink);
peekInvite();

// ---------- your time zone (names your league's area) ----------
// Sent only when it changes; "updated" needs a profile row to land in.
const TIME_ZONE_SENT_KEY = "forja-time-zone-sent";
async function syncTimeZone() {
  const viewerId = currentUserId;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!viewerId || !zone || zone.length > 64) return;
  let sent = {};
  try {
    sent = JSON.parse(localStorage.getItem(TIME_ZONE_SENT_KEY) || "{}");
  } catch (e) {
    sent = {};
  }
  if (sent[viewerId] === zone) return;
  const { data: rows, error } = await supabaseClient.from("profiles").update({ time_zone: zone }).eq("user_id", viewerId).select("user_id");
  if (error || !rows || rows.length === 0 || viewerId !== currentUserId) return;
  sent[viewerId] = zone;
  try {
    localStorage.setItem(TIME_ZONE_SENT_KEY, JSON.stringify(sent));
  } catch (e) {
    // storage blocked - it's just sent again next time
  }
}

// ---------- Settings: Show Me in Leagues ----------
const showInLeaguesEl = document.getElementById("show-in-leagues");
async function refreshLeaguesSetting() {
  const viewerId = currentUserId;
  let known = false;
  if (viewerId) {
    const { data: profile } = await supabaseClient.from("profiles").select("show_in_leagues").eq("user_id", viewerId).maybeSingle();
    known = viewerId === currentUserId && !!profile && typeof profile.show_in_leagues === "boolean";
    if (known) showInLeaguesEl.checked = profile.show_in_leagues;
  }
  document.getElementById("leagues-setting").classList.toggle("hidden", !known);
  document.getElementById("leagues-setting-note").classList.toggle("hidden", !known);
}

showInLeaguesEl.addEventListener("change", async () => {
  const want = showInLeaguesEl.checked;
  const { error } = await supabaseClient.from("profiles").update({ show_in_leagues: want }).eq("user_id", currentUserId);
  if (error) {
    showInLeaguesEl.checked = !want;
    showToast("Couldn't save. Try again.");
    return;
  }
  showSettingSaved();
});

// ---------- this week's league ----------
// Everyone who trained this week, friends or not, ranked by points the
// server counts from verified work (league_standings in the database):
// a closed ring = 100, a walk or run = 1 a minute (up to 60 a day). One
// Forja League while it's small; an area gets its own at 10+ people.
// Monday to Wednesday, last week's result shows above it.
const LEAGUE_SHOWN_ROWS = 15;
const MEDALS = ["Gold", "Silver", "Bronze"];
const MEDAL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="15" r="6"/><path d="M8.5 10 6 3h4l2 4 2-4h4l-2.5 7"/></svg>';
const TROPHY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>';
let leagueLoadNumber = 0;

const thisWeekStart = () => ForjaRules.weekOf(todayString());
const lastWeekStart = () => ForjaRules.addDays(thisWeekStart(), -7);
const daysIntoWeek = () => ForjaRules.daysBetween(thisWeekStart(), todayString()); // 0 = Monday

// null when it can't be read (offline, or the database part isn't there yet).
async function leagueStandings(weekStart) {
  const { data: rows, error } = await supabaseClient.rpc("league_standings", { week_start: weekStart });
  if (error || !Array.isArray(rows)) return null;
  rememberAvatarColors(rows);
  return rows;
}

function leagueTimeLeft() {
  const now = new Date();
  const nextMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (7 - daysIntoWeek()));
  const hours = Math.max(0, Math.floor((nextMonday - now) / 3600000));
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h left` : `${hours}h left`;
}

async function loadLeague() {
  const sectionEl = document.getElementById("league-section");
  const viewerId = currentUserId;
  const loadNumber = ++leagueLoadNumber;
  if (!viewerId) {
    sectionEl.classList.add("hidden");
    return;
  }
  const [rows, lastRows] = await Promise.all([leagueStandings(thisWeekStart()), daysIntoWeek() < 3 ? leagueStandings(lastWeekStart()) : null]);
  if (loadNumber !== leagueLoadNumber || viewerId !== currentUserId) return;
  if (!rows) {
    sectionEl.classList.add("hidden");
    return;
  }
  sectionEl.classList.remove("hidden");
  drawLeagueResult(lastRows);
  drawLeagueCard(rows);
  drawLeagueList(rows);
}

function drawLeagueResult(rows) {
  const el = document.getElementById("league-result");
  const me = rows && rows.find((r) => r.is_you);
  if (!me || me.points <= 0) {
    el.classList.add("hidden");
    return;
  }
  const medal = me.place <= 3 ? MEDALS[me.place - 1] : null;
  const winner = rows.find((r) => r.place === 1 && !r.is_you);
  el.className = `league-result${medal ? ` is-${medal.toLowerCase()}` : ""}`;
  el.innerHTML = `${medal ? MEDAL_ICON_SVG : TROPHY_ICON_SVG}<p><b class="league-result-title"></b><span class="league-result-sub"></span></p>`;
  el.querySelector(".league-result-title").textContent = medal ? `${medal}! #${me.place} in last week's league` : `#${me.place} of ${rows.length} in last week's league`;
  el.querySelector(".league-result-sub").textContent =
    `${me.points} points, ${me.days} ${me.days === 1 ? "day" : "days"}.` + (winner && me.place !== 1 ? ` ${winner.username} took first with ${winner.points}.` : "");
}

function drawLeagueCard(rows) {
  const me = rows.find((r) => r.is_you);
  const name = rows.length ? rows[0].league : "Forja League";
  let sub;
  if (!me) sub = "You're hidden from leagues. Change it in Settings.";
  else if (me.points === 0) sub = rows.length > 1 ? `${rows.length - 1} ${rows.length === 2 ? "person has" : "people have"} points. Train today to join them.` : "Train today to start the board.";
  else sub = `${rows.length} ${rows.length === 1 ? "person" : "people"} this week`;
  const el = document.getElementById("league-card");
  el.innerHTML = `<span class="league-badge">${TROPHY_ICON_SVG}</span><div class="league-card-text"><p class="league-card-name"></p><p class="league-card-sub"></p></div><span class="league-time-left"></span>`;
  el.querySelector(".league-card-name").textContent = name;
  el.querySelector(".league-card-sub").textContent = sub;
  el.querySelector(".league-time-left").textContent = leagueTimeLeft();
}

// Names arrive from other people, so they only ever go in as text.
function buildLeagueRow(row) {
  const el = document.createElement("div");
  el.className = "leaderboard-row league-row";
  if (row.is_you) el.classList.add("is-you");
  const medal = row.place <= 3 && row.points > 0 ? ` is-medal-${row.place}` : "";
  el.innerHTML = `
    <span class="leaderboard-rank${medal}">${Number(row.place) || ""}</span>
    ${avatarHtml(row.username)}
    <span class="leaderboard-who">
      <span class="leaderboard-name"></span>
      <span class="leaderboard-today ${row.is_friend ? "is-friend" : ""}"></span>
    </span>
    <span class="league-points">${Number(row.points) || 0}<small>pts</small></span>
    ${row.is_you ? '<span class="row-options-spacer" aria-hidden="true"></span>' : '<button class="row-options-button" aria-label="More options">&#8942;</button>'}
  `;
  el.querySelector(".leaderboard-name").textContent = row.username;
  const days = `${Number(row.days) || 0} ${row.days === 1 ? "day" : "days"}`;
  el.querySelector(".leaderboard-today").textContent = `${row.is_you ? "You" : row.is_friend ? "Friend" : row.region} · ${days}`;
  if (!row.is_you) el.querySelector(".row-options-button").addEventListener("click", () => openUserActions(row.user_id, row.username, "app-screen", null));
  return el;
}

function drawLeagueList(rows) {
  const listEl = document.getElementById("league-list");
  listEl.innerHTML = "";
  const shown = rows.slice(0, LEAGUE_SHOWN_ROWS);
  shown.forEach((row) => listEl.appendChild(buildLeagueRow(row)));
  const me = rows.find((r) => r.is_you);
  if (me && !shown.includes(me)) {
    const gap = document.createElement("p");
    gap.className = "league-gap";
    gap.textContent = `${rows.indexOf(me) - shown.length} more`;
    listEl.appendChild(gap);
    listEl.appendChild(buildLeagueRow(me));
  }
}

// ---------- your week (Monday to Wednesday on Today) ----------
// Last week in one card - days, totals, best set, league place - from the
// server's own records, with Share My Week (a story image like the route
// share). Hide puts it away until next Monday.
const RECAP_HIDDEN_KEY = "forja-recap-hidden";
const recapShare = { file: null };
let recapLoadNumber = 0;
const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const CHECK_SMALL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';

function recapHidden(viewerId, week) {
  try {
    return JSON.parse(localStorage.getItem(RECAP_HIDDEN_KEY) || "{}")[viewerId] === week;
  } catch (e) {
    return false;
  }
}

function hideRecap() {
  const recap = recapShare.recap;
  document.getElementById("week-recap").classList.add("hidden");
  if (!recap) return;
  try {
    const hidden = JSON.parse(localStorage.getItem(RECAP_HIDDEN_KEY) || "{}");
    hidden[recap.userId] = recap.week;
    localStorage.setItem(RECAP_HIDDEN_KEY, JSON.stringify(hidden));
  } catch (e) {
    // storage blocked - it comes back on the next open
  }
}

const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const plankWords = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const distanceWords = (km) => `${(data.units === "km" ? km : milesFromKm(km)).toFixed(1)} ${distanceUnitLabel()}`;

async function loadWeekRecap() {
  const el = document.getElementById("week-recap");
  const viewerId = currentUserId;
  const loadNumber = ++recapLoadNumber;
  const week = lastWeekStart();
  if (!viewerId || daysIntoWeek() >= 3 || recapHidden(viewerId, week)) {
    el.classList.add("hidden");
    return;
  }
  const end = ForjaRules.addDays(week, 6);
  const [postsReply, setsReply, league] = await Promise.all([
    supabaseClient.from("feed_events").select("kind, day, pushups, plank_seconds, squats, distance_m").eq("user_id", viewerId).gte("day", week).lte("day", end),
    supabaseClient.from("verified_sets").select("exercise, value, day").eq("user_id", viewerId).gte("day", week).lte("day", end),
    leagueStandings(week),
  ]);
  if (loadNumber !== recapLoadNumber || viewerId !== currentUserId) return;
  const posts = postsReply.data || [];
  if (postsReply.error) return;
  const dayPosts = posts.filter((p) => p.kind === "day");
  const moves = posts.filter((p) => p.kind === "walk" || p.kind === "run");
  const trained = new Set(dayPosts.map((p) => p.day));
  if (trained.size === 0 && moves.length === 0) {
    el.classList.add("hidden");
    return;
  }
  const rested = restDaySet();
  const sum = (list, key) => list.reduce((total, p) => total + (Number(p[key]) || 0), 0);
  // The best single set, push-ups first (the one most people compare).
  const sets = setsReply.data || [];
  const best = ["pushup", "squat", "plank"]
    .map((exercise) => sets.filter((s) => s.exercise === exercise).sort((a, b) => b.value - a.value)[0])
    .find(Boolean);
  const me = league && league.find((r) => r.is_you && r.points > 0);
  const recap = {
    userId: viewerId,
    week,
    end,
    days: Array.from({ length: 7 }, (_, i) => {
      const day = ForjaRules.addDays(week, i);
      return trained.has(day) ? "on" : rested.has(day) ? "rest" : "";
    }),
    trainedCount: trained.size,
    restCount: Array.from({ length: 7 }, (_, i) => ForjaRules.addDays(week, i)).filter((day) => !trained.has(day) && rested.has(day)).length,
    pushups: sum(dayPosts, "pushups"),
    squats: sum(dayPosts, "squats"),
    plank: sum(dayPosts, "plank_seconds"),
    km: sum(moves, "distance_m") / 1000,
    best,
    place: me ? me.place : 0,
    of: league ? league.length : 0,
  };
  recapShare.recap = recap;
  drawWeekRecap(recap);
  renderRecapImage(recap);
}

function bestSetWords(best) {
  if (!best) return "";
  const what = best.exercise === "plank" ? `${plankWords(best.value)} plank` : `${best.value} ${best.exercise === "pushup" ? "push-ups" : "squats"}`;
  const weekday = new Date(`${best.day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
  return `${what} (${weekday})`;
}

function drawWeekRecap(recap) {
  const el = document.getElementById("week-recap");
  const days = `${recap.trainedCount} ${recap.trainedCount === 1 ? "day" : "days"}`;
  const rest = recap.restCount ? ` · ${recap.restCount} rest ${recap.restCount === 1 ? "day" : "days"}` : "";
  const highlights = [recap.best ? `Best set: <b>${bestSetWords(recap.best)}</b>` : "", recap.place ? `<b>#${recap.place}</b> in your league` : ""].filter(Boolean).join(" · ");
  el.innerHTML = `
    <div class="week-recap-top"><h2 id="week-recap-title">Your Week</h2><span>${dayLabel(recap.week)} – ${dayLabel(recap.end)}</span></div>
    <ol class="week-recap-days" aria-label="Days trained last week">
      ${recap.days.map((state, i) => `<li><span class="week-recap-dot ${state ? `is-${state}` : ""}" aria-label="${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]}: ${state === "on" ? "trained" : state === "rest" ? "rest day" : "missed"}">${state === "on" ? CHECK_SMALL_SVG : state === "rest" ? MOON_SVG : ""}</span><span aria-hidden="true">${DAY_LETTERS[i]}</span></li>`).join("")}
    </ol>
    <p class="week-recap-count"><b>${days}</b> trained${rest} · streak <b>${currentStreak()}</b></p>
    <div class="week-recap-stats">
      <div><b>${recap.pushups}</b><span><i style="--dot: var(--ring-pushups)"></i>push-ups</span></div>
      <div><b>${recap.squats}</b><span><i style="--dot: var(--ring-squats)"></i>squats</span></div>
      <div><b>${plankWords(recap.plank)}</b><span><i style="--dot: var(--ring-planks)"></i>plank</span></div>
      <div><b>${(data.units === "km" ? recap.km : milesFromKm(recap.km)).toFixed(1)}</b><span><i style="--dot: var(--ring-walkrun)"></i>${distanceUnitLabel()} walked</span></div>
    </div>
    ${highlights ? `<p class="week-recap-best">${highlights}</p>` : ""}
    <div class="week-recap-actions">
      <button class="week-recap-hide" data-recap="hide">Hide</button>
      <button class="week-recap-share" data-recap="share" disabled>${SHARE_ICON_SVG}Share My Week</button>
    </div>`;
  el.classList.remove("hidden");
}

// The story image (1080 x 1920, dark), made ahead of the tap like the
// route share.
function drawRecapImage(ctx, recap, logo) {
  const W = 1080;
  const font = (size, weight) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const background = ctx.createLinearGradient(0, 0, 0, 1920);
  background.addColorStop(0, "#0f1f15");
  background.addColorStop(0.55, "#0b0b0d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, 1920);
  if (logo) ctx.drawImage(logo, 90, 130, 300, 90);
  else {
    ctx.fillStyle = "#ffffff";
    ctx.font = font(64, 800);
    ctx.fillText("Forja", 90, 200);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#9a9a96";
  ctx.font = font(44, 700);
  ctx.fillText(`MY WEEK · ${dayLabel(recap.week).toUpperCase()} – ${dayLabel(recap.end).toUpperCase()}`, 90, 330);
  ctx.fillStyle = "#ffffff";
  ctx.font = font(150, 900);
  ctx.fillText(`${recap.trainedCount} ${recap.trainedCount === 1 ? "day." : "days."}`, 84, 500);
  ctx.font = font(84, 800);
  ctx.fillText("Every rep verified.", 90, 610);
  // The 7 days.
  recap.days.forEach((state, i) => {
    const x = 90 + 60 + i * 135;
    ctx.beginPath();
    ctx.arc(x, 760, 54, 0, Math.PI * 2);
    ctx.fillStyle = state === "on" ? "#22c55e" : state === "rest" ? "#247644" : "#27272a";
    ctx.fill();
    ctx.fillStyle = "#8e8e93";
    ctx.font = font(40, 700);
    ctx.textAlign = "center";
    ctx.fillText(DAY_LETTERS[i], x, 870);
  });
  // The numbers.
  const lines = [
    ["Push-ups", String(recap.pushups)],
    ["Squats", String(recap.squats)],
    ["Plank", plankWords(recap.plank)],
    ["Walked", distanceWords(recap.km)],
    ["Streak", `${currentStreak()} days`],
  ];
  if (recap.place) lines.push(["League", `#${recap.place} of ${recap.of}`]);
  lines.forEach(([label, value], i) => {
    const y = 1010 + i * 120;
    ctx.textAlign = "left";
    ctx.fillStyle = "#9a9a96";
    ctx.font = font(52, 600);
    ctx.fillText(label, 90, y);
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffffff";
    ctx.font = font(68, 800);
    ctx.fillText(value, W - 90, y);
    ctx.fillStyle = "#ffffff14";
    ctx.fillRect(90, y + 36, W - 180, 3);
  });
  ctx.textAlign = "center";
  ctx.fillStyle = "#8e8e93";
  ctx.font = font(46, 600);
  ctx.fillText("Can you keep up?", W / 2, 1780);
  const link = cachedInviteLink();
  if (link) {
    ctx.fillStyle = "#22c55e";
    ctx.font = font(42, 700);
    ctx.fillText(link.replace(/^https?:\/\//, ""), W / 2, 1840);
  }
}

async function renderRecapImage(recap) {
  recapShare.file = null;
  await loadInviteLink(); // the link goes on the image
  if (recapShare.recap !== recap) return;
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext("2d");
  const logo = await shareLogoImage("#ffffff");
  drawRecapImage(ctx, recap, logo);
  let blob = await canvasToPng(canvas).catch(() => null);
  if (!blob) {
    drawRecapImage(ctx, recap, null);
    blob = await canvasToPng(canvas).catch(() => null);
  }
  if (recapShare.recap !== recap || !blob) return;
  recapShare.file = new File([blob], "forja-my-week.png", { type: "image/png" });
  const button = document.querySelector("#week-recap [data-recap=share]");
  if (button) button.disabled = false;
}

async function shareImageFile(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      // Closing the share sheet lands here too - nothing to do.
    }
    return;
  }
  // No share sheet (most computers): save the image instead.
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById("week-recap").addEventListener("click", (event) => {
  const button = event.target.closest("[data-recap]");
  if (!button) return;
  if (button.dataset.recap === "hide") hideRecap();
  else if (recapShare.file) shareImageFile(recapShare.file);
});

function buildFriendRequestRow(friendshipId, requesterName, requesterId) {
  const row = document.createElement("div");
  row.className = "leaderboard-row";

  row.innerHTML = `
    ${avatarHtml(requesterName)}
    <span class="leaderboard-name"></span>
    <span class="friend-request-actions">
      <button class="accept-request-button">Accept</button>
      <button class="decline-request-button">Decline</button>
    </span>
    <button class="row-options-button" aria-label="More options">&#8942;</button>
  `;
  row.querySelector(".leaderboard-name").textContent = requesterName;
  row.querySelector(".accept-request-button").addEventListener("click", () => respondToRequest(friendshipId, true));
  row.querySelector(".decline-request-button").addEventListener("click", () => respondToRequest(friendshipId, false));
  row.querySelector(".row-options-button").addEventListener("click", () => openUserActions(requesterId, requesterName, "app-screen", null));

  return row;
}

// Called whenever the Competition tab is opened - figures out which of
// the 3 states to show (guest / needs a username / ready to see friends).
async function enterCompetitionTab() {
  const guestPromptEl = document.getElementById("competition-guest-prompt");
  const usernameSetupEl = document.getElementById("username-setup-section");
  const friendsSectionEl = document.getElementById("friends-section");

  guestPromptEl.classList.add("hidden");
  usernameSetupEl.classList.add("hidden");
  friendsSectionEl.classList.add("hidden");

  if (!currentUserId) {
    guestPromptEl.classList.remove("hidden");
    return;
  }

  if (!myUsername || !avatarColorByName.has(myUsername)) {
    const viewerId = currentUserId;
    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("username, avatar_color")
      .eq("user_id", viewerId)
      .maybeSingle();
    if (viewerId !== currentUserId) return; // switched accounts meanwhile

    if (profile) {
      myUsername = profile.username;
      rememberAvatarColors([profile]);
    }
  }

  if (!myUsername) {
    usernameSetupEl.classList.remove("hidden");
    return;
  }

  friendsSectionEl.classList.remove("hidden");
  loadFriendRequests();
  loadLeaderboard();
  loadLeague();
  acceptPendingInvite(); // a username was just picked here, maybe
  if (typeof Challenges !== "undefined") Challenges.refresh();
}

document.getElementById("save-username-button").addEventListener("click", async () => {
  const usernameInput = document.getElementById("set-username-input");
  const errorEl = document.getElementById("username-error");
  const username = usernameInput.value.trim();

  errorEl.textContent = "";

  if (!USERNAME_PATTERN.test(username)) {
    errorEl.textContent = "Username must be 3-20 characters: letters, numbers, underscores only.";
    return;
  }

  const { error } = await supabaseClient.from("profiles").insert({ user_id: currentUserId, username });

  if (error) {
    errorEl.textContent = error.code === "23505" ? "That username is already taken." : "Something went wrong. Try again.";
    return;
  }

  myUsername = username;
  document.getElementById("username-setup-section").classList.add("hidden");
  document.getElementById("friends-section").classList.remove("hidden");
  loadFriendRequests();
  loadLeaderboard();
});

// Live search, like looking someone up in any other social app - type a
// few letters and matching usernames appear below, each with its own
// Add button that flips to "Requested" the moment the request is sent,
// instead of typing an exact username blind and hoping it matches.

let friendSearchDebounceTimer = null;

// "Requested" is a real button, not a dead-end label - tapping it cancels
// the request and swaps back to Add, so sending one by accident is a
// one-tap undo instead of something only fixable from Friend Requests.
function createAddButton(userId) {
  const addButton = document.createElement("button");
  addButton.className = "friend-search-action-button friend-search-add-button";
  addButton.textContent = "Add";
  addButton.addEventListener("click", async () => {
    addButton.disabled = true;
    const { data: inserted, error } = await supabaseClient
      .from("friendships")
      .insert({ requester_id: currentUserId, addressee_id: userId, status: "pending" })
      .select("id")
      .single();

    if (error) {
      addButton.disabled = false;
      document.getElementById("friend-add-error").textContent = "Couldn't send the request. Try again.";
      return;
    }

    addButton.replaceWith(createRequestedButton(userId, inserted.id));
  });
  return addButton;
}

function createRequestedButton(userId, friendshipId) {
  const button = document.createElement("button");
  button.className = "friend-search-action-button friend-search-requested-button";
  button.textContent = "Requested";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const { error } = await supabaseClient.from("friendships").delete().eq("id", friendshipId);

    if (error) {
      button.disabled = false;
      document.getElementById("friend-add-error").textContent = "Couldn't cancel the request. Try again.";
      return;
    }

    button.replaceWith(createAddButton(userId));
  });
  return button;
}

function buildFriendSearchRow(userId, username, statusInfo) {
  const row = document.createElement("div");
  row.className = "leaderboard-row";

  row.innerHTML = `
    ${avatarHtml(username)}
    <span class="leaderboard-name"></span>
  `;
  row.querySelector(".leaderboard-name").textContent = username;

  if (statusInfo.type === "friends" || statusInfo.type === "pending-received") {
    const label = document.createElement("span");
    label.className = "friend-status-label";
    label.textContent = statusInfo.type === "friends" ? "Friends" : "Pending";
    row.appendChild(label);
  } else if (statusInfo.type === "pending-sent") {
    row.appendChild(createRequestedButton(userId, statusInfo.friendshipId));
  } else {
    row.appendChild(createAddButton(userId));
  }

  return row;
}

async function runFriendSearch(query) {
  const resultsEl = document.getElementById("friend-search-results");
  const errorEl = document.getElementById("friend-add-error");
  errorEl.textContent = "";

  const { data: matches } = await supabaseClient
    .from("profiles")
    .select("user_id, username, avatar_color")
    .ilike("username", `${query}%`)
    .neq("user_id", currentUserId)
    .limit(8);
  rememberAvatarColors(matches);

  resultsEl.innerHTML = "";
  resultsEl.classList.remove("hidden");

  if (!matches || matches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "preview-note";
    empty.textContent = "No users found.";
    resultsEl.appendChild(empty);
    return;
  }

  const matchIds = matches.map((m) => m.user_id);
  const { data: relations } = await supabaseClient
    .from("friendships")
    .select("id, requester_id, addressee_id, status")
    .or(
      `and(requester_id.eq.${currentUserId},addressee_id.in.(${matchIds.join(",")})),and(addressee_id.eq.${currentUserId},requester_id.in.(${matchIds.join(",")}))`
    );

  const statusByUserId = {};
  (relations || []).forEach((rel) => {
    const otherId = rel.requester_id === currentUserId ? rel.addressee_id : rel.requester_id;
    if (rel.status === "accepted") {
      statusByUserId[otherId] = { type: "friends" };
    } else if (rel.requester_id === currentUserId) {
      statusByUserId[otherId] = { type: "pending-sent", friendshipId: rel.id };
    } else {
      statusByUserId[otherId] = { type: "pending-received" };
    }
  });

  matches.forEach((match) => {
    resultsEl.appendChild(
      buildFriendSearchRow(match.user_id, match.username, statusByUserId[match.user_id] || { type: "none" })
    );
  });
}

document.getElementById("friend-username-input").addEventListener("input", () => {
  clearTimeout(friendSearchDebounceTimer);
  const query = document.getElementById("friend-username-input").value.trim();
  const resultsEl = document.getElementById("friend-search-results");

  if (query.length < 2) {
    resultsEl.classList.add("hidden");
    resultsEl.innerHTML = "";
    return;
  }

  friendSearchDebounceTimer = setTimeout(() => runFriendSearch(query), 300);
});

// The on-screen keyboard's "Search" key runs the search immediately
// instead of waiting out the debounce delay.
document.getElementById("friend-username-input").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  clearTimeout(friendSearchDebounceTimer);
  const query = document.getElementById("friend-username-input").value.trim();
  if (query.length >= 2) runFriendSearch(query);
});

async function loadFriendRequests() {
  const sectionEl = document.getElementById("friend-requests-section");
  const listEl = document.getElementById("friend-requests-list");

  const { data: requests } = await supabaseClient
    .from("friendships")
    .select("id, requester_id")
    .eq("addressee_id", currentUserId)
    .eq("status", "pending");

  updateFriendRequestBadge();

  if (!requests || requests.length === 0) {
    sectionEl.classList.add("hidden");
    return;
  }

  const requesterIds = requests.map((r) => r.requester_id);
  const { data: profiles } = await supabaseClient.from("profiles").select("user_id, username, avatar_color").in("user_id", requesterIds);
  rememberAvatarColors(profiles);

  const usernameByUserId = {};
  (profiles || []).forEach((p) => {
    usernameByUserId[p.user_id] = p.username;
  });

  listEl.innerHTML = "";
  requests.forEach((request) => {
    const name = usernameByUserId[request.requester_id] || "Unknown";
    listEl.appendChild(buildFriendRequestRow(request.id, name, request.requester_id));
  });

  sectionEl.classList.remove("hidden");
}

async function respondToRequest(friendshipId, accept) {
  if (accept) {
    await supabaseClient.from("friendships").update({ status: "accepted" }).eq("id", friendshipId);
  } else {
    await supabaseClient.from("friendships").delete().eq("id", friendshipId);
  }
  loadFriendRequests();
  loadLeaderboard();
}

async function loadLeaderboard() {
  const leaderboardEl = document.getElementById("leaderboard");

  const { data: friendships } = await supabaseClient
    .from("friendships")
    .select("requester_id, addressee_id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${currentUserId},addressee_id.eq.${currentUserId}`);

  const friendIds = (friendships || []).map((f) => (f.requester_id === currentUserId ? f.addressee_id : f.requester_id));

  const today = todayString();
  const combined = [{ name: myUsername, streak: currentStreak(), isYou: true, userId: currentUserId, doneToday: data.lastLoggedDate === today, nudged: false }];

  if (friendIds.length > 0) {
    // Streaks come from player_stats, which only the server can write.
    // (They used to be read out of each friend's user_progress, which the
    // friend could edit - and which also exposed their GPS routes.)
    // Nudges: the ones you sent since your midnight (the server keeps the
    // real once-a-day count, by their date).
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const [{ data: profiles }, { data: statsRows }, { data: nudgeRows }] = await Promise.all([
      supabaseClient.from("profiles").select("user_id, username, avatar_color").in("user_id", friendIds),
      supabaseClient.from("player_stats").select("user_id, streak, last_logged_date, rest_days_used, week_start_date").in("user_id", friendIds),
      supabaseClient.from("nudges").select("receiver_id").eq("sender_id", currentUserId).gte("created_at", midnight.toISOString()),
    ]);
    rememberAvatarColors(profiles);

    const usernameByUserId = {};
    (profiles || []).forEach((p) => {
      usernameByUserId[p.user_id] = p.username;
    });
    // A friend's streak is 0 once it ran out of rest days, judged by your
    // date. (Their time zone stays private: profiles.time_zone isn't
    // readable by other players - see security-cleanup-2026-10-17.sql.)
    const friendStreak = (stats) =>
      stats ? ForjaRules.shownStreak({ streak: stats.streak, lastLoggedDate: stats.last_logged_date, restDaysUsed: stats.rest_days_used, weekStartDate: stats.week_start_date }, today) : 0;
    const statsByUserId = {};
    (statsRows || []).forEach((row) => {
      statsByUserId[row.user_id] = row;
    });
    const nudgedIds = new Set((nudgeRows || []).map((n) => n.receiver_id));

    // Everyone who's a friend appears, even with no logged day yet (0).
    // "Done today" by your date; a friend ahead of you in time counts too.
    friendIds.forEach((id) => {
      const stats = statsByUserId[id];
      combined.push({
        name: usernameByUserId[id] || "Unknown",
        streak: friendStreak(stats),
        isYou: false,
        userId: id,
        doneToday: !!(stats && stats.last_logged_date && stats.last_logged_date >= today),
        nudged: nudgedIds.has(id),
      });
    });
  }

  combined.sort((a, b) => b.streak - a.streak);

  leaderboardEl.innerHTML = "";
  combined.forEach((person, index) => {
    leaderboardEl.appendChild(buildLeaderboardRow(person, index + 1));
  });
}

// The Feed: every day you or a friend logs shows up as a post, and friends
// can give each other kudos. Posts are written by the server when it logs
// a day (log-day), so everything here is camera-verified - the app only
// reads posts, and adds or removes its own kudos.

const FEED_DAYS_SHOWN = 14;
const FEED_MAX_POSTS = 50;
const STREAK_MILESTONES = [7, 14, 30, 50, 100, 150, 200, 365, 500, 1000];
// A heart, outlined until you like the post, then filled (style.css).
const KUDOS_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.5s-8.5-5.1-8.5-11A4.7 4.7 0 0 1 8.2 4.8c1.6 0 2.9.8 3.8 2.1.9-1.3 2.2-2.1 3.8-2.1a4.7 4.7 0 0 1 4.7 4.7c0 5.9-8.5 11-8.5 11z"/></svg>';

const feedListEl = document.getElementById("feed-list");
const feedMessageEl = document.getElementById("feed-message");
const feedMessageTextEl = document.getElementById("feed-message-text");
const feedMessageButtonEl = document.getElementById("feed-message-button");
let feedMessageAction = null;

// Each load gets a number, and only the newest one is allowed to draw - so
// tapping the tab twice quickly can't let a slower, older load win.
// (See stillCurrent() in loadFeed.)
let feedLoadNumber = 0;

feedMessageButtonEl.addEventListener("click", () => {
  if (feedMessageAction) feedMessageAction();
});

// The note above the posts (empty feed, errors, guests). Pass no text to hide it.
function showFeedMessage(text, buttonLabel, action) {
  feedMessageEl.classList.toggle("hidden", !text);
  feedMessageTextEl.textContent = text || "";
  feedMessageButtonEl.classList.toggle("hidden", !buttonLabel);
  feedMessageButtonEl.textContent = buttonLabel || "";
  feedMessageAction = action || null;
}

async function enterFeedTab() {
  if (!currentUserId) {
    feedListEl.innerHTML = "";
    showFeedMessage("Create an account to see your friends' workouts and like them.", "Create Account", () => {
      authMode = "signup";
      applyAuthMode();
      showAuthScreen();
    });
    return;
  }
  // Opening the Feed is what "seen" means: the dot goes, and the newest
  // post's time is remembered.
  document.getElementById("feed-tab-badge").classList.add("hidden");
  // First visit: say something while it loads. Later visits keep showing
  // the last posts while the fresh ones arrive.
  if (!feedListEl.hasChildNodes()) showFeedMessage("Loading...");
  try {
    await loadFeed();
  } finally {
    updateFeedBadge(); // even if the Feed didn't load, it was opened
  }
}

async function loadFeed() {
  const thisLoad = ++feedLoadNumber;
  const viewerId = currentUserId;
  // False once a newer load has started, or the person logged out meanwhile.
  const stillCurrent = () => thisLoad === feedLoadNumber && viewerId === currentUserId;
  const loadFailed = () => {
    if (!stillCurrent()) return;
    showFeedMessage("Couldn't load the Feed. Check your connection.", "Try Again", () => enterFeedTab());
  };

  const { data: friendships, error: friendsError } = await supabaseClient
    .from("friendships")
    .select("requester_id, addressee_id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${currentUserId},addressee_id.eq.${currentUserId}`);
  if (friendsError) return loadFailed();
  const feedFriendIds = (friendships || []).map((f) => (f.requester_id === currentUserId ? f.addressee_id : f.requester_id));

  // The database only ever hands back your own and your friends' posts;
  // asking for exactly those just keeps the request small.
  const oldestDay = new Date();
  oldestDay.setDate(oldestDay.getDate() - (FEED_DAYS_SHOWN - 1));
  const { data: postRows, error: postsError } = await supabaseClient
    .from("feed_events")
    // Every column, so the Feed keeps working whether or not the newer
    // post kinds (like challenge wins) have their columns yet.
    .select("*")
    .in("user_id", [currentUserId, ...feedFriendIds])
    .gte("day", dateToString(oldestDay))
    .order("created_at", { ascending: false })
    .limit(FEED_MAX_POSTS);
  if (postsError) return loadFailed();
  const posts = postRows || [];

  let kudosRows = [];
  if (posts.length > 0) {
    const { data: rows, error: kudosError } = await supabaseClient
      .from("kudos")
      .select("event_id, giver_id")
      .in("event_id", posts.map((p) => p.id));
    if (kudosError) return loadFailed();
    kudosRows = rows || [];
  }

  const peopleIds = [...new Set([...posts.map((p) => p.user_id), ...kudosRows.map((k) => k.giver_id)])];
  const usernameByUserId = {};
  if (peopleIds.length > 0) {
    const { data: profiles } = await supabaseClient.from("profiles").select("user_id, username, avatar_color").in("user_id", peopleIds);
    rememberAvatarColors(profiles);
    (profiles || []).forEach((p) => {
      usernameByUserId[p.user_id] = p.username;
    });
  }

  if (!stillCurrent()) return;

  feedListEl.innerHTML = "";
  if (posts.length === 0) {
    if (feedFriendIds.length === 0) {
      showFeedMessage("Your friends' workouts show up here. Add some friends to get started.", "Find Friends", () => showTab("competition"));
    } else {
      showFeedMessage(`Nothing in the last ${FEED_DAYS_SHOWN} days yet. When you or a friend logs a workout, it shows up here.`);
    }
    return;
  }

  showFeedMessage(null);
  // Grouped by day (newest first; within a day, newest post first), with a
  // heading where each day starts.
  const byDay = [...posts].sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? 1 : -1));
  let lastDay = null;
  byDay.forEach((post) => {
    if (post.day !== lastDay) {
      feedListEl.appendChild(buildFeedDayHeading(post.day));
      lastDay = post.day;
    }
    const giverIds = kudosRows.filter((k) => k.event_id === post.id).map((k) => k.giver_id);
    feedListEl.appendChild(buildFeedCard(post, giverIds, usernameByUserId));
  });
}

// A day's heading: "Today" / "Yesterday" / "Monday" this past week, else
// "Sat, Oct 3" - plus the date in small grey text next to the first three.
function feedDayHeading(day) {
  const [year, month, date] = day.split("-").map(Number);
  const when = new Date(year, month - 1, date);
  const daysAgo = daysBetween(day, todayString());
  const short = when.toLocaleDateString([], { month: "short", day: "numeric" });
  if (daysAgo === 0) return { title: "Today", note: when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) };
  if (daysAgo === 1) return { title: "Yesterday", note: when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) };
  if (daysAgo > 1 && daysAgo < 7) return { title: when.toLocaleDateString([], { weekday: "long" }), note: short };
  return { title: when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }), note: "" };
}

function buildFeedDayHeading(day) {
  const { title, note } = feedDayHeading(day);
  const heading = document.createElement("h2");
  heading.className = "feed-day";
  heading.textContent = title;
  if (note) {
    const small = document.createElement("small");
    small.textContent = note;
    heading.appendChild(small);
  }
  return heading;
}

const isActivityPost = (post) => post.kind === "walk" || post.kind === "run";
const isChallengePost = (post) => post.kind === "challenge";
const challengePostName = (post) => ForjaRules.challengeName({ type: post.challenge_type, exercise: post.challenge_exercise });

function feedHeadline(post) {
  if (post.kind === "run") return "Went for a run";
  if (post.kind === "walk") return "Went for a walk";
  if (isChallengePost(post)) {
    const name = challengePostName(post);
    return name === "Last One Standing" ? "Won Last One Standing" : `Won the ${name}`;
  }
  const streak = Number(post.streak) || 0;
  if (STREAK_MILESTONES.includes(streak)) return `Hit a ${streak}-day streak`;
  if (post.new_best) return `New personal best: ${streak} days`;
  if (streak === 1) return "Started a new streak";
  return `Day ${streak} of the streak`;
}

// "You and ana liked this", "ana, ben and 3 others liked this".
function kudosSummaryText(names) {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} liked this`;
  if (names.length === 2) return `${names[0]} and ${names[1]} liked this`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} liked this`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others liked this`;
}

// The numbers row of a post. A full day shows the three exercises (plus
// cardio when the day had walks/runs); a walk or run shows distance, moving
// time and pace, in the viewer's own units.
function feedStats(post) {
  if (isChallengePost(post)) {
    const value = Number(post.challenge_value) || 0;
    const days = { value: Number(post.challenge_days) || 0, label: "days" };
    const beaten = { value: Number(post.challenge_beaten) || 0, label: "friends beaten" };
    if (post.challenge_type === "dist") return [{ value: displayDistance(value / 1000), label: distanceUnitLabel() }, days, beaten];
    if (post.challenge_type === "rep") {
      const exercise = post.challenge_exercise;
      const total = exercise === "planks" ? { value: formatDuration(value * 1000), label: "plank" } : { value, label: exercise === "squats" ? "squats" : "push-ups" };
      return [total, days, beaten];
    }
    // Last One Standing and Climb: how many days the winner lasted.
    return [{ value, label: "days lasted" }, beaten];
  }
  if (isActivityPost(post)) {
    const km = (Number(post.distance_m) || 0) / 1000;
    const ms = (Number(post.duration_s) || 0) * 1000;
    const inUnits = data.units === "km" ? km : milesFromKm(km);
    return [
      { value: displayDistance(km), label: distanceUnitLabel() },
      { value: formatDuration(ms), label: "time" },
      { value: inUnits > 0.01 ? formatDuration(ms / inUnits) : "--", label: `pace /${distanceUnitLabel()}` },
    ];
  }
  const stats = [
    { value: Number(post.pushups) || 0, label: "push-ups" },
    { value: Number(post.squats) || 0, label: "squats" },
    { value: formatDuration((Number(post.plank_seconds) || 0) * 1000), label: "plank" },
  ];
  if (Number(post.cardio_minutes) > 0) stats.push({ value: `${Number(post.cardio_minutes)}`, label: "cardio min" });
  return stats;
}

const FEED_KIND_LABELS = { day: "Full day", walk: "Walk", run: "Run", challenge: "Challenge won" };

// Usernames come from other people, so - like the leaderboard - every bit of
// text goes in through textContent, and only fixed markup goes in innerHTML.
function buildFeedCard(post, giverIds, usernameByUserId) {
  const isMine = post.user_id === currentUserId;
  const card = document.createElement("article");
  card.className = "feed-card";
  if (isMine) card.classList.add("is-you");

  const username = isMine ? myUsername : usernameByUserId[post.user_id];
  card.innerHTML = `
    <div class="feed-card-header">
      ${avatarHtml(username)}
      <div class="feed-card-who">
        <span class="feed-card-name"></span>
      </div>
      ${isActivityPost(post) || isChallengePost(post) ? "" : `<span class="leaderboard-streak">${Number(post.streak) || 0} ${STREAK_RING_SVG}</span>`}
      <span class="feed-card-time"></span>
    </div>
    <div>
      <span class="feed-card-kind"></span>
      <p class="feed-card-headline"></p>
    </div>
    <div class="feed-card-stats"></div>
    <div class="feed-card-footer">
      ${isMine ? "" : `<button class="kudos-button" aria-pressed="false" aria-label="Like">${KUDOS_ICON_SVG}</button>`}
      <span class="kudos-summary"></span>
    </div>
  `;
  card.querySelector(".feed-card-name").textContent = isMine ? "You" : usernameByUserId[post.user_id] || "Unknown";
  card.querySelector(".feed-card-time").textContent = new Date(post.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  card.querySelector(".feed-card-headline").textContent = feedHeadline(post);
  const kind = FEED_KIND_LABELS[post.kind] ? post.kind : "day";
  const kindEl = card.querySelector(".feed-card-kind");
  kindEl.textContent = FEED_KIND_LABELS[kind];
  kindEl.classList.add(`is-${kind}`);
  const statsEl = card.querySelector(".feed-card-stats");
  const stats = feedStats(post);
  statsEl.style.gridTemplateColumns = `repeat(${stats.length}, 1fr)`;
  stats.forEach((stat) => {
    const cell = document.createElement("div");
    cell.className = "feed-stat";
    const value = document.createElement("span");
    value.className = "feed-stat-value";
    value.textContent = stat.value;
    const label = document.createElement("span");
    label.className = "feed-stat-label";
    label.textContent = stat.label;
    cell.append(value, label);
    statsEl.appendChild(cell);
  });
  if (isActivityPost(post) && post.route) {
    const shape = routeShapeSvg(post.route);
    if (shape) {
      statsEl.after(shape);
      showRouteMap(post, shape);
    }
  }

  // Everyone who gave kudos, with you first.
  const kudos = { iGave: giverIds.includes(currentUserId), others: giverIds.filter((id) => id !== currentUserId), busy: false };
  const button = card.querySelector(".kudos-button");
  const summaryEl = card.querySelector(".kudos-summary");

  const drawKudos = () => {
    const names = [...(kudos.iGave ? ["You"] : []), ...kudos.others.map((id) => usernameByUserId[id] || "Someone")];
    summaryEl.textContent = kudosSummaryText(names);
    // Your own post has no button, so with no kudos yet the row would be empty.
    summaryEl.parentElement.classList.toggle("hidden", !button && names.length === 0);
    if (button) {
      button.classList.toggle("is-given", kudos.iGave);
      button.setAttribute("aria-pressed", String(kudos.iGave));
    }
  };
  drawKudos();

  if (button) button.addEventListener("click", () => toggleKudos(post.id, kudos, drawKudos, button));
  return card;
}

// Shows the change straight away, then undoes it if the server says no.
async function toggleKudos(postId, kudos, drawKudos, button) {
  if (kudos.busy) return;
  kudos.busy = true;
  const giving = !kudos.iGave;
  kudos.iGave = giving;
  drawKudos();
  if (giving) {
    button.classList.remove("pop");
    void button.offsetWidth;
    button.classList.add("pop");
  }

  const { error } = giving
    ? await supabaseClient.from("kudos").insert({ event_id: postId, giver_id: currentUserId })
    : await supabaseClient.from("kudos").delete().eq("event_id", postId).eq("giver_id", currentUserId);

  // 23505 = already there (given from another device) - that's the goal anyway.
  if (error && error.code !== "23505") {
    kudos.iGave = !giving;
    drawKudos();
  }
  kudos.busy = false;
}

// The Me tab's profile header (avatar, username, friend count). Friendship
// is mutual - accepting a request makes both people each other's friend,
// not an asymmetric follow - so there's a single "Friends" stat rather
// than separate Followers/Following counts that would always be identical.

let friendIds = [];

async function enterMeTab() {
  const headerEl = document.getElementById("profile-header");
  const promptEl = document.getElementById("profile-header-prompt");
  if (typeof Challenges !== "undefined") Challenges.showTrophies();

  const inviteRowEl = document.getElementById("invite-row");
  if (!currentUserId) {
    headerEl.classList.add("hidden");
    promptEl.classList.add("hidden");
    inviteRowEl.classList.add("hidden");
    return;
  }

  const viewerId = currentUserId;
  // Draw what this phone already knows, then always ask the server: the
  // color may have been changed on another device.
  if (myUsername) showMyHeader();
  const { data: profile } = await supabaseClient
    .from("profiles")
    .select("username, avatar_color")
    .eq("user_id", viewerId)
    .maybeSingle();
  if (viewerId !== currentUserId) return; // switched accounts meanwhile
  if (profile) myUsername = profile.username;
  rememberAvatarColors([profile]);

  if (!myUsername) {
    headerEl.classList.add("hidden");
    promptEl.classList.remove("hidden");
    inviteRowEl.classList.add("hidden");
    return;
  }

  showMyHeader();
  acceptPendingInvite(); // a username was just picked, maybe
  await loadFollowCounts();
}

// Your own color, fresh from the server (it may have been changed on
// another device): on opening the app and coming back to it.
async function refreshMyColor() {
  const viewerId = currentUserId;
  if (!viewerId) return;
  const { data: profile } = await supabaseClient.from("profiles").select("username, avatar_color").eq("user_id", viewerId).maybeSingle();
  if (viewerId !== currentUserId || !profile) return;
  const before = avatarColorByName.get(profile.username);
  myUsername = profile.username;
  rememberAvatarColors([profile]);
  if (avatarColorByName.get(profile.username) !== before && !TABS.me.panel.classList.contains("hidden")) drawMyAvatar();
}

function showMyHeader() {
  document.getElementById("profile-header-prompt").classList.add("hidden");
  document.getElementById("profile-header").classList.remove("hidden");
  document.getElementById("invite-row").classList.remove("hidden");
  loadInviteLink(); // ready before Share Link is tapped
  document.getElementById("profile-header-username").textContent = `@${myUsername}`;
  drawMyAvatar();
}

// ---------- "Your color" (tap your circle on the Me tab) ----------
const colorSheetEl = document.getElementById("color-sheet");
const colorSheetStatusEl = document.getElementById("color-sheet-status");
const CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
let colorPickNumber = 0; // only the newest tap's save may report back

function drawMyAvatar() {
  document.querySelector("#profile-avatar-button .profile-avatar").outerHTML = avatarHtml(myUsername, "profile-avatar");
}

function drawColorSheet() {
  const current = avatarColorByName.get(myUsername);
  document.getElementById("color-sheet-preview").innerHTML = avatarHtml(myUsername, "profile-avatar");
  document.getElementById("color-sheet-handle").textContent = `@${myUsername}`;
  document.getElementById("color-sheet-swatches").innerHTML = Object.entries(AVATAR_COLORS)
    .map(([key, shade]) => `<button class="color-swatch" role="radio" aria-checked="${key === current}" aria-label="${key}" data-color="${key}" style="--avatar: ${shade}">${CHECK_ICON_SVG}</button>`)
    .join("");
}

function setColorStatus(text, isError = false) {
  colorSheetStatusEl.textContent = text;
  colorSheetStatusEl.classList.toggle("is-error", isError);
}

function openColorSheet() {
  if (!currentUserId || !myUsername) return;
  setColorStatus("");
  drawColorSheet();
  colorSheetEl.classList.remove("hidden");
}

function closeColorSheet() {
  colorSheetEl.classList.add("hidden");
}

// The new color shows at once everywhere on this screen; if saving it
// fails, the old one comes back.
async function pickAvatarColor(key) {
  const name = myUsername;
  const before = avatarColorByName.get(name);
  if (!AVATAR_COLORS[key] || key === before) return;
  const thisPick = ++colorPickNumber;
  const viewerId = currentUserId;
  avatarColorByName.set(name, key);
  drawColorSheet();
  drawMyAvatar();
  setColorStatus("");
  const { error } = await supabaseClient.from("profiles").update({ avatar_color: key }).eq("user_id", viewerId);
  if (thisPick !== colorPickNumber || viewerId !== currentUserId) return;
  if (error) {
    if (before) avatarColorByName.set(name, before);
    else avatarColorByName.delete(name);
    drawColorSheet();
    drawMyAvatar();
    setColorStatus("Couldn't save your color. Check your connection.", true);
    return;
  }
  saveAvatarColors();
  setColorStatus("Saved");
}

document.getElementById("profile-avatar-button").addEventListener("click", openColorSheet);
document.getElementById("color-sheet-done").addEventListener("click", closeColorSheet);
colorSheetEl.addEventListener("click", (event) => {
  if (event.target === colorSheetEl) return closeColorSheet(); // tapped outside the sheet
  const swatch = event.target.closest(".color-swatch");
  if (swatch) pickAvatarColor(swatch.dataset.color);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !colorSheetEl.classList.contains("hidden")) closeColorSheet();
});

async function loadFollowCounts() {
  const { data: friendships } = await supabaseClient
    .from("friendships")
    .select("requester_id, addressee_id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${currentUserId},addressee_id.eq.${currentUserId}`);

  // Accepting a request makes it mutual, regardless of who sent it
  // originally - a "friend" is a two-way relationship here, not an
  // asymmetric follow.
  friendIds = (friendships || []).map((f) => (f.requester_id === currentUserId ? f.addressee_id : f.requester_id));

  document.getElementById("friends-count").textContent = friendIds.length;
}

async function showFriendsList() {
  document.getElementById("follow-list-title").textContent = "Friends";
  const listEl = document.getElementById("follow-list");
  listEl.innerHTML = "";

  if (friendIds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "preview-note";
    empty.textContent = "Nobody here yet.";
    listEl.appendChild(empty);
  } else {
    const { data: profiles } = await supabaseClient.from("profiles").select("user_id, username, avatar_color").in("user_id", friendIds);
    rememberAvatarColors(profiles);
    (profiles || []).forEach((profile) => {
      const row = document.createElement("div");
      row.className = "leaderboard-row";
      row.innerHTML = `
        ${avatarHtml(profile.username)}
        <span class="leaderboard-name"></span>
        <button class="row-options-button" aria-label="More options">&#8942;</button>
      `;
      row.querySelector(".leaderboard-name").textContent = profile.username;
      row.querySelector(".row-options-button").addEventListener("click", () =>
        openUserActions(profile.user_id, profile.username, "follow-list-screen", true)
      );
      listEl.appendChild(row);
    });
  }

  showScreen("follow-list-screen");
}

document.getElementById("friends-button").addEventListener("click", showFriendsList);
document.getElementById("follow-list-close-button").addEventListener("click", () => showScreen("app-screen"));

// Block/report another user - satisfies Apple's Guideline 1.2 (user-generated
// content moderation) since usernames are typed by other real people.
// Reports are insert-only from the client (see the `reports` table's RLS) -
// they're reviewed manually in the Supabase dashboard rather than through a
// built admin panel, which is a reasonable setup at this app's size.
// Blocking deletes any friendship row between the two users (pending or
// accepted) and records the block, which a database policy then uses to
// reject any future friend request between them in either direction.

let userActionsTargetId = null;
let userActionsReturnScreen = "app-screen";
let userActionsReturnToFriendsList = false;

function openUserActions(userId, username, returnScreen, returnToFriendsList) {
  userActionsTargetId = userId;
  userActionsReturnScreen = returnScreen;
  userActionsReturnToFriendsList = !!returnToFriendsList;

  document.getElementById("user-actions-subtitle").textContent = `@${username}`;
  document.getElementById("user-actions-menu").classList.remove("hidden");
  document.getElementById("report-reason-section").classList.add("hidden");
  document.getElementById("block-confirm-section").classList.add("hidden");
  document.getElementById("report-reason-input").value = "";

  const statusEl = document.getElementById("report-status-message");
  statusEl.textContent = "";
  statusEl.classList.remove("success");

  showScreen("user-actions-screen");
}

async function closeUserActionsAndRefresh() {
  if (userActionsReturnToFriendsList) {
    await loadFollowCounts();
    await showFriendsList();
  } else {
    showScreen(userActionsReturnScreen);
    await Promise.all([loadFriendRequests(), loadLeaderboard()]);
  }
}

document.getElementById("open-report-button").addEventListener("click", () => {
  document.getElementById("user-actions-menu").classList.add("hidden");
  document.getElementById("report-reason-section").classList.remove("hidden");
});

document.getElementById("open-block-button").addEventListener("click", () => {
  document.getElementById("user-actions-menu").classList.add("hidden");
  document.getElementById("block-confirm-section").classList.remove("hidden");
});

document.getElementById("user-actions-close-button").addEventListener("click", () => {
  showScreen(userActionsReturnScreen);
});

document.getElementById("submit-report-button").addEventListener("click", async () => {
  const reasonInput = document.getElementById("report-reason-input");
  const statusEl = document.getElementById("report-status-message");
  const reason = reasonInput.value.trim();

  const { error } = await supabaseClient.from("reports").insert({
    reporter_id: currentUserId,
    reported_user_id: userActionsTargetId,
    reason: reason || null,
  });

  if (error) {
    statusEl.textContent = "Something went wrong. Try again.";
    statusEl.classList.remove("success");
    return;
  }

  statusEl.textContent = "Report submitted. Thank you.";
  statusEl.classList.add("success");
  reasonInput.value = "";
});

document.getElementById("confirm-block-button").addEventListener("click", async () => {
  await supabaseClient
    .from("friendships")
    .delete()
    .or(
      `and(requester_id.eq.${currentUserId},addressee_id.eq.${userActionsTargetId}),and(requester_id.eq.${userActionsTargetId},addressee_id.eq.${currentUserId})`
    );

  await supabaseClient.from("blocked_users").insert({ blocker_id: currentUserId, blocked_id: userActionsTargetId });

  await closeUserActionsAndRefresh();
});


// STEP 5: The login/sign-up form and the log-out button.

const authEmailEl = document.getElementById("auth-email");
const authPasswordEl = document.getElementById("auth-password");
const authErrorEl = document.getElementById("auth-error");
const authSubmitEl = document.getElementById("auth-submit");
const authToggleModeEl = document.getElementById("auth-toggle-mode");
const authToggleTextEl = document.getElementById("auth-toggle-text");
const authSubtitleEl = document.getElementById("auth-subtitle");
const authForgotPasswordEl = document.getElementById("auth-forgot-password");
const logOutButtonEl = document.getElementById("log-out-button");

// The eye button in a password box shows or hides what's typed. Listens on
// the whole page so it also works in sign-up, which onboarding.js redraws.
// Pressing it doesn't take focus from the box, so the keyboard stays up.
document.addEventListener("mousedown", (event) => {
  if (event.target.closest(".password-eye")) event.preventDefault();
});
document.addEventListener("click", (event) => {
  const eye = event.target.closest(".password-eye");
  if (!eye) return;
  const field = eye.closest(".password-field");
  const showing = field.classList.toggle("showing");
  field.querySelector("input").type = showing ? "text" : "password";
  eye.setAttribute("aria-label", showing ? "Hide password" : "Show password");
});

// The form has two modes that share the same email/password fields.
let authMode = "login";

// Updates all the auth screen's text to match whatever `authMode`
// currently is. Pulled into its own function so both the toggle link
// AND the onboarding carousel's "Get Started" button can reuse it.
function applyAuthMode() {
  authErrorEl.textContent = "";
  authErrorEl.classList.remove("success");

  if (authMode === "signup") {
    authSubtitleEl.textContent = "Create an account to save your streak";
    authSubmitEl.textContent = "Sign Up";
    authToggleTextEl.textContent = "Already have an account?";
    authToggleModeEl.textContent = "Log In";
    authForgotPasswordEl.classList.add("hidden");
  } else {
    authSubtitleEl.textContent = "Log in to track your streak";
    authSubmitEl.textContent = "Log In";
    authToggleTextEl.textContent = "Don't have an account?";
    authToggleModeEl.textContent = "Sign Up";
    authForgotPasswordEl.classList.remove("hidden");
  }
}

authToggleModeEl.addEventListener("click", () => {
  authMode = authMode === "login" ? "signup" : "login";
  applyAuthMode();
});

authSubmitEl.addEventListener("click", async () => {
  const email = authEmailEl.value.trim();
  const password = authPasswordEl.value;

  authErrorEl.textContent = "";
  authErrorEl.classList.remove("success");

  if (!email || !password) {
    authErrorEl.textContent = "Enter both an email and password.";
    return;
  }

  // Disable the button while the request is in flight, so a slow
  // connection doesn't let someone click it 5 times in a row.
  authSubmitEl.disabled = true;

  if (authMode === "signup") {
    const { data: signUpData, error } = await supabaseClient.auth.signUp({ email, password });

    if (error) {
      // Supabase can reveal that an email is already registered here.
      // Showing that verbatim would let anyone check whether a specific
      // person has an account (email enumeration) - so this one specific
      // case gets the SAME response a real new signup gets instead of
      // its own distinct message.
      if (error.message.toLowerCase().includes("already registered")) {
        authErrorEl.textContent = "Check your email to confirm your account, then log in.";
        authErrorEl.classList.add("success");
      } else {
        authErrorEl.textContent = error.message;
      }
    } else if (!signUpData.session) {
      // Supabase requires confirming your email before you can log in -
      // there's no session yet, so onAuthStateChange won't fire.
      authErrorEl.textContent = "Check your email to confirm your account, then log in.";
      authErrorEl.classList.add("success");
    }
    // If a session WAS returned, onAuthStateChange fires on its own and
    // showApp() takes over from here - nothing else to do in that case.
  } else {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      authErrorEl.textContent = error.message;
    }
  }

  authSubmitEl.disabled = false;
});

// "Forgot password?" just navigates to its own dedicated screen - it
// doesn't try to reuse whatever's typed in the login form's email field.
authForgotPasswordEl.addEventListener("click", () => {
  showForgotPasswordScreen();
});

const forgotPasswordEmailEl = document.getElementById("forgot-password-email");
const forgotPasswordErrorEl = document.getElementById("forgot-password-error");
const forgotPasswordSubmitEl = document.getElementById("forgot-password-submit");
const forgotPasswordBackEl = document.getElementById("forgot-password-back");

forgotPasswordSubmitEl.addEventListener("click", async () => {
  const email = forgotPasswordEmailEl.value.trim();

  forgotPasswordErrorEl.textContent = "";
  forgotPasswordErrorEl.classList.remove("success");

  if (!email) {
    forgotPasswordErrorEl.textContent = "Enter your email address.";
    return;
  }

  forgotPasswordSubmitEl.disabled = true;

  // redirectTo tells Supabase where the link in the reset email should
  // point. Building it from the current page's own URL means this works
  // correctly whether we're testing on localhost or running live on
  // Netlify, without hardcoding either one.
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });

  if (error) {
    forgotPasswordErrorEl.textContent = error.message;
  } else {
    forgotPasswordErrorEl.textContent = "Check your email for a password reset link.";
    forgotPasswordErrorEl.classList.add("success");
  }

  forgotPasswordSubmitEl.disabled = false;
});

forgotPasswordBackEl.addEventListener("click", () => {
  forgotPasswordEmailEl.value = "";
  forgotPasswordErrorEl.textContent = "";
  forgotPasswordErrorEl.classList.remove("success");
  showAuthScreen();
});

const newPasswordEl = document.getElementById("new-password");
const resetPasswordSubmitEl = document.getElementById("reset-password-submit");
const resetPasswordErrorEl = document.getElementById("reset-password-error");

resetPasswordSubmitEl.addEventListener("click", async () => {
  const newPassword = newPasswordEl.value;

  resetPasswordErrorEl.textContent = "";

  if (!newPassword || newPassword.length < 6) {
    resetPasswordErrorEl.textContent = "Password must be at least 6 characters.";
    return;
  }

  resetPasswordSubmitEl.disabled = true;

  const { error } = await supabaseClient.auth.updateUser({ password: newPassword });

  if (error) {
    resetPasswordErrorEl.textContent = error.message;
    resetPasswordSubmitEl.disabled = false;
    return;
  }

  // The password is updated and the recovery session is now a normal
  // one - fetch it directly and go straight into the app, rather than
  // relying on another auth event to do it for us.
  inPasswordRecovery = false;
  newPasswordEl.value = "";
  resetPasswordSubmitEl.disabled = false;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    showApp(session.user.id);
  } else {
    showAuthScreen();
  }
});

logOutButtonEl.addEventListener("click", () => {
  justLoggedOut = true;
  supabaseClient.auth.signOut();
  // onAuthStateChange fires automatically after this and shows the
  // login screen (because justLoggedOut is true) - no need to do it
  // manually here.
});

// Delete account: reveal the confirmation, require the typed word, then
// the server deletes the account and (via cascading deletes) everything
// tied to it. Ends the same way a log-out does.
const deleteAccountButtonEl = document.getElementById("delete-account-button");
const deleteAccountPanelEl = document.getElementById("delete-account-panel");
const deleteConfirmInputEl = document.getElementById("delete-confirm-input");
const deleteAccountErrorEl = document.getElementById("delete-account-error");
const confirmDeleteButtonEl = document.getElementById("confirm-delete-account-button");

deleteAccountButtonEl.addEventListener("click", () => {
  deleteAccountPanelEl.classList.toggle("hidden");
  deleteConfirmInputEl.value = "";
  deleteAccountErrorEl.textContent = "";
  confirmDeleteButtonEl.disabled = true;
});

deleteConfirmInputEl.addEventListener("input", () => {
  confirmDeleteButtonEl.disabled = deleteConfirmInputEl.value.trim() !== "DELETE";
});

confirmDeleteButtonEl.addEventListener("click", async () => {
  confirmDeleteButtonEl.disabled = true;
  confirmDeleteButtonEl.textContent = "Deleting...";
  deleteAccountErrorEl.textContent = "";

  const reply = await callServerFunction("delete-account", { confirm: "DELETE" });
  confirmDeleteButtonEl.textContent = "Delete My Account";

  if (!reply.ok) {
    deleteAccountErrorEl.textContent = "Couldn't delete your account. Check your connection and try again.";
    confirmDeleteButtonEl.disabled = false;
    return;
  }

  // The account is gone. Tidy up this device too: stop push notifications
  // for it, and drop the local copy of progress that belonged to the account.
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch (e) {
    // push unsupported here - nothing to undo
  }
  localStorage.removeItem("streakfit-data");

  justLoggedOut = true;
  // "local": the server-side session is already gone with the account, so
  // asking the server to revoke it would just fail.
  await supabaseClient.auth.signOut({ scope: "local" });
  authErrorEl.textContent = "Your account and all its data were deleted.";
  authErrorEl.classList.add("success");
  deleteAccountPanelEl.classList.add("hidden");
});

// A guest can also choose to sign up any time from the Me tab, not just
// when prompted after their first log.
const guestSignupButtonEl = document.getElementById("guest-signup-button");
guestSignupButtonEl.addEventListener("click", () => {
  authMode = "signup";
  applyAuthMode();
  showAuthScreen();
});

// Lets someone dismiss the login/signup screen and keep using the app
// as a guest - whether they landed here from the post-first-log prompt
// or clicked into it manually.
const authSkipEl = document.getElementById("auth-skip");
authSkipEl.addEventListener("click", () => {
  showAppAsGuest();
});


// STEP 6: The log-in screen's Back link, shown when it was opened from the
// sign-up flow's welcome screen ("I already have an account").
document.getElementById("auth-back").addEventListener("click", () => {
  authErrorEl.textContent = "";
  Onboarding.start();
});


// STEP 7: GPS walk/run tracking - a live map, distance, and timer, all
// embedded directly in the Record tab (map shows a preview of where you
// are before you start, then switches to live-drawing your route).

const startTrackingButtonEl = document.getElementById("start-tracking-button");
const recordIdlePanelEl = document.getElementById("record-idle-panel");
const recordActivePanelEl = document.getElementById("record-active-panel");
const recordTrackingStatsEl = document.getElementById("record-tracking-stats");
const trackingTimeEl = document.getElementById("tracking-time");
const trackingDistanceEl = document.getElementById("tracking-distance");
const trackingDistanceLabelEl = document.getElementById("tracking-distance-label");
const trackingPaceEl = document.getElementById("tracking-pace");
const trackingPaceLabelEl = document.getElementById("tracking-pace-label");
const trackingElevationEl = document.getElementById("tracking-elevation");
const trackingElevationLabelEl = document.getElementById("tracking-elevation-label");
const trackingErrorEl = document.getElementById("tracking-error");
const trackingCancelEl = document.getElementById("tracking-cancel");
const trackingPauseEl = document.getElementById("tracking-pause");
const trackingFinishEl = document.getElementById("tracking-finish");
const summaryTimeEl = document.getElementById("summary-time");
const summaryDistanceEl = document.getElementById("summary-distance");
const summaryDistanceLabelEl = document.getElementById("summary-distance-label");
const summaryPaceEl = document.getElementById("summary-pace");
const summaryPaceLabelEl = document.getElementById("summary-pace-label");

// The Record tab's map is created once and reused every time the tab is
// shown (both for the idle "here's where you are" preview and for live
// tracking) - Leaflet doesn't like being re-initialized on a container
// that already has a map on it.
let recordMap = null;
let previewMarker = null;
let summaryMap = null;

// Everything about the CURRENT tracking session lives in one object, so
// starting a new session is just replacing this rather than resetting a
// dozen separate variables individually. Also doubles as "are we
// currently tracking?" - null means no.
let session = null;

function milesFromKm(km) {
  return km * 0.621371;
}

// The distance "as the crow flies" between two GPS points, in km - the
// standard formula for this (haversine) accounts for the Earth being a
// sphere rather than a flat plane.
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS_KM = 6371;
  const toRadians = (deg) => (deg * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- Efficient permanent route storage ----
//
// Every kept route is stored forever (like Strava - your history is a core
// feature). What keeps that cheap is storing each route small: nearly
// redundant points dropped, the rest packed into one short string. The
// helpers live in game-rules.js, shared with the server (which also uses
// them for the route shape friends see in the Feed).

// How far a point can deviate from a straight line before it's considered
// meaningful enough to keep, in degrees (~4 meters).
const ROUTE_SIMPLIFY_TOLERANCE = 0.00004;

function simplifyRoute(points, tolerance) {
  return ForjaRules.simplifyRoute(points, tolerance);
}

function encodePolyline(points) {
  return ForjaRules.encodePolyline(points);
}

function decodePolyline(encoded) {
  return ForjaRules.decodePolyline(encoded);
}

// ---- Drawing a route's shape (Feed cards, share images) ----
//
// GPS points are [lat, lng] on a globe; to draw them flat, longitude is
// squeezed by cos(latitude) (a degree of longitude gets shorter away from
// the equator), then the whole shape is scaled to fit the box, centered,
// with north up. Returns [x, y] screen points - empty if there's no line.
function fitRoute(points, x, y, width, height, padding) {
  if (points.length < 2) return [];
  const meanLat = points.reduce((sum, [lat]) => sum + lat, 0) / points.length;
  const squeeze = Math.cos((meanLat * Math.PI) / 180);
  const flat = points.map(([lat, lng]) => [lng * squeeze, lat]);
  const xs = flat.map((p) => p[0]);
  const ys = flat.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  if (spanX === 0 && spanY === 0) return [];
  // A dead-straight route has no width (or height) - only the other side limits it.
  const scale = Math.min(spanX ? (width - padding * 2) / spanX : Infinity, spanY ? (height - padding * 2) / spanY : Infinity);
  const left = x + (width - spanX * scale) / 2;
  const top = y + (height - spanY * scale) / 2;
  return flat.map(([px, py]) => [left + (px - minX) * scale, top + (minY + spanY - py) * scale]);
}

const SVG_NS = "http://www.w3.org/2000/svg";

// A Feed walk/run post's route: just the line (no map tiles) on a dot grid,
// with a dot where the shown part starts and ends. The route arrives
// already trimmed by the server, so these dots are never someone's door.
function routeShapeSvg(encoded) {
  const placed = fitRoute(decodePolyline(encoded), 0, 0, 320, 200, 20);
  if (placed.length < 2) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "feed-route");
  svg.setAttribute("viewBox", "0 0 320 200");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Route shape");
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("class", "feed-route-line");
  line.setAttribute("d", placed.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(""));
  svg.appendChild(line);
  [[placed[0], "feed-route-start"], [placed[placed.length - 1], "feed-route-end"]].forEach(([[px, py], className]) => {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("class", className);
    dot.setAttribute("cx", px.toFixed(1));
    dot.setAttribute("cy", py.toFixed(1));
    dot.setAttribute("r", "5");
    svg.appendChild(dot);
  });
  return svg;
}

// ---- A Feed route on a real map ----
//
// Maps come from OpenFreeMap: no key, no account, no limit. This phone
// draws them with MapLibre (loaded only once a route needs it) into one
// hidden map, with every name and icon left out and the route drawn in,
// then keeps the result as a picture - a post's map never changes, so each
// is drawn once per theme. Until the picture is ready, and whenever the map
// can't be drawn (no WebGL, offline, the service is down), the card keeps
// the plain line.
const MAPLIBRE_SCRIPT = {
  src: "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js",
  // The browser refuses the file unless it's exactly this one.
  integrity: "sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj",
};
const ROUTE_MAP_STYLES = { dark: "https://tiles.openfreemap.org/styles/dark", light: "https://tiles.openfreemap.org/styles/positron" };
const ROUTE_MAP_CACHE = "forja-route-maps-v1"; // the service worker keeps it across updates
const ROUTE_MAP_KEEP = 150; // newest pictures kept on this phone
const ROUTE_MAP_TIMEOUT_MS = 15000;

let mapLibreLoading = null;
const routeMapStyles = {}; // theme -> the style, names removed
const routeMaps = {}; // theme -> its hidden map
let routeMapQueue = Promise.resolve(); // one drawing at a time

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
}

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!mapLibreLoading) {
    mapLibreLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = MAPLIBRE_SCRIPT.src;
      script.integrity = MAPLIBRE_SCRIPT.integrity;
      script.crossOrigin = "anonymous";
      script.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error("no maplibregl")));
      script.onerror = () => reject(new Error("MapLibre didn't load"));
      document.head.appendChild(script);
    }).catch((error) => {
      mapLibreLoading = null; // try again next time the Feed opens
      throw error;
    });
  }
  return mapLibreLoading;
}

// The map style without its "symbol" layers (every street, place and water
// name, and every icon), plus empty layers for the route and its two dots.
async function routeMapStyle(theme) {
  if (routeMapStyles[theme]) return routeMapStyles[theme];
  const response = await fetch(ROUTE_MAP_STYLES[theme]);
  if (!response.ok) throw new Error(`map style ${response.status}`);
  const style = await response.json();
  style.layers = style.layers.filter((layer) => layer.type !== "symbol");
  delete style.glyphs;
  delete style.sprite;
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const empty = { type: "FeatureCollection", features: [] };
  style.sources.route = { type: "geojson", data: empty };
  style.sources["route-ends"] = { type: "geojson", data: empty };
  const round = { "line-cap": "round", "line-join": "round" };
  style.layers.push(
    { id: "route-casing", type: "line", source: "route", layout: round, paint: { "line-color": color("--route-casing"), "line-width": 8.5 } },
    { id: "route-line", type: "line", source: "route", layout: round, paint: { "line-color": color("--accent"), "line-width": 4.5 } },
    {
      id: "route-ends", type: "circle", source: "route-ends",
      paint: { "circle-radius": 5, "circle-color": ["get", "color"], "circle-stroke-width": 3, "circle-stroke-color": color("--route-casing") },
    },
  );
  style.metadata = { ...style.metadata, endColors: [color("--accent"), color("--text-primary")] };
  routeMapStyles[theme] = style;
  return style;
}

async function routeMapFor(theme) {
  if (routeMaps[theme]) return routeMaps[theme];
  const maplibregl = await loadMapLibre();
  const style = await routeMapStyle(theme);
  const container = document.createElement("div");
  container.className = "route-map-painter";
  container.setAttribute("aria-hidden", "true");
  document.body.appendChild(container);
  const map = new maplibregl.Map({
    container, style, pixelRatio: 2, interactive: false, attributionControl: false,
    preserveDrawingBuffer: true, fadeDuration: 0,
  });
  routeMaps[theme] = withTimeout(new Promise((resolve, reject) => {
    map.once("load", () => resolve(map));
    map.once("error", (event) => reject(event.error || new Error("map error")));
  }), ROUTE_MAP_TIMEOUT_MS).catch((error) => {
    delete routeMaps[theme];
    map.remove();
    container.remove();
    throw error;
  });
  return routeMaps[theme];
}

// Draws one route and returns the picture (a JPEG blob).
async function drawRouteMap(points, theme) {
  const map = await routeMapFor(theme);
  const [startColor, endColor] = routeMapStyles[theme].metadata.endColors;
  const lngLat = ([lat, lng]) => [lng, lat];
  map.getSource("route").setData({ type: "Feature", geometry: { type: "LineString", coordinates: points.map(lngLat) } });
  map.getSource("route-ends").setData({
    type: "FeatureCollection",
    features: [[points[0], startColor], [points[points.length - 1], endColor]].map(([point, color]) => ({
      type: "Feature", properties: { color }, geometry: { type: "Point", coordinates: lngLat(point) },
    })),
  });
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  const drawn = new Promise((resolve) => map.once("idle", resolve));
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 20, maxZoom: 17, animate: false });
  await withTimeout(drawn, ROUTE_MAP_TIMEOUT_MS);
  const blob = await new Promise((resolve) => map.getCanvas().toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("no picture");
  return blob;
}

async function openRouteMapCache() {
  try {
    return await caches.open(ROUTE_MAP_CACHE);
  } catch {
    return null; // private browsing etc.: still drawn, just not kept
  }
}

// Keeps the newest ROUTE_MAP_KEEP pictures (the cache lists oldest first).
async function trimRouteMapCache(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - ROUTE_MAP_KEEP)).map((key) => cache.delete(key)));
}

async function routeMapPicture(postId, points, theme) {
  const cache = await openRouteMapCache();
  const key = `route-map/${encodeURIComponent(postId)}-${theme}.jpg`;
  const saved = cache && (await cache.match(key));
  if (saved) return saved.blob();
  const job = routeMapQueue.then(() => drawRouteMap(points, theme));
  routeMapQueue = job.catch(() => {});
  const blob = await job;
  if (cache) {
    try {
      await cache.put(key, new Response(blob, { headers: { "Content-Type": "image/jpeg" } }));
      await trimRouteMapCache(cache);
    } catch {
      // Full storage: the picture just isn't kept.
    }
  }
  return blob;
}

// Swaps a card's plain line for the map once the picture is ready.
async function showRouteMap(post, lineEl) {
  const theme = currentTheme();
  let blob;
  try {
    blob = await routeMapPicture(post.id, decodePolyline(post.route), theme);
  } catch {
    return; // keep the line
  }
  if (!lineEl.isConnected || theme !== currentTheme()) return;
  const box = document.createElement("div");
  box.className = "feed-route feed-route-map";
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", "Route on a map");
  const img = document.createElement("img");
  img.alt = "";
  const url = URL.createObjectURL(blob);
  img.onload = img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
  const credit = document.createElement("span");
  credit.className = "feed-route-credit";
  credit.textContent = "© OpenMapTiles © OpenStreetMap";
  box.append(img, credit);
  lineEl.replaceWith(box);
}

// Formats milliseconds as "M:SS" (or "H:MM:SS" past an hour).
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

function distanceUnitLabel() {
  return data.units === "km" ? "km" : "mi";
}

function displayDistance(km) {
  const value = data.units === "km" ? km : milesFromKm(km);
  return value.toFixed(2);
}

function metersToFeet(meters) {
  return meters * 3.28084;
}

function elevationUnitLabel() {
  return data.units === "km" ? "m gain" : "ft gain";
}

function displayElevation(meters) {
  const value = data.units === "km" ? meters : metersToFeet(meters);
  return Math.round(value);
}

// How much a single step's altitude has to change before it counts
// toward elevation gain, in meters. Phone GPS altitude is noisy - without
// a threshold like this, standing still would still slowly accumulate
// fake "gain" from that noise alone.
const ELEVATION_NOISE_THRESHOLD_M = 1;

// No +/- buttons: you pinch to zoom, like Apple Maps. The OpenStreetMap
// credit stays (their license needs it), without Leaflet's own link.
function createMap(containerId) {
  const map = L.map(containerId, { zoomControl: false });
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  return map;
}

// Called every time the Record tab is opened. If a session is already
// in progress (e.g. you switched to another tab mid-run and came back),
// this leaves everything as-is instead of resetting the view.
function enterRecordTab() {
  if (!recordMap) {
    recordMap = createMap("record-map");
    recordMap.setView([20, 0], 2); // whole-world view until we know better
  }

  // The container was hidden (display:none) until just now, so Leaflet
  // needs to be told to re-measure it, or the map renders broken/blank.
  setTimeout(() => recordMap.invalidateSize(), 0);

  if (session) {
    return; // already tracking - keep showing the live view as-is
  }

  renderPastRoutesList();
  showPreviewLocation();
}

// Shows a single marker at your current position, before tracking has
// started - literally the "preview" of where a run would begin.
function showPreviewLocation() {
  if (!("geolocation" in navigator)) return;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const point = [position.coords.latitude, position.coords.longitude];
      recordMap.setView(point, 16);
      if (previewMarker) {
        previewMarker.setLatLng(point);
      } else {
        previewMarker = L.circleMarker(point, { radius: 7, color: "#22c55e", fillOpacity: 1 }).addTo(recordMap);
      }
    },
    () => {
      // Permission denied or unavailable - silently leave the world view
      // in place. We only surface an error once they actually try to
      // start tracking, not just for looking at the tab.
    },
    { enableHighAccuracy: true }
  );
}

// The elapsed time actually spent moving - freezes the instant you pause
// (using the pause moment instead of "now") and permanently excludes
// whatever time you've already spent paused before this point.
function elapsedTrackingMs() {
  const now = session.isPaused ? session.pausedAt : Date.now();
  return now - session.startTime - session.totalPausedMs;
}

// Same pace formula the post-run summary screen uses (time / distance),
// just recalculated live instead of once at the end.
function updateTrackingTimeAndPace() {
  const elapsed = elapsedTrackingMs();
  trackingTimeEl.textContent = formatDuration(elapsed);

  const distanceInUnits = data.units === "km" ? session.distanceKm : milesFromKm(session.distanceKm);
  trackingPaceEl.textContent = distanceInUnits > 0.01 ? formatDuration(elapsed / distanceInUnits) : "--";
}

// Starts (or restarts, after a resume) the actual GPS watch and the
// once-a-second display timer - pulled into its own function so Resume
// can reuse the exact same setup as the initial Start.
function startWatchingPosition() {
  session.timerId = setInterval(updateTrackingTimeAndPace, 1000);
  session.watchId = navigator.geolocation.watchPosition(onTrackingPosition, onTrackingError, {
    enableHighAccuracy: true,
    maximumAge: 0,
  });
  keepScreenOn();
}

// A web app gets no GPS while the screen is locked or another app is in
// front, so a walk recorded from a pocket comes out short (straight lines
// between the few points it did get) and can fail the pace check. Keeping
// the screen awake while tracking stops the auto-lock, which is most of
// it. The phone drops the lock whenever Forja leaves the screen, so it's
// asked for again on the way back (see the visibilitychange listener).
// Phones without it (older iOS) just track the way they always did.
let screenWakeLock = null;

async function keepScreenOn() {
  if (!("wakeLock" in navigator) || screenWakeLock) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    // Paused or finished while the request was on its way, or a second
    // request (resume + coming back on screen) got there first.
    if (!session || session.isPaused || screenWakeLock) {
      lock.release();
      return;
    }
    screenWakeLock = lock;
    lock.addEventListener("release", () => {
      if (screenWakeLock === lock) screenWakeLock = null;
    });
  } catch (e) {
    // refused (low battery mode, not visible yet) - nothing to do
  }
}

function letScreenSleep() {
  if (screenWakeLock) screenWakeLock.release();
  screenWakeLock = null;
}

// Longer than this out of sight mid-walk and the route has a hole in it.
const TRACKING_GAP_WARN_MS = 30000;

document.addEventListener("visibilitychange", () => {
  if (!session || session.isPaused) return;
  if (document.visibilityState === "hidden") {
    session.hiddenAt = Date.now();
    return;
  }
  keepScreenOn();
  if (session.hiddenAt && Date.now() - session.hiddenAt >= TRACKING_GAP_WARN_MS) {
    trackingErrorEl.textContent = "Keep Forja open on screen - distance isn't tracked while it's closed.";
  }
  session.hiddenAt = null;
});

function startTracking() {
  if (!("geolocation" in navigator)) {
    trackingErrorEl.textContent = "GPS isn't available on this device/browser.";
    return;
  }

  session = {
    route: [],
    distanceKm: 0,
    startTime: Date.now(),
    watchId: null,
    timerId: null,
    polyline: null,
    marker: null,
    isPaused: false,
    pausedAt: null,
    totalPausedMs: 0,
    elevationGainM: 0,
    lastAltitude: null,
    hiddenAt: null,
  };

  trackingErrorEl.textContent = "";
  trackingTimeEl.textContent = "0:00";
  trackingDistanceEl.textContent = "0.00";
  trackingDistanceLabelEl.textContent = distanceUnitLabel();
  trackingPaceEl.textContent = "--";
  trackingPaceLabelEl.textContent = `/${distanceUnitLabel()}`;
  trackingElevationEl.textContent = "0";
  trackingElevationLabelEl.textContent = elevationUnitLabel();
  trackingPauseEl.textContent = "Pause";

  recordIdlePanelEl.classList.add("hidden");
  recordActivePanelEl.classList.remove("hidden");
  recordTrackingStatsEl.classList.remove("hidden");

  // Starting fresh: clear the preview marker and draw the route on top
  // of the same map instance instead of creating a new one.
  if (previewMarker) {
    recordMap.removeLayer(previewMarker);
    previewMarker = null;
  }
  session.polyline = L.polyline([], { color: "#22c55e", weight: 4 }).addTo(recordMap);

  startWatchingPosition();
}

trackingPauseEl.addEventListener("click", () => {
  if (session.isPaused) {
    // Resume: fold however long we were paused into the running total,
    // so the displayed time picks back up where it left off instead of
    // jumping forward by the length of the pause.
    session.totalPausedMs += Date.now() - session.pausedAt;
    session.isPaused = false;
    trackingPauseEl.textContent = "Pause";
    startWatchingPosition();
  } else {
    session.isPaused = true;
    session.pausedAt = Date.now();
    trackingPauseEl.textContent = "Resume";
    navigator.geolocation.clearWatch(session.watchId);
    clearInterval(session.timerId);
    letScreenSleep();
  }
});

function onTrackingPosition(position) {
  const { latitude, longitude, altitude } = position.coords;
  const point = [latitude, longitude];
  const previousPoint = session.route[session.route.length - 1];

  if (previousPoint) {
    session.distanceKm += haversineDistanceKm(previousPoint[0], previousPoint[1], latitude, longitude);
  }

  // altitude is `null` on many devices/moments (GPS altitude needs a
  // stronger fix than horizontal position does) - only count a change
  // when we have two real readings to compare, and only if that change
  // clears the noise threshold, so standing still doesn't slowly rack up
  // fake gain from GPS jitter alone.
  if (altitude !== null) {
    if (session.lastAltitude !== null) {
      const gain = altitude - session.lastAltitude;
      if (gain > ELEVATION_NOISE_THRESHOLD_M) {
        session.elevationGainM += gain;
        trackingElevationEl.textContent = String(displayElevation(session.elevationGainM));
      }
    }
    session.lastAltitude = altitude;
  }

  session.route.push(point);
  session.polyline.addLatLng(point);

  if (session.marker) {
    session.marker.setLatLng(point);
  } else {
    session.marker = L.circleMarker(point, { radius: 7, color: "#22c55e", fillOpacity: 1 }).addTo(recordMap);
  }

  recordMap.setView(point, recordMap.getZoom() < 15 ? 16 : recordMap.getZoom());
  trackingDistanceEl.textContent = displayDistance(session.distanceKm);
}

function onTrackingError(error) {
  trackingErrorEl.textContent =
    error.code === error.PERMISSION_DENIED
      ? "Location permission denied - allow it in your browser settings to track a route."
      : "Couldn't get your location. Check your GPS/location settings.";
}

// Stops watching GPS and the timer, but keeps `session`'s data around so
// the caller can still read the final distance/route/duration from it.
function stopTrackingWatchers() {
  if (session.watchId !== null) navigator.geolocation.clearWatch(session.watchId);
  if (session.timerId !== null) clearInterval(session.timerId);
  letScreenSleep();
}

// Returns the Record tab to its normal idle view (map preview + Start
// button) - used after both Cancel and after finishing.
function resetRecordToIdle() {
  recordActivePanelEl.classList.add("hidden");
  recordTrackingStatsEl.classList.add("hidden");
  recordIdlePanelEl.classList.remove("hidden");
  if (session && session.polyline) {
    recordMap.removeLayer(session.polyline);
  }
  if (session && session.marker) {
    recordMap.removeLayer(session.marker);
  }
  session = null;
  showPreviewLocation();
}

// Finish and Cancel end a walk, so a bump in a pocket or a stray thumb
// mustn't do it: they need a 1-second hold. While held, a fill sweeps
// across the button; let go early and it drains back and nothing happens.
// A quick tap shows "Hold to finish" so the rule teaches itself.
const HOLD_TO_CONFIRM_MS = 1000;
const holdHintEl = document.getElementById("hold-hint");
let holdHintTimer = null;

function showHoldHint(text) {
  holdHintEl.textContent = text;
  holdHintEl.classList.add("is-shown");
  clearTimeout(holdHintTimer);
  holdHintTimer = setTimeout(() => holdHintEl.classList.remove("is-shown"), 1600);
}

function setupHoldButton(button, hintText, onConfirm) {
  const fill = button.querySelector(".hold-fill");
  let heldSince = null; // null = not being held
  let progress = 0; // 0-1, how full the button is
  let frame = null;
  let lastPressAt = -Infinity;

  const draw = () => {
    fill.style.transform = `scaleX(${progress})`;
  };

  function tick(now) {
    if (heldSince !== null) {
      progress = Math.min(1, (now - heldSince) / HOLD_TO_CONFIRM_MS);
      draw();
      if (progress >= 1) {
        heldSince = null;
        frame = null;
        progress = 0;
        draw();
        button.classList.remove("is-holding");
        if (navigator.vibrate) navigator.vibrate(30);
        onConfirm();
        return;
      }
    } else {
      progress = Math.max(0, progress - 0.08); // let go early: drain back
      draw();
      if (progress <= 0) {
        frame = null;
        return;
      }
    }
    frame = requestAnimationFrame(tick);
  }

  function press() {
    lastPressAt = performance.now();
    if (heldSince !== null) return;
    heldSince = performance.now() - progress * HOLD_TO_CONFIRM_MS; // re-grab mid-drain picks up where it is
    button.classList.add("is-holding");
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function release() {
    if (heldSince === null) return;
    if (progress < 0.25) showHoldHint(hintText);
    heldSince = null;
    button.classList.remove("is-holding");
    if (!frame) frame = requestAnimationFrame(tick);
  }

  button.addEventListener("pointerdown", (event) => {
    event.preventDefault(); // no text selection / focus jump on a long press
    button.setPointerCapture(event.pointerId);
    press();
  });
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  button.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) press();
  });
  button.addEventListener("keyup", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    release();
  });
  // The click a tap or key press ends with is handled by the hold above.
  // A click with no press before it comes from assistive tech (or a
  // script) - nothing to hold there, so it counts straight away.
  button.addEventListener("click", () => {
    if (performance.now() - lastPressAt < HOLD_TO_CONFIRM_MS + 1500) return;
    onConfirm();
  });
}

function cancelTracking() {
  stopTrackingWatchers();
  resetRecordToIdle();
}

// Every finished route is kept - there's no "keep or discard?" question.
// Simplified (near-redundant points dropped) then encoded (packed into one
// compact string), which is what makes it reasonable to keep every route
// forever. A route with fewer than two points (Start then straight to
// Finish) has no line to show, so it isn't saved.
function saveRoute(route, distanceKm, durationMs, elevationGainM) {
  if (route.length < 2) return;
  data.routes.push({
    date: todayString(),
    distanceKm,
    durationMs,
    elevationGainM: elevationGainM || 0,
    encodedRoute: encodePolyline(simplifyRoute(route, ROUTE_SIMPLIFY_TOLERANCE)),
  });
  saveData(data);
  renderPastRoutesList();
  renderDistanceChart();
}

async function finishTracking() {
  stopTrackingWatchers();

  const durationMs = elapsedTrackingMs();
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
  const { route, distanceKm, elevationGainM } = session;

  // The GPS track is the verification for walk/run, but GPS alone can't
  // tell walking from sitting with the tracker running - so the minutes
  // only count if the route actually covered ground at walking pace or
  // faster.
  const averageKmh = durationMs > 0 ? distanceKm / (durationMs / 3600000) : 0;
  const realPace = averageKmh >= ForjaRules.ACTIVITY.MIN_KMH;
  const countsTowardToday = realPace && data.lastLoggedDate !== todayString();
  if (countsTowardToday) {
    todayProgress().walkRun += durationMinutes;
    saveData(data);
  }
  saveRoute(route, distanceKm, durationMs, elevationGainM);
  render();

  resetRecordToIdle();
  showTrackingSummary(route, distanceKm, durationMs, elevationGainM, "new");
  if (!countsTowardToday && data.lastLoggedDate !== todayString()) {
    const note = document.getElementById("tracking-summary-note");
    note.textContent = "Too slow to count toward today. Walk/run minutes need real movement.";
    note.classList.remove("hidden");
  }

  // Every walk or run at a real pace goes to the Feed - whether or not it
  // completes today. Shared BEFORE checking the day, so a full-day post
  // that this walk completes includes its minutes.
  if (currentUserId && realPace) await shareActivity(route, durationMs);
  maybeCompleteDay();
}

setupHoldButton(trackingCancelEl, "Hold to cancel", cancelTracking);
setupHoldButton(trackingFinishEl, "Hold to finish", finishTracking);

// Posts a finished walk/run to the Feed. The server works out distance,
// pace and walk-vs-run from the GPS points itself. If it fails (no signal)
// there's just no post - the minutes still count toward today.
async function shareActivity(route, durationMs) {
  const points = route.length > ForjaRules.ACTIVITY.MAX_POINTS ? simplifyRoute(route, ROUTE_SIMPLIFY_TOLERANCE) : route;
  const reply = await callServerFunction("log-activity", { day: todayString(), points, durationMs: Math.round(durationMs) });
  return reply.ok;
}

// mode is "new" (just finished tracking - already saved, so just "Done")
// or "view" (browsing a saved route from Past Routes - "Close").
function showTrackingSummary(route, distanceKm, durationMs, elevationGainM, mode) {
  document.getElementById("tracking-summary-heading").textContent = mode === "view" ? "Route Detail" : "Nice work!";
  document.getElementById("tracking-summary-note").classList.add("hidden");
  document.getElementById("tracking-summary-close-button").textContent = mode === "view" ? "Close" : "Done";

  summaryTimeEl.textContent = formatDuration(durationMs);
  summaryDistanceEl.textContent = displayDistance(distanceKm);
  summaryDistanceLabelEl.textContent = distanceUnitLabel();

  const distanceInUnits = data.units === "km" ? distanceKm : milesFromKm(distanceKm);
  if (distanceInUnits > 0) {
    const paceMsPerUnit = durationMs / distanceInUnits;
    summaryPaceEl.textContent = formatDuration(paceMsPerUnit);
  } else {
    summaryPaceEl.textContent = "--";
  }
  summaryPaceLabelEl.textContent = `/${distanceUnitLabel()}`;

  document.getElementById("summary-elevation").textContent = String(displayElevation(elevationGainM || 0));
  document.getElementById("summary-elevation-label").textContent = elevationUnitLabel();
  document.getElementById("summary-steps").textContent = ForjaRules.estimateSteps(distanceKm, durationMs).toLocaleString();
  document.getElementById("summary-calories").textContent = ForjaRules.activeCalories(distanceKm, durationMs, elevationGainM || 0, bodyWeightKg()).toLocaleString();

  // Share needs something left once the first and last 200 m are cut.
  shareRoute.points = ForjaRules.trimRouteEnds(route, ForjaRules.ROUTE_PRIVACY_M);
  shareRoute.distanceKm = distanceKm;
  shareRoute.durationMs = durationMs;
  document.getElementById("tracking-summary-share-button").classList.toggle("hidden", shareRoute.points.length < 2);

  showScreen("tracking-summary-screen");

  // Leaflet throws if you re-initialize a map on a container that
  // already has one - remove the previous summary map first, since this
  // screen gets reused for every route (new or from history).
  if (summaryMap) {
    summaryMap.remove();
  }
  summaryMap = createMap("summary-map");

  if (route.length > 0) {
    const polyline = L.polyline(route, { color: "#22c55e", weight: 4 }).addTo(summaryMap);
    summaryMap.fitBounds(polyline.getBounds(), { padding: [20, 20] });
  } else {
    summaryMap.setView([0, 0], 2);
  }
}

document.getElementById("tracking-summary-close-button").addEventListener("click", () => {
  showScreen("app-screen");
});

// ---- Share a route as an image ----
//
// The image is drawn on a 1080 x 1920 canvas (a phone story) and turned
// into a PNG file AHEAD of the tap: iPhones only open the share sheet when
// navigator.share runs right inside the tap, with nothing slow before it.
// shareRoute.points is already trimmed (showTrackingSummary).
//
// The Sticker PNG (see-through, stats + route only) is also exactly what
// Instagram's own Stories connection takes as its "sticker" once Forja is
// an App Store app - the person's photo goes behind it there.
// The same screen shares a streak milestone (kind "streak", see
// openMilestoneShare): streak = {count, days: ["day"|"rest", ...] oldest
// first, totals: {pushups, squats, plankSeconds} or null}.
const shareRoute = { kind: "route", streak: null, points: [], distanceKm: 0, durationMs: 0, template: "sticker", file: null, drawId: 0 };
const shareRouteCanvasEl = document.getElementById("share-route-canvas");
const shareRouteButtonEl = document.getElementById("share-route-button");
const shareRouteCopyEl = document.getElementById("share-route-copy");
// Copying an image needs the newer clipboard (iPhone Safari 13.4+).
const canCopyImage = !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);

// day / rest / restMark: a streak card's days, in the History calendar's
// colors (--accent, --heatmap-rest, --heatmap-rest-mark).
const SHARE_TEMPLATES = {
  // See-through, white, with a soft shadow so it reads over any photo.
  sticker: { background: null, text: "#ffffff", subtext: "#ffffffcc", line: "#ffffff", shadow: "#00000073", day: "#22c55e", rest: "#247644", restMark: "#f4f4f5" },
  dark: { background: "#0b0b0d", text: "#ffffff", subtext: "#ffffffb3", line: "#22c55e", glow: "#22c55e2b", day: "#22c55e", rest: "#247644", restMark: "#f4f4f5" },
  light: { background: "#f4f4f1", text: "#141416", subtext: "#14141699", line: "#16a34a", day: "#22c55e", rest: "#22c55e59", restMark: "#15803d" },
};

// The celebration's flexing pet as a picture (brand/forja-pet-flex.svg,
// made from celebrations.js FlexPet by forja-lab/tools/export-flexpet.js).
let sharePetImage = null;
function sharePet() {
  if (!sharePetImage) {
    sharePetImage = new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = "brand/forja-pet-flex.svg";
    });
  }
  return sharePetImage;
}

// The Forja lockup (ring + word) from the page's logo sprite, as an image
// the canvas can draw, in the given word color. Made once per color.
const shareLogoImages = {};
function shareLogoImage(color) {
  if (!shareLogoImages[color]) {
    shareLogoImages[color] = new Promise((resolve) => {
      const shapes = document.getElementById("forja-lockup").innerHTML.replaceAll("currentColor", color);
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 367 110" width="367" height="110">${shapes}</svg>`)}`;
    });
  }
  return shareLogoImages[color];
}

// Same rule the server uses to call a Feed post a walk or a run.
function shareIsRun() {
  return shareRoute.durationMs > 0 && shareRoute.distanceKm / (shareRoute.durationMs / 3600000) >= ForjaRules.ACTIVITY.RUN_KMH;
}

function drawShareImage(ctx, style, logo, pet) {
  if (shareRoute.kind === "streak") return drawStreakImage(ctx, style, logo, pet);
  const W = 1080;
  const H = 1920;
  const font = (size, weight) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const isRun = shareIsRun();
  const distanceInUnits = data.units === "km" ? shareRoute.distanceKm : milesFromKm(shareRoute.distanceKm);
  const unitWord = data.units === "km" ? "KILOMETERS" : "MILES";

  ctx.clearRect(0, 0, W, H);
  if (style.background) {
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, W, H);
  }
  if (style.glow) {
    const glow = ctx.createRadialGradient(W / 2, 1280, 50, W / 2, 1280, 700);
    glow.addColorStop(0, style.glow);
    glow.addColorStop(1, "#0b0b0d00");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.save();
  if (style.shadow) {
    ctx.shadowColor = style.shadow;
    ctx.shadowBlur = 24;
  }

  // The numbers, big, at the top.
  ctx.textAlign = "center";
  ctx.fillStyle = style.text;
  ctx.font = font(250, 800);
  ctx.fillText(displayDistance(shareRoute.distanceKm), W / 2, 520);
  ctx.fillStyle = style.subtext;
  ctx.font = font(64, 700);
  ctx.fillText(`${unitWord} ${isRun ? "RUN" : "WALKED"}`, W / 2, 610);
  // Pace, time and steps in a row. (No calories: with the distance and time
  // right here, they'd give away the weight they're worked out from.) A
  // value too wide for its third, like 1:05:30 or 12,345, shrinks to fit.
  const columns = [
    [distanceInUnits > 0 ? formatDuration(shareRoute.durationMs / distanceInUnits) : "--", `PACE /${distanceUnitLabel().toUpperCase()}`],
    [formatDuration(shareRoute.durationMs), "TIME"],
    [ForjaRules.estimateSteps(shareRoute.distanceKm, shareRoute.durationMs).toLocaleString(), "STEPS"],
  ];
  columns.forEach(([value, label], i) => {
    const x = W / 2 + (i - 1) * 330;
    let size = 96;
    ctx.font = font(size, 800);
    while (size > 60 && ctx.measureText(value).width > 270) ctx.font = font(--size, 800);
    ctx.fillStyle = style.text;
    ctx.fillText(value, x, 790);
    ctx.fillStyle = style.subtext;
    ctx.font = font(48, 700);
    ctx.fillText(label, x, 855);
  });

  // The route.
  const placed = fitRoute(shareRoute.points, 140, 960, W - 280, 650, 20);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 18;
  ctx.strokeStyle = style.line;
  ctx.beginPath();
  placed.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.stroke();

  // Forja, at the bottom.
  if (logo) {
    ctx.drawImage(logo, W / 2 - 150, 1700, 300, 90);
  } else {
    ctx.fillStyle = style.text;
    ctx.font = font(64, 800);
    ctx.fillText("Forja", W / 2, 1768);
  }
  ctx.restore();
}

// A streak milestone: the flexing pet, the number, every day of the streak
// (green = verified, the History calendar's moon square = a rest day) and
// what was done across it. The pet is drawn before any shadow so its
// colors stay exactly the app's.
const STREAK_NAMES = { 7: "ONE WEEK", 14: "TWO WEEKS", 30: "ONE MONTH", 60: "TWO MONTHS", 100: "100 DAYS", 365: "ONE YEAR" };

function drawStreakImage(ctx, style, logo, pet) {
  const W = 1080;
  const H = 1920;
  const font = (size, weight) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const { count, days, totals } = shareRoute.streak;

  ctx.clearRect(0, 0, W, H);
  if (style.background) {
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, W, H);
  }
  if (style.glow) {
    const glow = ctx.createRadialGradient(W / 2, 460, 50, W / 2, 460, 700);
    glow.addColorStop(0, style.glow);
    glow.addColorStop(1, "#0b0b0d00");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }
  if (pet) ctx.drawImage(pet, (W - 640) / 2, 150, 640, (640 * pet.height) / pet.width);

  const withShadow = (draw) => {
    ctx.save();
    if (style.shadow) {
      ctx.shadowColor = style.shadow;
      ctx.shadowBlur = 24;
    }
    ctx.textAlign = "center";
    draw();
    ctx.restore();
  };
  withShadow(() => {
    ctx.fillStyle = style.text;
    ctx.font = font(count >= 100 ? 290 : 320, 800);
    ctx.fillText(String(count), W / 2, 1010);
    ctx.font = font(64, 800);
    ctx.fillText("DAY STREAK", W / 2, 1095);
    ctx.fillStyle = style.subtext;
    ctx.font = font(44, 700);
    ctx.fillText(`${STREAK_NAMES[count] || `${count} DAYS`} · EVERY REP VERIFIED`, W / 2, 1165);
  });

  // Every day of the streak, rows of 7 / 10 / 25 to fit.
  const cols = days.length <= 14 ? 7 : days.length <= 110 ? 10 : 25;
  const rows = Math.ceil(days.length / cols);
  const areaW = days.length <= 14 ? 700 : 820;
  const areaH = 330;
  const cell = Math.min(areaW / cols, areaH / rows, 100);
  const size = cell * 0.84;
  const x0 = (W - cols * cell) / 2;
  const y0 = 1225 + (areaH - rows * cell) / 2;
  days.forEach((kind, i) => {
    const x = x0 + (i % cols) * cell + (cell - size) / 2;
    const y = y0 + Math.floor(i / cols) * cell + (cell - size) / 2;
    ctx.fillStyle = kind === "rest" ? style.rest : style.day;
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, size * 0.18);
    ctx.fill();
    if (kind === "rest") drawRestMark(ctx, x, y, size, style.restMark);
  });

  withShadow(() => {
    if (totals) {
      [
        [totals.pushups.toLocaleString(), "PUSH-UPS"],
        [totals.squats.toLocaleString(), "SQUATS"],
        [formatPlankTotal(totals.plankSeconds), "PLANK"],
      ].forEach(([value, label], i) => {
        const x = W / 2 + (i - 1) * 330;
        ctx.fillStyle = style.text;
        ctx.font = font(76, 800);
        ctx.fillText(value, x, 1650);
        ctx.fillStyle = style.subtext;
        ctx.font = font(40, 700);
        ctx.fillText(label, x, 1705);
      });
    }
    if (logo) {
      ctx.drawImage(logo, W / 2 - 150, 1750, 300, 90);
    } else {
      ctx.fillStyle = style.text;
      ctx.font = font(64, 800);
      ctx.fillText("Forja", W / 2, 1818);
    }
  });
}

// The History calendar's moon (style.css .calendar-day.rest::after): a 9px
// circle in the top-right corner of a ~44px day, of which only its shadow
// (offset -2.5, 1.5, turned -20 degrees) shows - scaled to `size`.
function drawRestMark(ctx, x, y, size, color) {
  const k = size / 44;
  const r = 4.5 * k;
  ctx.save();
  ctx.translate(x + size - 4 * k - r, y + 4 * k + r);
  ctx.rotate((-20 * Math.PI) / 180);
  ctx.beginPath();
  ctx.rect(-size, -size, size * 2, size * 2);
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip("evenodd");
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(-2.5 * k, 1.5 * k, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// "45m", "6h 16m".
function formatPlankTotal(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// The streak's days, oldest first, ending today: logged days ("day") and
// the rest days between them ("rest"), until `count` logged days.
function streakDays(count) {
  const logged = new Set(data.history);
  const rest = restDaySet();
  const days = [];
  const day = new Date();
  let found = 0;
  for (let guard = 0; found < count && guard < 1000; guard++) {
    const key = dateToString(day);
    if (logged.has(key)) {
      days.push("day");
      found++;
    } else if (rest.has(key)) {
      days.push("rest");
    } else if (days.length) {
      break;
    }
    day.setDate(day.getDate() - 1);
  }
  return days.reverse();
}

// Push-ups, squats and plank seconds from every verified set since `fromDay`
// (signed in only; the server keeps them). null when they can't be read.
async function streakTotals(fromDay) {
  if (!currentUserId) return null;
  const totals = { pushups: 0, squats: 0, plankSeconds: 0 };
  const PAGE = 1000;
  for (let from = 0; from < 20000; from += PAGE) {
    const { data: rows, error } = await supabaseClient
      .from("verified_sets")
      .select("exercise, value")
      .eq("user_id", currentUserId)
      .gte("day", fromDay)
      .order("created_at")
      .range(from, from + PAGE - 1);
    if (error) return null;
    for (const row of rows) {
      if (row.exercise === "pushup") totals.pushups += Number(row.value) || 0;
      else if (row.exercise === "squat") totals.squats += Number(row.value) || 0;
      else if (row.exercise === "plank") totals.plankSeconds += Number(row.value) || 0;
    }
    if (rows.length < PAGE) break;
  }
  return totals;
}

// From the celebration's Share My Streak button (celebrations.js).
async function openMilestoneShare(count) {
  const days = streakDays(count);
  shareRoute.kind = "streak";
  shareRoute.streak = { count, days, totals: null };
  setShareBack("Today", "Back to Today");
  document.getElementById("share-route-heading").textContent = "Share streak";
  showScreen("share-route-screen");
  pickShareTemplate(shareRoute.template);
  const daysBack = new Date();
  daysBack.setDate(daysBack.getDate() - days.length + 1);
  const totals = await streakTotals(dateToString(daysBack));
  if (totals && shareRoute.kind === "streak" && shareRoute.streak.count === count) {
    shareRoute.streak.totals = totals;
    renderShareImage();
  }
}

function setShareBack(label, ariaLabel) {
  const back = document.getElementById("share-route-back");
  back.lastChild.textContent = label;
  back.setAttribute("aria-label", ariaLabel);
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png");
    } catch (error) {
      reject(error);
    }
  });
}

// Draws the preview and makes the file the Share button hands over. A newer
// draw (another style tapped) wins over a slower older one.
async function renderShareImage() {
  const drawId = ++shareRoute.drawId;
  const style = SHARE_TEMPLATES[shareRoute.template];
  shareRoute.file = null;
  shareRouteButtonEl.disabled = true;
  shareRouteCopyEl.disabled = true;
  const ctx = shareRouteCanvasEl.getContext("2d");
  const isStreak = shareRoute.kind === "streak";
  const [logo, pet] = await Promise.all([shareLogoImage(style.text), isStreak ? sharePet() : null]);
  if (drawId !== shareRoute.drawId) return;
  drawShareImage(ctx, style, logo, pet);
  let blob;
  try {
    blob = await canvasToPng(shareRouteCanvasEl);
  } catch (error) {
    // Some browsers won't export a canvas an SVG image was drawn on - then
    // the word goes in as plain text instead (and the card goes without
    // the pet).
    drawShareImage(ctx, style, null, null);
    blob = await canvasToPng(shareRouteCanvasEl).catch(() => null);
  }
  if (drawId !== shareRoute.drawId || !blob) return;
  const name = isStreak ? `streak-${shareRoute.streak.count}` : shareIsRun() ? "run" : "walk";
  shareRoute.file = new File([blob], `forja-${name}.png`, { type: "image/png" });
  shareRouteButtonEl.disabled = false;
  shareRouteCopyEl.disabled = false;
}

function pickShareTemplate(template) {
  shareRoute.template = template;
  document.querySelectorAll("#share-route-templates button").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.template === template));
  });
  document.getElementById("share-route-preview").dataset.template = template;
  const sticker = template === "sticker";
  shareRouteCopyEl.classList.toggle("hidden", !(sticker && canCopyImage));
  const note = document.getElementById("share-route-note");
  note.textContent = canCopyImage ? "Copy, then paste it on your photo in an Instagram story." : "See-through: save it, then add it over a photo in Instagram.";
  note.classList.toggle("invisible", !sticker);
  renderShareImage();
}

document.getElementById("tracking-summary-share-button").addEventListener("click", () => {
  shareRoute.kind = "route";
  setShareBack("Route", "Back to the route");
  document.getElementById("share-route-heading").textContent = shareIsRun() ? "Share run" : "Share walk";
  showScreen("share-route-screen");
  pickShareTemplate(shareRoute.template);
});

document.getElementById("share-route-templates").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-template]");
  if (button) pickShareTemplate(button.dataset.template);
});

document.getElementById("share-route-back").addEventListener("click", () => {
  if (shareRoute.kind === "streak") {
    showScreen("app-screen");
    return;
  }
  showScreen("tracking-summary-screen");
  if (summaryMap) summaryMap.invalidateSize();
});

shareRouteButtonEl.addEventListener("click", async () => {
  const file = shareRoute.file;
  if (!file) return;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      // Closing the share sheet lands here too - nothing to do.
    }
    return;
  }
  // No share sheet (most computers): save the image instead.
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Like share, the copy has to start right inside the tap (iPhone rule).
// In Instagram, a pasted image becomes a sticker you can move and resize.
let shareCopyResetTimer = null;
shareRouteCopyEl.addEventListener("click", async () => {
  const file = shareRoute.file;
  if (!file) return;
  const label = shareRouteCopyEl.querySelector("span");
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": file })]);
    label.textContent = "Copied";
  } catch (error) {
    label.textContent = "Couldn't copy";
  }
  clearTimeout(shareCopyResetTimer);
  shareCopyResetTimer = setTimeout(() => (label.textContent = "Copy"), 2000);
});

// The Today tab's small GPS button just takes you to the Record tab,
// where the actual map/tracking UI lives - one tracking experience, not
// two separate implementations to maintain.
startTrackingButtonEl.addEventListener("click", () => showTab("record"));

const recordStartButtonEl = document.getElementById("record-start-button");
recordStartButtonEl.addEventListener("click", startTracking);

// "Today", "Yesterday", "Wed, Oct 7" - with the year only when it isn't
// this year ("Aug 17, 2025").
function friendlyRouteDate(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const daysAgo = daysBetween(dateStr, todayString());
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  const thisYear = year === new Date().getFullYear();
  return date.toLocaleDateString(undefined, thisYear ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

function buildPastRouteRow(route) {
  const row = document.createElement("div");
  row.className = "leaderboard-row";

  row.innerHTML = `
    <span class="leaderboard-name"></span>
    <span class="leaderboard-streak"></span>
  `;
  row.querySelector(".leaderboard-name").textContent = friendlyRouteDate(route.date);

  const distanceInUnits = data.units === "km" ? route.distanceKm : milesFromKm(route.distanceKm);
  row.querySelector(".leaderboard-streak").textContent =
    `${distanceInUnits.toFixed(1)} ${distanceUnitLabel()} · ${formatDuration(route.durationMs)}`;

  row.addEventListener("click", () => {
    const points = route.encodedRoute ? decodePolyline(route.encodedRoute) : [];
    showTrackingSummary(points, route.distanceKm, route.durationMs, route.elevationGainM || 0, "view");
  });

  return row;
}

// Shows every kept route, most recent first - this is what actually
// makes the permanent route history useful instead of just sitting
// unseen in the database.
function renderPastRoutesList() {
  const listEl = document.getElementById("past-routes-list");
  const emptyEl = document.getElementById("past-routes-empty");

  listEl.innerHTML = "";

  if (data.routes.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");

  // Sorted by date (not trusted to be stored in order - routes can arrive
  // from other devices). [...array] copies it, so the stored order stays
  // put; reversing first keeps same-day walks newest first.
  const mostRecentFirst = [...data.routes].reverse().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  mostRecentFirst.forEach((route) => {
    listEl.appendChild(buildPastRouteRow(route));
  });
}


// STEP 8: Register the service worker, if the browser supports one.
// "serviceWorker" in navigator is a feature check - older browsers that
// don't support service workers simply skip this without erroring.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js");
  });
}

// STEP 9: Stay on the newest version. A Home Screen app can sit in the
// background for days, still running the code it opened with - while the
// server functions it talks to have moved on. Every time Forja comes back
// to the front it reads the live index.html: if any file's ?v= number
// differs from what's running, a new version is out and the app reloads.
// Only at a calm moment, though - never mid-set, mid-walk, mid-sign-up or
// while typing; otherwise it tries again the next time it comes back.
const VERSIONED_FILE = /([\w./-]+\.(?:js|css))\?v=(\d+)/g;
const versionsIn = (text) => [...text.matchAll(VERSIONED_FILE)].map((match) => match[0]).sort().join(" ");
// Read when checking, not now: the files after this one aren't on the page yet.
const runningVersions = () =>
  versionsIn([...document.querySelectorAll("script[src], link[rel='stylesheet'][href]")].map((el) => el.getAttribute("src") || el.getAttribute("href")).join(" "));
const UPDATE_RELOAD_KEY = "forja-reloaded-for";
let lastUpdateCheck = 0;

function calmMomentToReload() {
  const typing = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
  return (
    session === null &&
    !savingDay &&
    !typing &&
    !document.getElementById("app-screen").classList.contains("hidden") &&
    !document.querySelector(".celebrate-screen, #load-error-screen") &&
    !Onboarding.isActive()
  );
}

async function checkForUpdate() {
  if (document.visibilityState !== "visible" || Date.now() - lastUpdateCheck < 60000) return;
  lastUpdateCheck = Date.now();
  let live;
  try {
    const response = await fetch("./index.html", { cache: "no-store" });
    if (!response.ok) return;
    live = versionsIn(await response.text());
  } catch (e) {
    return; // offline - check again next time
  }
  if (!live || live === runningVersions()) return;
  // Already reloaded once for this exact version and still not on it (the
  // reload got an old copy) - don't loop; the next app start picks it up.
  try {
    if (sessionStorage.getItem(UPDATE_RELOAD_KEY) === live) return;
  } catch (e) {
    // storage blocked - a reload is still fine
  }
  if (!calmMomentToReload()) {
    lastUpdateCheck = 0;
    return;
  }
  try {
    sessionStorage.setItem(UPDATE_RELOAD_KEY, live);
  } catch (e) {
    // storage blocked
  }
  location.reload();
}

document.addEventListener("visibilitychange", checkForUpdate);
