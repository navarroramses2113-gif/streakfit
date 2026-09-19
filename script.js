// STEP 1: Load saved data from the browser's storage.
//
// localStorage is a small key-value storage built into every browser.
// It only stores strings, so we save our data as JSON text and parse it
// back into a real JavaScript object when we read it.
//
// If nothing has been saved yet (first time using the app), we start
// with default values: streak of 0, and no last-logged date.

function loadData() {
  const saved = localStorage.getItem("streakfit-data");
  if (saved) {
    const parsed = JSON.parse(saved);
    // Older saved data (from before this feature existed) won't have a
    // `history` field at all. Fill in a default so the rest of the code
    // can always assume it's there - this is called "migrating" old data.
    if (!parsed.history) {
      parsed.history = [];
    }
    if (!parsed.minimums) {
      parsed.minimums = { pushups: 10, situps: 10, squats: 10 };
    }
    if (parsed.restDaysUsed === undefined) {
      parsed.restDaysUsed = 0;
      parsed.weekStartDate = null;
    }
    return parsed;
  }
  return {
    streak: 0,
    bestStreak: 0,
    lastLoggedDate: null,
    history: [],
    minimums: { pushups: 10, situps: 10, squats: 10 },
    restDaysUsed: 0,
    weekStartDate: null,
  };
}

function saveData(data) {
  localStorage.setItem("streakfit-data", JSON.stringify(data));
}

// Load it once when the page starts, and keep it in a variable we can
// update as the user interacts with the page.
let data = loadData();


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

const pushupsMinTagEl = document.getElementById("pushups-min-tag");
const situpsMinTagEl = document.getElementById("situps-min-tag");
const squatsMinTagEl = document.getElementById("squats-min-tag");

const minPushupsEl = document.getElementById("min-pushups");
const minSitupsEl = document.getElementById("min-situps");
const minSquatsEl = document.getElementById("min-squats");
const saveSettingsEl = document.getElementById("save-settings");

// Shows the current minimums next to each exercise (e.g. "min 15").
function renderMinTags() {
  pushupsMinTagEl.textContent = `min ${data.minimums.pushups}`;
  situpsMinTagEl.textContent = `min ${data.minimums.situps}`;
  squatsMinTagEl.textContent = `min ${data.minimums.squats}`;
}

// The Daily Minimums section now lives permanently in the "Me" tab, so
// the input boxes need to start out showing the saved values right away
// instead of only being filled in when a toggle was clicked.
function renderSettingsInputs() {
  minPushupsEl.value = data.minimums.pushups;
  minSitupsEl.value = data.minimums.situps;
  minSquatsEl.value = data.minimums.squats;
}

saveSettingsEl.addEventListener("click", () => {
  data.minimums.pushups = Number(minPushupsEl.value) || 1;
  data.minimums.situps = Number(minSitupsEl.value) || 1;
  data.minimums.squats = Number(minSquatsEl.value) || 1;

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
function completedCount() {
  let count = 0;
  if (Number(pushupsEl.value) >= data.minimums.pushups) count += 1;
  if (Number(situpsEl.value) >= data.minimums.situps) count += 1;
  if (Number(squatsEl.value) >= data.minimums.squats) count += 1;
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
    progressFillEl.style.width = `${(completedCount() / 3) * 100}%`;
  }

  pushupsEl.disabled = loggedToday;
  situpsEl.disabled = loggedToday;
  squatsEl.disabled = loggedToday;

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

// Run these once immediately so the page shows the right thing on load.
render();
renderHeatmap();
renderMotivation();
renderMinTags();
renderSettingsInputs();

// Hide the splash screen once the page has fully finished loading
// (window's "load" event fires after everything - fonts, images, etc -
// not just our script). A brief timeout on top of that ensures the
// branding screen displays for at least a fraction of a second instead
// of flashing away instantly if loading was already fast.
window.addEventListener('load', () => {
  const splash = document.getElementById('splash-screen');

  setTimeout(() => {
    splash.classList.add('splash-fade-out');
  }, 600);
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

  if (pushups < data.minimums.pushups || situps < data.minimums.situps || squats < data.minimums.squats) {
    errorMessageEl.textContent = `You need at least ${data.minimums.pushups} push-ups, ${data.minimums.situps} sit-ups, and ${data.minimums.squats} squats to log today.`;

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

// Fake friends, purely to preview what a real leaderboard will look like
// once accounts/friends are built. "You" is mixed in using your real streak.
const MOCK_FRIENDS = [
  { name: "Jordan", streak: 34, avatar: "🥷" },
  { name: "Casey", streak: 21, avatar: "🐯" },
  { name: "Alex", streak: 15, avatar: "🦁" },
  { name: "Sam", streak: 9, avatar: "🐺" },
];

function renderLeaderboard() {
  const leaderboardEl = document.getElementById("leaderboard");
  leaderboardEl.innerHTML = "";

  const you = { name: "You", streak: data.streak, avatar: "🔥", isYou: true };

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
      <span class="leaderboard-avatar">${person.avatar}</span>
      <span class="leaderboard-name">${person.name}</span>
      <span class="leaderboard-streak">${person.streak}🔥</span>
    `;

    leaderboardEl.appendChild(row);
  });
}


// STEP 4: Register the service worker, if the browser supports one.
// "serviceWorker" in navigator is a feature check - older browsers that
// don't support service workers simply skip this without erroring.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js");
  });
}
