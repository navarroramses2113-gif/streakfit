// STEP 1: Connect to Supabase and load the signed-in user's data.
//
// Data used to live only in this browser's localStorage. Now it lives in
// a real database, so it works across devices and survives clearing your
// browser. localStorage is still read ONCE, as a one-time source to carry
// over any progress you already had into your new account.

const SUPABASE_URL = "https://wiixtjykewtqvpxqwtor.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpaXh0anlrZXd0cXZweHF3dG9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyMTI3ODIsImV4cCI6MjEwNTc4ODc4Mn0.WKij4ltTLv_qNfKrT5vO8y1tyjQk2IAdz7WYDTemS80";

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
    minimums: { pushups: 10, situps: 10, squats: 10, walkRun: null },
    restDaysUsed: 0,
    weekStartDate: null,
    units: "miles",
    lastRoute: null,
  };
}

// Fills in any fields older saved data (local OR cloud) might be missing,
// so the rest of the app can always assume every field exists. Shared by
// both data sources below instead of duplicating the same checks twice.
function migrateData(parsed) {
  if (!parsed.history) parsed.history = [];
  if (!parsed.minimums) parsed.minimums = { pushups: 10, situps: 10, squats: 10, walkRun: null };
  if (parsed.minimums.walkRun === undefined) parsed.minimums.walkRun = null;
  if (parsed.restDaysUsed === undefined) {
    parsed.restDaysUsed = 0;
    parsed.weekStartDate = null;
  }
  if (!parsed.units) parsed.units = "miles";
  if (parsed.lastRoute === undefined) parsed.lastRoute = null;
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
    return migrateData(row.data);
  }

  // Brand new account - seed it from any existing local progress, or
  // plain defaults if there isn't any.
  const initialData = loadLocalData() || defaultData();
  await saveUserData(userId, initialData);
  return initialData;
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
const progressFillEl = document.getElementById("progress-fill");

const pushupsEl = document.getElementById("pushups");
const situpsEl = document.getElementById("situps");
const squatsEl = document.getElementById("squats");
const walkrunEl = document.getElementById("walkrun");
const walkrunRowEl = document.getElementById("walkrun-row");

const pushupsMinTagEl = document.getElementById("pushups-min-tag");
const situpsMinTagEl = document.getElementById("situps-min-tag");
const squatsMinTagEl = document.getElementById("squats-min-tag");
const walkrunMinTagEl = document.getElementById("walkrun-min-tag");

const minPushupsEl = document.getElementById("min-pushups");
const minSitupsEl = document.getElementById("min-situps");
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

// Shows the current minimums next to each exercise (e.g. "min 15").
function renderMinTags() {
  pushupsMinTagEl.textContent = `min ${data.minimums.pushups}`;
  situpsMinTagEl.textContent = `min ${data.minimums.situps}`;
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
  minSitupsEl.value = data.minimums.situps;
  minSquatsEl.value = data.minimums.squats;

  const walkRunEnabled = data.minimums.walkRun !== null;
  enableWalkrunEl.checked = walkRunEnabled;
  minWalkrunEl.value = walkRunEnabled ? data.minimums.walkRun : 15;
  minWalkrunRowEl.classList.toggle("hidden", !walkRunEnabled);
  unitsRowEl.classList.toggle("hidden", !walkRunEnabled);
  distanceUnitsEl.value = data.units;
}

