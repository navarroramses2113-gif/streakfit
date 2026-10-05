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

// `supabase` (lowercase, no "Client") is the global the CDN script tag
// creates. We name OUR instance `supabaseClient` so the two don't clash.
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Which user is currently logged in, and their data. Both start out
// empty - they only get filled in once we hear back from Supabase about
// who (if anyone) is signed in.
let currentUserId = null;
let data = null;

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
async function loadUserData(userId) {
  const { data: row } = await supabaseClient
    .from("user_progress")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle(); // returns null instead of an error if no row exists yet

  if (row) {
    return { data: migrateData(row.data), isNewAccount: false };
  }

  // Brand new account - seed it from any existing local progress, or
  // plain defaults if there isn't any.
  const initialData = loadLocalData() || defaultData();
  await saveUserData(userId, initialData);
  return { data: initialData, isNewAccount: true };
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
const logButtonEl = document.getElementById("log-button");
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
function setSegmentProgress(ring, startOffset, span, fraction) {
  const trackLength = Math.max(span - RING_SEGMENT_GAP, 0);
  const clamped = Math.max(0, Math.min(1, fraction));
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
const unitsRowEl = document.getElementById("units-row");
const distanceUnitsEl = document.getElementById("distance-units");
const saveSettingsEl = document.getElementById("save-settings");

// Shows/hides the minutes input in Settings the instant the checkbox is
// toggled, without waiting for Save - so it's obvious what you're about
// to configure.
enableWalkrunEl.addEventListener("change", () => {
  minWalkrunRowEl.classList.toggle("hidden", !enableWalkrunEl.checked);
  unitsRowEl.classList.toggle("hidden", !enableWalkrunEl.checked);
});

// STEP 2b: Account menu on the Me tab - Edit Profile, Share Profile,
// and a Settings toggle that just reveals the existing Daily Minimums
// panel (a full standalone Settings section is planned for later).

const editProfilePanelEl = document.getElementById("edit-profile-panel");
const settingsPanelEl = document.getElementById("settings-panel");

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

themeSelectEl.addEventListener("change", () => {
  applyTheme(themeSelectEl.value);
  try {
    localStorage.setItem("forja-theme", themeSelectEl.value);
  } catch (e) {
    // Storage blocked (private browsing etc.) - the theme still applies
    // for this session, it just won't be remembered.
  }
});

document.getElementById("open-settings-button").addEventListener("click", () => {
  editProfilePanelEl.classList.add("hidden");
  settingsPanelEl.classList.toggle("hidden");
  if (!settingsPanelEl.classList.contains("hidden")) refreshRemindersToggle();
});

document.getElementById("edit-profile-button").addEventListener("click", async () => {
  settingsPanelEl.classList.add("hidden");
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
    .select("username")
    .eq("user_id", currentUserId)
    .maybeSingle();

  if (profile) {
    myUsername = profile.username;
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
  unitsRowEl.classList.toggle("hidden", !walkRunEnabled);
  distanceUnitsEl.value = data.units;
}

saveSettingsEl.addEventListener("click", () => {
  // Minimums can be raised, never lowered below the game's floors -
  // otherwise someone could rank on a day that asks for 1 push-up.
  data.minimums.pushups = Math.max(Number(minPushupsEl.value) || 0, ForjaRules.FLOORS.pushups);
  data.minimums.planks = Math.max(Number(minPlanksEl.value) || 0, ForjaRules.FLOORS.planks);
  data.minimums.squats = Math.max(Number(minSquatsEl.value) || 0, ForjaRules.FLOORS.squats);
  data.minimums.walkRun = enableWalkrunEl.checked ? (Number(minWalkrunEl.value) || 1) : null;
  data.units = distanceUnitsEl.value;

  saveData(data);
  renderMinTags();
  render();
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
});

reminderHourEl.addEventListener("change", () => {
  data.reminderHour = Number(reminderHourEl.value);
  // Timezones aren't permanent - re-capturing it here as well means
  // someone who's since traveled gets corrected the next time they touch
  // this setting, not just the first time they ever enabled it.
  data.reminderTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  saveData(data);
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

  const progress = todayProgress();
  if (exerciseKey === "pushup") progress.pushups += value;
  else if (exerciseKey === "squat") progress.squats += value;
  else if (exerciseKey === "plank") progress.planks = Math.max(progress.planks, value);
  else return;

  progress.sets.push({ exercise: exerciseKey, value, at: new Date().toISOString() });
  saveData(data);
  render();
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
// just kept locally.
async function saveCameraSet({ exercise, value, trace }) {
  if (!currentUserId) {
    recordVerifiedSet(exercise, value);
    return { ok: true, value };
  }
  const reply = await callServerFunction("submit-set", { trace, day: todayString() });
  if (!reply.ok) return { ok: false, error: serverErrorMessage(reply) };
  await refreshVerifiedProgress();
  return { ok: true, value: reply.value };
}

// Updates everything visible on the page to match the current `data`.
function render() {
  streakCountEl.textContent = data.streak;
  bestStreakCountEl.textContent = data.bestStreak;

  const progress = todayProgress();
  pushupsEl.value = progress.pushups;
  planksEl.value = progress.planks;
  squatsEl.value = progress.squats;
  walkrunEl.value = progress.walkRun;

  const loggedToday = data.lastLoggedDate === todayString();

  if (loggedToday) {
    statusMessageEl.textContent = "Nice work! You're done for today.";
    logButtonEl.disabled = true;
    logButtonEl.textContent = "Completed Today";
  } else {
    statusMessageEl.textContent = "Verify each exercise with the camera, then log today's workout.";
    logButtonEl.disabled = false;
    logButtonEl.textContent = "Log Today's Workout";
  }

  updateRings(loggedToday);

  document.querySelectorAll(".verify-button").forEach((button) => {
    button.disabled = loggedToday;
  });

  const walkRunEnabled = data.minimums.walkRun !== null;
  walkrunRowEl.classList.toggle("hidden", !walkRunEnabled);
  startTrackingButtonEl.disabled = loggedToday;

  const beforeReset = data.weekStartDate;
  refreshRestDayWeek();
  if (data.weekStartDate !== beforeReset) {
    saveData(data);
  }
  renderGraceStatus();
}

// Number of days between two "YYYY-MM-DD" strings (dateStr2 - dateStr1).
function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

// You get this many missed days forgiven per rolling 7-day window.
const REST_DAYS_PER_WEEK = 2;

// If more than 7 days have passed since we started counting rest days,
// start a fresh week: reset the counter back to 0.
function refreshRestDayWeek() {
  const today = todayString();

  if (!data.weekStartDate || daysBetween(data.weekStartDate, today) >= 7) {
    data.weekStartDate = today;
    data.restDaysUsed = 0;
  }
}

function renderGraceStatus() {
  const restDaysCountEl = document.getElementById("rest-days-count");
  restDaysCountEl.textContent = REST_DAYS_PER_WEEK - data.restDaysUsed;
}

document.querySelectorAll(".verify-button").forEach((button) => {
  button.addEventListener("click", () => {
    const exerciseKey = button.dataset.exercise;
    ForjaCamera.open(exerciseKey, saveCameraSet);
  });
});

// Builds the "last 12 weeks" grid of small squares, one per day, colored
// based on whether that day is in data.history.
function renderHeatmap() {
  const heatmapEl = document.getElementById("heatmap");

  // Clear out anything already there before rebuilding it from scratch.
  heatmapEl.innerHTML = "";

  const totalDays = 56; // 8 weeks * 7 days

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
    }

    // The "title" attribute shows as a small tooltip when you hover.
    cell.title = dateStr;

    heatmapEl.appendChild(cell);
  }
}

// Weekly distance line chart - a single series (your own distance), so
// one consistent color throughout and no legend needed. Aggregates
// data.routes (every KEPT route) into 8 weekly totals, oldest to newest,
// matching the heatmap's 8-week window.

function weeklyDistanceBuckets() {
  const WEEKS = 8;
  const buckets = [];

  for (let weeksAgo = WEEKS - 1; weeksAgo >= 0; weeksAgo--) {
    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() - weeksAgo * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 6);

    const weekStartStr = dateToString(weekStart);
    const weekEndStr = dateToString(weekEnd);

    // "YYYY-MM-DD" strings compare correctly with plain >= / <= since
    // that format sorts the same alphabetically as chronologically.
    const distanceKm = data.routes
      .filter((entry) => entry.date >= weekStartStr && entry.date <= weekEndStr)
      .reduce((total, entry) => total + entry.distanceKm, 0);

    buckets.push({ weekStartStr, weekEndStr, distanceKm });
  }

  return buckets;
}

function renderDistanceChart() {
  const svg = document.getElementById("distance-chart");
  const detailEl = document.getElementById("distance-chart-detail");
  svg.innerHTML = "";

  const buckets = weeklyDistanceBuckets();
  const values = buckets.map((b) => (data.units === "km" ? b.distanceKm : milesFromKm(b.distanceKm)));
  const maxValue = Math.max(...values, 1); // avoids dividing by zero when nothing's been tracked yet

  const chartWidth = 130;
  const chartHeight = 100;
  const topPadding = 10;
  const bottomPadding = 15;
  const plotHeight = chartHeight - topPadding - bottomPadding;
  const stepX = chartWidth / (buckets.length - 1);

  const points = values.map((value, index) => ({
    x: index * stepX,
    y: topPadding + plotHeight - (value / maxValue) * plotHeight,
  }));

  // SVG elements need to be created with this special "namespace"
  // method (createElementNS), not the regular createElement we use
  // everywhere else - plain HTML elements don't need one, but SVG does.
  const SVG_NS = "http://www.w3.org/2000/svg";

  const baseline = document.createElementNS(SVG_NS, "line");
  baseline.setAttribute("x1", "0");
  baseline.setAttribute("x2", String(chartWidth));
  baseline.setAttribute("y1", String(chartHeight - bottomPadding));
  baseline.setAttribute("y2", String(chartHeight - bottomPadding));
  baseline.setAttribute("class", "distance-chart-baseline");
  svg.appendChild(baseline);

  const polyline = document.createElementNS(SVG_NS, "polyline");
  polyline.setAttribute("points", points.map((p) => `${p.x},${p.y}`).join(" "));
  polyline.setAttribute("class", "distance-chart-line");
  svg.appendChild(polyline);

  function showWeekDetail(bucket, value) {
    const label = new Date(bucket.weekStartStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    detailEl.textContent = `Week of ${label}: ${value.toFixed(1)} ${distanceUnitLabel()}`;
  }

  points.forEach((point, index) => {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(point.x));
    dot.setAttribute("cy", String(point.y));
    dot.setAttribute("r", "2.5");
    dot.setAttribute("class", "distance-chart-dot");
    svg.appendChild(dot);

    // A bigger invisible circle on top of the visible dot - an actual
    // 5px-wide dot is too small to reliably tap on a phone, so the real
    // click target is larger than what you see.
    const hitArea = document.createElementNS(SVG_NS, "circle");
    hitArea.setAttribute("cx", String(point.x));
    hitArea.setAttribute("cy", String(point.y));
    hitArea.setAttribute("r", "9");
    hitArea.setAttribute("class", "distance-chart-hit");
    hitArea.addEventListener("click", () => showWeekDetail(buckets[index], values[index]));
    svg.appendChild(hitArea);
  });

  // Show the most recent week's stats by default, so this line isn't
  // just blank until you tap something.
  showWeekDetail(buckets[buckets.length - 1], values[values.length - 1]);
}

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

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = dateToString(new Date(year, month, day));

    const cell = document.createElement("div");
    cell.className = "calendar-day";
    if (data.history.includes(dateStr)) {
      cell.classList.add("completed");
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

// A pool of messages to rotate through. Feel free to edit/add your own.
const MOTIVATIONS = [
  "Discipline is choosing between what you want now and what you want most.",
  "You don't have to be great to start, but you have to start to be great.",
  "Small daily wins compound into results that feel impossible in advance.",
  "The streak isn't the goal - it's proof you're becoming someone new.",
  "Motivation gets you started. The streak is what keeps you going.",
  "Nobody regrets the workout they finished. Get today's reps in.",
  "Consistency beats intensity. Show up today, even if it's the bare minimum.",
  "Future you is built entirely out of what present you decides right now.",
];

// Returns which day of the year it is (1 = Jan 1st, 365/366 = Dec 31st).
// We use this as a stable "seed" so the message is the same all day but
// changes tomorrow, instead of picking a random one on every refresh.
function dayOfYear(date) {
  const startOfYear = new Date(date.getFullYear(), 0, 0);
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((date - startOfYear) / msPerDay);
}

function renderMotivation() {
  const motivationEl = document.getElementById("motivation-message");
  const index = dayOfYear(new Date()) % MOTIVATIONS.length;
  motivationEl.textContent = MOTIVATIONS[index];
}

// Fades the splash screen out - guarded so it only ever runs once, and
// wrapped in a brief timeout so it displays for at least a fraction of a
// second instead of flashing away instantly if things resolved quickly.
let splashHidden = false;
function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  setTimeout(() => {
    document.getElementById("splash-screen").classList.add("splash-fade-out");
  }, 500);
}

// The 4 mutually-exclusive full-screen views. Listing them once here
// means adding a 5th screen later only needs one new line, not a matching
// "hide this one" line added into every other show-a-different-screen
// function (which is exactly how the reset-password screen almost got
// left out of revealApp() below).
const SCREEN_IDS = ["onboarding-screen", "auth-screen", "forgot-password-screen", "reset-password-screen", "app-screen", "tracking-summary-screen", "calendar-screen", "follow-list-screen", "user-actions-screen", "account-screen", "reminder-setup-screen", "camera-screen"];

function showScreen(idToShow) {
  SCREEN_IDS.forEach((id) => {
    document.getElementById(id).classList.toggle("hidden", id !== idToShow);
  });
  hideSplash();
}

// Shows the app's main tabs and fills in every part of the page from
// whatever `data` currently holds - shared by both the logged-in path
// and the guest path below, since both end up needing the exact same
// on-screen setup once `data` is ready.
function revealApp() {
  render();
  renderHeatmap();
  renderDistanceChart();
  renderMotivation();
  renderMinTags();
  renderSettingsInputs();
  updateMeTabAuthSection();
  showScreen("app-screen");
}

// Runs once we know someone is logged in: loads their data from the
// database, then reveals the app.
async function showApp(userId) {
  currentUserId = userId;
  const result = await loadUserData(userId);
  data = result.data;
  // The streak and today's verified totals belong to the server - pull
  // them in before the first draw so nothing shows a stale local copy.
  await Promise.all([loadServerStats(), refreshVerifiedProgress()]);
  revealApp();
  updateFriendRequestBadge();

  // A brand new account (not a returning login) gets one chance to turn
  // on reminders right away, instead of needing to find the toggle
  // buried in Settings themselves. This can't happen during the earlier
  // guest onboarding carousel - a push subscription needs a real account
  // (a user_id) to attach to, and guests don't have one yet.
  if (result.isNewAccount) {
    showScreen("reminder-setup-screen");
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

// Lets someone use the full app without an account yet. Their data is
// only saved to this browser (via saveData's guest branch) until they
// eventually sign up, at which point loadUserData migrates it in.
function showAppAsGuest() {
  currentUserId = null;
  data = loadLocalData() || defaultData();
  revealApp();
}

// Shows/hides the right button at the bottom of the Me tab depending on
// whether you're logged in or just browsing as a guest.
function updateMeTabAuthSection() {
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

// Runs when nobody is logged in.
function showAuthScreen() {
  showScreen("auth-screen");
}

// Shown after clicking a password reset link from email.
function showResetPasswordScreen() {
  showScreen("reset-password-screen");
}

function showForgotPasswordScreen() {
  showScreen("forgot-password-screen");
}

function showOnboardingScreen() {
  showScreen("onboarding-screen");
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
  // session and fires this exact event - we need to catch it BEFORE the
  // normal "session exists -> show the app" check below, otherwise it'd
  // just drop you into the app instead of letting you set a new password.
  if (event === "PASSWORD_RECOVERY") {
    showResetPasswordScreen();
    return;
  }

  if (session) {
    justLoggedOut = false;
    showApp(session.user.id);
    return;
  }

  currentUserId = null;
  data = null;
  // Nothing from the last account's Feed may linger for whoever signs in next.
  document.getElementById("feed-list").innerHTML = "";

  if (justLoggedOut) {
    justLoggedOut = false;
    showAuthScreen();
    return;
  }

  // First-time visitors see the onboarding pitch; anyone who has already
  // seen it (including a guest just reopening the app) goes straight
  // into using the app - signing up is offered later, not upfront.
  if (localStorage.getItem("streakfit-seen-onboarding")) {
    showAppAsGuest();
  } else {
    showOnboardingScreen();
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

async function logWorkout() {
  errorMessageEl.textContent = "";

  const today = todayString();

  if (data.lastLoggedDate === today) {
    // Already logged today - button should be disabled, but guard anyway.
    return;
  }

  const progress = todayProgress();
  const pushups = progress.pushups;
  const plankSeconds = progress.planks;
  const squats = progress.squats;
  const walkRunEnabled = data.minimums.walkRun !== null;
  const walkrunMinutes = progress.walkRun;

  const missedMinimum =
    pushups < data.minimums.pushups ||
    plankSeconds < data.minimums.planks ||
    squats < data.minimums.squats ||
    (walkRunEnabled && walkrunMinutes < data.minimums.walkRun);

  if (missedMinimum) {
    let message = `You need ${data.minimums.pushups} verified push-ups, a ${data.minimums.planks}-second plank, and ${data.minimums.squats} squats`;
    if (walkRunEnabled) {
      message += `, plus ${data.minimums.walkRun} minutes of walk/run`;
    }
    errorMessageEl.textContent = message + " to log today.";

    // Retrigger the shake animation even if it's already mid-shake:
    // removing the class, forcing the browser to notice, then re-adding it.
    errorMessageEl.classList.remove("shake");
    void errorMessageEl.offsetWidth;
    errorMessageEl.classList.add("shake");
    return;
  }

  // A signed-in player's day is logged by the server, which checks ITS OWN
  // record of their verified sets before moving the streak - the numbers
  // on this screen are just a copy of what it says. A guest has no server
  // record (and isn't ranked), so their day is logged here, with the same
  // streak rules.
  let stats;
  if (currentUserId) {
    logButtonEl.disabled = true;
    logButtonEl.textContent = "Logging...";
    const reply = await callServerFunction("log-day", { day: today });
    if (!reply.ok) {
      if (reply.error === "already_logged" && reply.stats) applyStats(reply.stats);
      render();
      errorMessageEl.textContent = serverErrorMessage(reply);
      return;
    }
    stats = reply.stats;
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
  }
  applyStats(stats);

  if (!data.history.includes(today)) {
    data.history.push(today);
  }

  saveData(data);
  render();
  renderHeatmap();

  // Briefly pulse the streak number to celebrate the successful log.
  streakCountEl.classList.add("pulse");
  setTimeout(() => streakCountEl.classList.remove("pulse"), 250);

  // A guest who just logged their very first day gets invited to create
  // an account right at that "high point" - after a short pause so they
  // actually get to see the streak update first, not instead of it.
  if (!currentUserId && data.history.length === 1) {
    setTimeout(() => {
      authMode = "signup";
      applyAuthMode();
      authSubtitleEl.textContent = "Day 1 complete! Create an account to compete with friends - leaderboard streaks start fresh, so every day on it is camera-verified.";
      showAuthScreen();
    }, 1800);
  }
}

// addEventListener attaches a function to run whenever a specific event
// happens on an element - here, whenever the button is clicked.
logButtonEl.addEventListener("click", logWorkout);


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
const FLAME_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-1 4-6 6-6 12a6 6 0 0 0 12 0c0-3-2-4-2-7-1 2-2 2-2 0 0-2-1-4-2-5z"/></svg>';

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
function buildLeaderboardRow(name, streak, isYou, rank, userId) {
  const row = document.createElement("div");
  row.className = "leaderboard-row";
  if (isYou) row.classList.add("is-you");

  row.innerHTML = `
    <span class="leaderboard-rank">#${rank}</span>
    <span class="leaderboard-avatar">${PERSON_ICON_SVG}</span>
    <span class="leaderboard-name"></span>
    <span class="leaderboard-streak">${Number(streak) || 0} ${FLAME_ICON_SVG}</span>
    ${isYou ? "" : '<button class="row-options-button" aria-label="More options">&#8942;</button>'}
  `;
  row.querySelector(".leaderboard-name").textContent = name;

  if (!isYou) {
    row.querySelector(".row-options-button").addEventListener("click", () => openUserActions(userId, name, "app-screen", null));
  }

  return row;
}

function buildFriendRequestRow(friendshipId, requesterName, requesterId) {
  const row = document.createElement("div");
  row.className = "leaderboard-row";

  row.innerHTML = `
    <span class="leaderboard-avatar">${PERSON_ICON_SVG}</span>
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

  if (!myUsername) {
    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("username")
      .eq("user_id", currentUserId)
      .maybeSingle();

    if (profile) {
      myUsername = profile.username;
    }
  }

  if (!myUsername) {
    usernameSetupEl.classList.remove("hidden");
    return;
  }

  friendsSectionEl.classList.remove("hidden");
  loadFriendRequests();
  loadLeaderboard();
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
    <span class="leaderboard-avatar">${PERSON_ICON_SVG}</span>
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
    .select("user_id, username")
    .ilike("username", `${query}%`)
    .neq("user_id", currentUserId)
    .limit(8);

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
  const { data: profiles } = await supabaseClient.from("profiles").select("user_id, username").in("user_id", requesterIds);

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

  const combined = [{ name: myUsername, streak: data.streak, isYou: true, userId: currentUserId }];

  if (friendIds.length > 0) {
    // Streaks come from player_stats, which only the server can write.
    // (They used to be read out of each friend's user_progress, which the
    // friend could edit - and which also exposed their GPS routes.)
    const [{ data: profiles }, { data: statsRows }] = await Promise.all([
      supabaseClient.from("profiles").select("user_id, username").in("user_id", friendIds),
      supabaseClient.from("player_stats").select("user_id, streak").in("user_id", friendIds),
    ]);

    const usernameByUserId = {};
    (profiles || []).forEach((p) => {
      usernameByUserId[p.user_id] = p.username;
    });
    const streakByUserId = {};
    (statsRows || []).forEach((row) => {
      streakByUserId[row.user_id] = row.streak;
    });

    // Everyone who's a friend appears, even with no logged day yet (0).
    friendIds.forEach((id) => {
      combined.push({
        name: usernameByUserId[id] || "Unknown",
        streak: streakByUserId[id] || 0,
        isYou: false,
        userId: id,
      });
    });
  }

  combined.sort((a, b) => b.streak - a.streak);

  leaderboardEl.innerHTML = "";
  combined.forEach((person, index) => {
    leaderboardEl.appendChild(buildLeaderboardRow(person.name, person.streak, person.isYou, index + 1, person.userId));
  });
}

// The Feed: every day you or a friend logs shows up as a post, and friends
// can give each other kudos. Posts are written by the server when it logs
// a day (log-day), so everything here is camera-verified - the app only
// reads posts, and adds or removes its own kudos.

const FEED_DAYS_SHOWN = 14;
const FEED_MAX_POSTS = 50;
const STREAK_MILESTONES = [7, 14, 30, 50, 100, 150, 200, 365, 500, 1000];
const KUDOS_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3z"/><path d="M7 10l4-7a2.5 2.5 0 0 1 3 2.6L13.5 9H19a2 2 0 0 1 2 2.3l-1.2 7.4a2 2 0 0 1-2 1.7H7"/></svg>';

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
    showFeedMessage("Create an account to see your friends' workouts and give them kudos.", "Create Account", () => {
      authMode = "signup";
      applyAuthMode();
      showAuthScreen();
    });
    return;
  }
  // First visit: say something while it loads. Later visits keep showing
  // the last posts while the fresh ones arrive.
  if (!feedListEl.hasChildNodes()) showFeedMessage("Loading...");
  await loadFeed();
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
    .select("id, user_id, day, streak, pushups, plank_seconds, squats, new_best, created_at")
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
    const { data: profiles } = await supabaseClient.from("profiles").select("user_id, username").in("user_id", peopleIds);
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
  posts.forEach((post) => {
    const giverIds = kudosRows.filter((k) => k.event_id === post.id).map((k) => k.giver_id);
    feedListEl.appendChild(buildFeedCard(post, giverIds, usernameByUserId));
  });
}

// "Today · 7:42 PM", "Yesterday · 8:10 AM", or "Sat, Oct 3".
function feedWhenText(post) {
  const time = new Date(post.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (post.day === todayString()) return `Today · ${time}`;
  if (post.day === dateToString(yesterday)) return `Yesterday · ${time}`;
  const [year, month, day] = post.day.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function feedHeadline(post) {
  const streak = Number(post.streak) || 0;
  if (STREAK_MILESTONES.includes(streak)) return `Hit a ${streak}-day streak`;
  if (post.new_best) return `New personal best: ${streak} days`;
  if (streak === 1) return "Started a new streak";
  return `Day ${streak} of the streak`;
}

// "You and ana gave kudos", "ana, ben and 3 others gave kudos".
function kudosSummaryText(names) {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} gave kudos`;
  if (names.length === 2) return `${names[0]} and ${names[1]} gave kudos`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} gave kudos`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others gave kudos`;
}

// Usernames come from other people, so - like the leaderboard - every bit of
// text goes in through textContent, and only fixed markup goes in innerHTML.
function buildFeedCard(post, giverIds, usernameByUserId) {
  const isMine = post.user_id === currentUserId;
  const card = document.createElement("article");
  card.className = "feed-card";
  if (isMine) card.classList.add("is-you");

  card.innerHTML = `
    <div class="feed-card-header">
      <span class="leaderboard-avatar">${PERSON_ICON_SVG}</span>
      <div class="feed-card-who">
        <span class="feed-card-name"></span>
        <span class="feed-card-when"></span>
      </div>
      <span class="leaderboard-streak">${Number(post.streak) || 0} ${FLAME_ICON_SVG}</span>
    </div>
    <p class="feed-card-headline"></p>
    <div class="feed-card-stats">
      <div class="feed-stat"><span class="feed-stat-value" data-stat="pushups"></span><span class="feed-stat-label">push-ups</span></div>
      <div class="feed-stat"><span class="feed-stat-value" data-stat="squats"></span><span class="feed-stat-label">squats</span></div>
      <div class="feed-stat"><span class="feed-stat-value" data-stat="plank"></span><span class="feed-stat-label">plank</span></div>
    </div>
    <div class="feed-card-footer">
      ${isMine ? "" : `<button class="kudos-button" aria-pressed="false">${KUDOS_ICON_SVG}<span>Kudos</span></button>`}
      <span class="kudos-summary"></span>
    </div>
  `;
  card.querySelector(".feed-card-name").textContent = isMine ? "You" : usernameByUserId[post.user_id] || "Unknown";
  card.querySelector(".feed-card-when").textContent = feedWhenText(post);
  card.querySelector(".feed-card-headline").textContent = feedHeadline(post);
  card.querySelector('[data-stat="pushups"]').textContent = Number(post.pushups) || 0;
  card.querySelector('[data-stat="squats"]').textContent = Number(post.squats) || 0;
  card.querySelector('[data-stat="plank"]').textContent = formatDuration((Number(post.plank_seconds) || 0) * 1000);

  // Everyone who gave kudos, with you first.
  const kudos = { iGave: giverIds.includes(currentUserId), others: giverIds.filter((id) => id !== currentUserId), busy: false };
  const button = card.querySelector(".kudos-button");
  const summaryEl = card.querySelector(".kudos-summary");

  const drawKudos = () => {
    const names = [...(kudos.iGave ? ["You"] : []), ...kudos.others.map((id) => usernameByUserId[id] || "Someone")];
    summaryEl.textContent = kudosSummaryText(names);
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

  if (!currentUserId) {
    headerEl.classList.add("hidden");
    promptEl.classList.add("hidden");
    return;
  }

  if (!myUsername) {
    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("username")
      .eq("user_id", currentUserId)
      .maybeSingle();
    if (profile) myUsername = profile.username;
  }

  if (!myUsername) {
    headerEl.classList.add("hidden");
    promptEl.classList.remove("hidden");
    return;
  }

  promptEl.classList.add("hidden");
  headerEl.classList.remove("hidden");
  document.getElementById("profile-header-username").textContent = `@${myUsername}`;

  await loadFollowCounts();
}

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
    const { data: profiles } = await supabaseClient.from("profiles").select("user_id, username").in("user_id", friendIds);
    (profiles || []).forEach((profile) => {
      const row = document.createElement("div");
      row.className = "leaderboard-row";
      row.innerHTML = `
        <span class="leaderboard-avatar">${PERSON_ICON_SVG}</span>
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


// STEP 6: The onboarding carousel (shown once, before the first login).
//
// Slides 0-2 are the value-prop pitch, navigated with the shared "Next"
// button. Slides 3-4 are questions where tapping an answer both records
// it AND advances - so the shared Next button is hidden for those.

const onboardingSlides = document.querySelectorAll(".onboarding-slide");
const onboardingDots = document.querySelectorAll(".onboarding-dot");
const onboardingNextEl = document.getElementById("onboarding-next");

const FIRST_CHOICE_SLIDE = 3;
let currentOnboardingSlide = 0;

function showOnboardingSlide(index) {
  // .forEach on a NodeList (what querySelectorAll returns) works just
  // like it does on a real array - runs the given function once per item.
  onboardingSlides.forEach((slide, i) => {
    slide.classList.toggle("hidden", i !== index);
  });
  onboardingDots.forEach((dot, i) => {
    dot.classList.toggle("active", i === index);
  });
  onboardingNextEl.classList.toggle("hidden", index >= FIRST_CHOICE_SLIDE);
}

onboardingNextEl.addEventListener("click", () => {
  currentOnboardingSlide += 1;
  showOnboardingSlide(currentOnboardingSlide);
});

// Starting minimums per fitness level - chosen on the first question slide.
const FITNESS_LEVELS = {
  beginner: { pushups: 5, planks: 20, squats: 10 },
  intermediate: { pushups: 15, planks: 45, squats: 20 },
  advanced: { pushups: 30, planks: 90, squats: 40 },
};

let selectedFitnessLevel = "beginner";

document.querySelectorAll(".onboarding-choice[data-level]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedFitnessLevel = button.dataset.level;
    currentOnboardingSlide = FIRST_CHOICE_SLIDE + 1;
    showOnboardingSlide(currentOnboardingSlide);
  });
});

document.querySelectorAll(".onboarding-choice[data-walkrun]").forEach((button) => {
  button.addEventListener("click", () => {
    finishOnboarding(button.dataset.walkrun === "yes");
  });
});

// Builds the guest's actual starting data from their two answers, saves
// it as this browser's local data, then drops them into the app - same
// mechanism showAppAsGuest() always uses, just pre-seeded instead of
// starting from plain defaults.
function finishOnboarding(wantsWalkRun) {
  localStorage.setItem("streakfit-seen-onboarding", "true");

  const initial = defaultData();
  initial.minimums = {
    ...FITNESS_LEVELS[selectedFitnessLevel],
    walkRun: wantsWalkRun ? 15 : null,
  };
  localStorage.setItem("streakfit-data", JSON.stringify(initial));

  showAppAsGuest();
}


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
// Every kept route is stored forever now (matching what real fitness
// apps like Strava do - your history is a core feature, not something
// to prune). What keeps that cheap is storing each route in a heavily
// compressed form instead of raw GPS points: first DROP nearly-redundant
// points that don't change the route's shape (Douglas-Peucker), then
// pack what's left into a single short string (Google's "Encoded
// Polyline" format - the same technique Google Maps and most mapping
// tools use). A route that might otherwise be 500 verbose {lat,lng}
// objects becomes a few dozen points encoded as one compact string.

// How far a point can deviate from a straight line before it's considered
// meaningful enough to keep, in degrees (~4 meters). Bigger = smaller
// files but a blockier-looking route; smaller = more faithful but larger.
const ROUTE_SIMPLIFY_TOLERANCE = 0.00004;

function perpendicularDistance(point, lineStart, lineEnd) {
  const [px, py] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }

  // Project the point onto the line, clamped to the segment itself.
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const nearestX = x1 + t * dx;
  const nearestY = y1 + t * dy;
  return Math.sqrt((px - nearestX) ** 2 + (py - nearestY) ** 2);
}

// Douglas-Peucker: recursively keeps only the points that meaningfully
// change the route's shape, dropping the ones that fall almost exactly
// on a straight line between their neighbors.
function simplifyRoute(points, tolerance) {
  if (points.length <= 2) return points;

  let maxDistance = 0;
  let splitIndex = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      splitIndex = i;
    }
  }

  if (maxDistance > tolerance) {
    const left = simplifyRoute(points.slice(0, splitIndex + 1), tolerance);
    const right = simplifyRoute(points.slice(splitIndex), tolerance);
    return left.slice(0, -1).concat(right); // avoid duplicating the shared middle point
  }

  return [points[0], points[points.length - 1]];
}

// Google's Encoded Polyline format: each point is stored as the small
// DIFFERENCE from the previous point (GPS points move only a little
// between samples), using a base64-like variable-length encoding so
// small differences take just 1-2 characters instead of a full number.
function encodeNumber(num) {
  let value = num << 1;
  if (num < 0) value = ~value;
  let output = "";
  while (value >= 0x20) {
    output += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }
  return output + String.fromCharCode(value + 63);
}

function encodePolyline(points) {
  let output = "";
  let prevLat = 0;
  let prevLng = 0;

  points.forEach(([lat, lng]) => {
    const lat5 = Math.round(lat * 1e5);
    const lng5 = Math.round(lng * 1e5);
    output += encodeNumber(lat5 - prevLat) + encodeNumber(lng5 - prevLng);
    prevLat = lat5;
    prevLng = lng5;
  });

  return output;
}

function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
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

function createMap(containerId) {
  const map = L.map(containerId);
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
}

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

trackingCancelEl.addEventListener("click", () => {
  stopTrackingWatchers();
  resetRecordToIdle();
});

// Holds the just-finished route until the user decides on the summary
// screen whether to actually keep it - saving happens only if they do.
let pendingRoute = null;

trackingFinishEl.addEventListener("click", () => {
  stopTrackingWatchers();

  const durationMs = elapsedTrackingMs();
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
  const { route, distanceKm, elevationGainM } = session;

  // The GPS track is the verification for walk/run, but GPS alone can't
  // tell walking from sitting with the tracker running - so the minutes
  // only count if the route actually covered ground at walking pace or
  // faster. This counts toward today regardless of whether the route
  // itself gets kept or discarded afterward.
  const MIN_WALK_KMH = 2.5;
  const averageKmh = durationMs > 0 ? distanceKm / (durationMs / 3600000) : 0;
  const countsTowardToday = averageKmh >= MIN_WALK_KMH && data.lastLoggedDate !== todayString();
  if (countsTowardToday) {
    todayProgress().walkRun += durationMinutes;
    saveData(data);
  }
  render();

  pendingRoute = { date: todayString(), distanceKm, durationMs, route, elevationGainM };

  resetRecordToIdle();
  showTrackingSummary(route, distanceKm, durationMs, elevationGainM, "new");
  if (!countsTowardToday && data.lastLoggedDate !== todayString()) {
    document.getElementById("tracking-summary-heading").textContent = "Too slow to count toward today - walk/run minutes need real movement.";
  }
});

// mode is "new" (just finished tracking - shows the Keep/Discard prompt)
// or "view" (browsing an already-saved route from Past Routes - shows a
// plain Close button instead, since there's nothing left to decide).
function showTrackingSummary(route, distanceKm, durationMs, elevationGainM, mode) {
  document.getElementById("tracking-summary-heading").textContent = mode === "view" ? "Route Detail" : "Nice work!";
  document.getElementById("keep-discard-section").classList.toggle("hidden", mode === "view");
  document.getElementById("tracking-summary-close-button").classList.toggle("hidden", mode !== "view");

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

document.getElementById("keep-route-button").addEventListener("click", () => {
  // Simplify (drop near-redundant points) then encode (pack into one
  // compact string) before saving - this is what makes it reasonable to
  // keep every route forever instead of pruning old ones.
  const simplified = simplifyRoute(pendingRoute.route, ROUTE_SIMPLIFY_TOLERANCE);
  data.routes.push({
    date: pendingRoute.date,
    distanceKm: pendingRoute.distanceKm,
    durationMs: pendingRoute.durationMs,
    elevationGainM: pendingRoute.elevationGainM || 0,
    encodedRoute: encodePolyline(simplified),
  });
  pendingRoute = null;
  saveData(data);

  renderPastRoutesList();
  renderDistanceChart();
  showScreen("app-screen");
});

document.getElementById("discard-route-button").addEventListener("click", () => {
  pendingRoute = null;
  showScreen("app-screen");
});

document.getElementById("tracking-summary-close-button").addEventListener("click", () => {
  showScreen("app-screen");
});

// The Today tab's small GPS button just takes you to the Record tab,
// where the actual map/tracking UI lives - one tracking experience, not
// two separate implementations to maintain.
startTrackingButtonEl.addEventListener("click", () => showTab("record"));

const recordStartButtonEl = document.getElementById("record-start-button");
recordStartButtonEl.addEventListener("click", startTracking);

function buildPastRouteRow(route) {
  const row = document.createElement("div");
  row.className = "leaderboard-row";

  row.innerHTML = `
    <span class="leaderboard-name"></span>
    <span class="leaderboard-streak"></span>
  `;
  row.querySelector(".leaderboard-name").textContent = route.date;

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

  // [...array] copies the array so reverse() doesn't scramble the
  // original stored order.
  const mostRecentFirst = [...data.routes].reverse();
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