saveSettingsEl.addEventListener("click", () => {
  data.minimums.pushups = Number(minPushupsEl.value) || 1;
  data.minimums.situps = Number(minSitupsEl.value) || 1;
  data.minimums.squats = Number(minSquatsEl.value) || 1;
  data.minimums.walkRun = enableWalkrunEl.checked ? (Number(minWalkrunEl.value) || 1) : null;
  data.units = distanceUnitsEl.value;

  saveData(data);
  renderMinTags();
  render();
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

// Counts how many of the 3 exercises currently meet their minimum,
// so we can show a progress bar even before the day is logged.
// How many activities count toward today - 3 normally, or 4 if walk/run
// tracking is turned on. Used both to size the progress bar correctly
// and to know how many boxes need to be filled in to log the day.
function totalActivityCount() {
  return data.minimums.walkRun !== null ? 4 : 3;
}

function completedCount() {
  let count = 0;
  if (Number(pushupsEl.value) >= data.minimums.pushups) count += 1;
  if (Number(situpsEl.value) >= data.minimums.situps) count += 1;
  if (Number(squatsEl.value) >= data.minimums.squats) count += 1;
  if (data.minimums.walkRun !== null && Number(walkrunEl.value) >= data.minimums.walkRun) count += 1;
  return count;
}

// Updates everything visible on the page to match the current `data`.
function render() {
  streakCountEl.textContent = data.streak;
  bestStreakCountEl.textContent = data.bestStreak;

  const loggedToday = data.lastLoggedDate === todayString();

  if (loggedToday) {
    statusMessageEl.textContent = "Nice work! You're done for today.";
    logButtonEl.disabled = true;
    logButtonEl.textContent = "Completed Today";
    progressFillEl.style.width = "100%";
  } else {
    statusMessageEl.textContent = "Do your reps, then log today's workout.";
    logButtonEl.disabled = false;
    logButtonEl.textContent = "Log Today's Workout";
    progressFillEl.style.width = `${(completedCount() / totalActivityCount()) * 100}%`;
  }

  pushupsEl.disabled = loggedToday;
  situpsEl.disabled = loggedToday;
  squatsEl.disabled = loggedToday;

  const walkRunEnabled = data.minimums.walkRun !== null;
  walkrunRowEl.classList.toggle("hidden", !walkRunEnabled);
  walkrunEl.disabled = loggedToday;
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

// Recalculate the progress bar live as the user types in any exercise box.
pushupsEl.addEventListener("input", render);
situpsEl.addEventListener("input", render);
squatsEl.addEventListener("input", render);
walkrunEl.addEventListener("input", render);

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
const SCREEN_IDS = ["onboarding-screen", "auth-screen", "forgot-password-screen", "reset-password-screen", "app-screen", "tracking-screen", "tracking-summary-screen"];

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
  data = await loadUserData(userId);
  revealApp();
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

function logWorkout() {
  errorMessageEl.textContent = "";

  const today = todayString();

  if (data.lastLoggedDate === today) {
    // Already logged today - button should be disabled, but guard anyway.
    return;
  }

  // Number(...) converts the text from the input box into an actual number.
  // Input values are ALWAYS strings, even for type="number" inputs.
  const pushups = Number(pushupsEl.value);
  const situps = Number(situpsEl.value);
  const squats = Number(squatsEl.value);
  const walkRunEnabled = data.minimums.walkRun !== null;
  const walkrunMinutes = Number(walkrunEl.value);

  const missedMinimum =
    pushups < data.minimums.pushups ||
    situps < data.minimums.situps ||
    squats < data.minimums.squats ||
    (walkRunEnabled && walkrunMinutes < data.minimums.walkRun);

  if (missedMinimum) {
    let message = `You need at least ${data.minimums.pushups} push-ups, ${data.minimums.situps} sit-ups, and ${data.minimums.squats} squats`;
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

  refreshRestDayWeek();

  if (!data.lastLoggedDate) {
    // First workout ever logged.
    data.streak = 1;
  } else {
    const gap = daysBetween(data.lastLoggedDate, today);
    const missedDays = gap - 1; // gap of 1 means no days were skipped

    if (missedDays <= 0) {
      // Logged yesterday -> the streak continues normally.
      data.streak += 1;
    } else if (data.restDaysUsed + missedDays <= REST_DAYS_PER_WEEK) {
      // The missed day(s) fit within this week's rest day allowance ->
      // the streak survives, and those rest days are spent.
      data.streak += 1;
      data.restDaysUsed += missedDays;
    } else {
      // Missed more days than the remaining rest day allowance covers.
      data.streak = 1;
    }
  }

  data.lastLoggedDate = today;

  if (data.streak > data.bestStreak) {
    data.bestStreak = data.streak;
  }

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
      authSubtitleEl.textContent = "Day 1 complete! Create an account so you never lose this streak.";
      showAuthScreen();
    }, 1800);
  }
}

// addEventListener attaches a function to run whenever a specific event
// happens on an element - here, whenever the button is clicked.
logButtonEl.addEventListener("click", logWorkout);


// STEP 4: Tabs (Today / Competition / Me) and the leaderboard mockup.

// Each tab's name maps to its button and panel elements, so showTab()
// can loop over them instead of needing a separate if/else per tab.
const TABS = {
  today: {
    button: document.getElementById("tab-btn-today"),
    panel: document.getElementById("tab-today"),
  },
  competition: {
    button: document.getElementById("tab-btn-competition"),
    panel: document.getElementById("tab-competition"),
  },
  me: {
    button: document.getElementById("tab-btn-me"),
    panel: document.getElementById("tab-me"),
  },
};

function showTab(tabName) {
  for (const name in TABS) {
    const isActive = name === tabName;
    TABS[name].panel.classList.toggle("hidden", !isActive);
    TABS[name].button.classList.toggle("active", isActive);
  }

  if (tabName === "competition") {
    renderLeaderboard();
  }
}

TABS.today.button.addEventListener("click", () => showTab("today"));
TABS.competition.button.addEventListener("click", () => showTab("competition"));
TABS.me.button.addEventListener("click", () => showTab("me"));

// Reusable icon markup - defined once, inserted wherever needed via
// template literals, instead of repeating the same SVG code every time.
const PERSON_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>';
const FLAME_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-1 4-6 6-6 12a6 6 0 0 0 12 0c0-3-2-4-2-7-1 2-2 2-2 0 0-2-1-4-2-5z"/></svg>';

// Fake friends, purely to preview what a real leaderboard will look like
// once accounts/friends are built. "You" is mixed in using your real streak.
// Every avatar is a generic silhouette for now - once real friends and
// profile pictures exist, this is where an uploaded photo would go instead,
// falling back to this same silhouette for anyone without one.
const MOCK_FRIENDS = [
  { name: "Jordan", streak: 34 },
  { name: "Casey", streak: 21 },
  { name: "Alex", streak: 15 },
  { name: "Sam", streak: 9 },
];

function renderLeaderboard() {
  const leaderboardEl = document.getElementById("leaderboard");
  leaderboardEl.innerHTML = "";

  const you = { name: "You", streak: data.streak, isYou: true };

  // [...array] copies the array so sort() doesn't mutate the original
  // MOCK_FRIENDS list. .sort((a, b) => b.streak - a.streak) sorts from
  // highest streak to lowest.
  const combined = [...MOCK_FRIENDS, you].sort((a, b) => b.streak - a.streak);

  combined.forEach((person, index) => {
    const row = document.createElement("div");
    row.className = "leaderboard-row";
    if (person.isYou) {
      row.classList.add("is-you");
    }

    row.innerHTML = `
      <span class="leaderboard-rank">#${index + 1}</span>
      <span class="leaderboard-avatar">${PERSON_ICON_SVG}</span>
      <span class="leaderboard-name">${person.name}</span>
      <span class="leaderboard-streak">${person.streak} ${FLAME_ICON_SVG}</span>
    `;

    leaderboardEl.appendChild(row);
  });
}


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
  beginner: { pushups: 5, situps: 10, squats: 10 },
  intermediate: { pushups: 15, situps: 20, squats: 20 },
  advanced: { pushups: 30, situps: 30, squats: 40 },
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


// STEP 7: GPS walk/run tracking - a live map, distance, and timer.

const startTrackingButtonEl = document.getElementById("start-tracking-button");
const trackingTimeEl = document.getElementById("tracking-time");
const trackingDistanceEl = document.getElementById("tracking-distance");
const trackingDistanceLabelEl = document.getElementById("tracking-distance-label");
const trackingErrorEl = document.getElementById("tracking-error");
const trackingCancelEl = document.getElementById("tracking-cancel");
const trackingFinishEl = document.getElementById("tracking-finish");
const summaryTimeEl = document.getElementById("summary-time");
const summaryDistanceEl = document.getElementById("summary-distance");
const summaryDistanceLabelEl = document.getElementById("summary-distance-label");
const summaryPaceEl = document.getElementById("summary-pace");
const summaryPaceLabelEl = document.getElementById("summary-pace-label");
const trackingSummaryDoneEl = document.getElementById("tracking-summary-done");

// Everything about the CURRENT tracking session lives in one object, so
// starting a new session is just replacing this rather than resetting a
// dozen separate variables individually.
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

function createTrackingMap(containerId) {
  const map = L.map(containerId);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  return map;
}

function startTracking() {
  if (!("geolocation" in navigator)) {
    trackingErrorEl.textContent = "GPS isn't available on this device/browser.";
    showScreen("tracking-screen");
    return;
  }

  session = {
    route: [],
    distanceKm: 0,
    startTime: Date.now(),
    watchId: null,
    timerId: null,
    map: null,
    polyline: null,
    marker: null,
  };

  trackingErrorEl.textContent = "";
  trackingTimeEl.textContent = "0:00";
  trackingDistanceEl.textContent = "0.00";
  trackingDistanceLabelEl.textContent = distanceUnitLabel();

  showScreen("tracking-screen");

  // The map container must actually be visible on screen before Leaflet
  // can measure it correctly, so it's created here (after showScreen)
  // rather than up front.
  session.map = createTrackingMap("tracking-map");
  session.map.setView([0, 0], 16);
  session.polyline = L.polyline([], { color: "#22c55e", weight: 4 }).addTo(session.map);

  session.timerId = setInterval(() => {
    trackingTimeEl.textContent = formatDuration(Date.now() - session.startTime);
  }, 1000);

  session.watchId = navigator.geolocation.watchPosition(onTrackingPosition, onTrackingError, {
    enableHighAccuracy: true,
    maximumAge: 0,
  });
}

function onTrackingPosition(position) {
  const { latitude, longitude } = position.coords;
  const point = [latitude, longitude];
  const previousPoint = session.route[session.route.length - 1];

  if (previousPoint) {
    session.distanceKm += haversineDistanceKm(previousPoint[0], previousPoint[1], latitude, longitude);
  }

  session.route.push(point);
  session.polyline.addLatLng(point);

  if (session.marker) {
    session.marker.setLatLng(point);
  } else {
    session.marker = L.circleMarker(point, { radius: 7, color: "#22c55e", fillOpacity: 1 }).addTo(session.map);
  }

  session.map.setView(point, session.map.getZoom() < 15 ? 16 : session.map.getZoom());
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

trackingCancelEl.addEventListener("click", () => {
  stopTrackingWatchers();
  session = null;
  showScreen("app-screen");
});

trackingFinishEl.addEventListener("click", () => {
  stopTrackingWatchers();

  const durationMs = Date.now() - session.startTime;
  const durationMinutes = Math.max(1, Math.round(durationMs / 60000));

  // Auto-fill the manual minutes field, same as if it had been typed in -
  // the rest of the day-logging logic doesn't need to know GPS was involved.
  walkrunEl.value = durationMinutes;
  render();

  // Keep just the most recent route (not a full history archive) - enough
  // to show the "nice work" recap without the saved data growing forever.
  data.lastRoute = {
    date: todayString(),
    distanceKm: session.distanceKm,
    durationMs,
    route: session.route,
  };
  saveData(data);

  showTrackingSummary(session.route, session.distanceKm, durationMs);
  session = null;
});

function showTrackingSummary(route, distanceKm, durationMs) {
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

  showScreen("tracking-summary-screen");

  const map = createTrackingMap("summary-map");
  if (route.length > 0) {
    const polyline = L.polyline(route, { color: "#22c55e", weight: 4 }).addTo(map);
    map.fitBounds(polyline.getBounds(), { padding: [20, 20] });
  } else {
    map.setView([0, 0], 2);
  }
}

trackingSummaryDoneEl.addEventListener("click", () => {
  showScreen("app-screen");
});

startTrackingButtonEl.addEventListener("click", startTracking);


// STEP 8: Register the service worker, if the browser supports one.
// "serviceWorker" in navigator is a feature check - older browsers that
// don't support service workers simply skip this without erroring.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js");
  });
}
