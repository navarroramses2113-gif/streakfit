// The first-run sign-up flow, Duolingo-style: one question per screen under
// a progress bar, then the plan, Day 1 (or the "Find my level" camera test,
// which counts as Day 1), and only after that an account. The answers end
// up where the rest of the app already looks: data.minimums (the plan's
// starting targets), data.startPace (handed to the server's plan when the
// account is created) and data.goals.
//
// Loaded before script.js, but only touches script.js's variables and
// functions (data, saveCameraSet, supabaseClient...) once it's running,
// when everything has loaded.
const Onboarding = (function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    dumbbell: I('<rect x="1" y="9" width="3" height="6" rx="1"/><rect x="20" y="9" width="3" height="6" rx="1"/><rect x="4" y="7" width="2.5" height="10" rx="1"/><rect x="17.5" y="7" width="2.5" height="10" rx="1"/><line x1="6.5" y1="12" x2="17.5" y2="12"/>'),
    calendar: I('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M9 15l2 2 4-4"/>'),
    flame: I('<path d="M12 2c-1 4-6 6-6 12a6 6 0 0 0 12 0c0-3-2-4-2-7-1 2-2 2-2 0 0-2-1-4-2-5z"/>'),
    heart: I('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'),
    trophy: I('<path d="M8 4h8v6a4 4 0 0 1-8 0V4z"/><path d="M8 5H5a2 2 0 0 0 0 4h3"/><path d="M16 5h3a2 2 0 0 1 0 4h-3"/><path d="M12 14v4M9 21h6M12 18v3"/>'),
    people: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 13.9c1.8.9 3 2.9 3 5.1"/>'),
    play: I('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>'),
    camera: I('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
    dots: I('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
    seedling: I('<path d="M12 21v-9"/><path d="M12 12c0-4 3-7 8-7 0 5-3 8-8 7z"/><path d="M12 14c0-3-2-5-6-5 0 4 2 6 6 5z"/>'),
    target: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>'),
    walk: I('<polyline points="2 12 6 12 9 4 14 20 17 12 22 12"/>'),
    close: I('<path d="M18 6L6 18M6 6l12 12"/>'),
  };

  const GOALS = [
    { v: "stronger", t: "Get stronger", s: "More push-ups, deeper squats, longer planks", icon: ICON.dumbbell, react: "Strong choice. Your targets will keep climbing so you keep getting stronger.", label: "getting stronger" },
    { v: "habit", t: "Build a daily habit", s: "Show up every day, even the busy ones", icon: ICON.calendar, react: "Love it. We'll keep each day small enough that you never want to skip it.", label: "a daily habit" },
    { v: "weight", t: "Lose weight", s: "Move more, every single day", icon: ICON.flame, react: "Great goal. Daily strength work plus walks or runs works best, so we'll suggest both.", label: "losing weight" },
    { v: "feel", t: "Feel better", s: "More energy, better mood, better sleep", icon: ICON.heart, react: "Good call. A few minutes a day is enough to feel the difference.", label: "feeling better" },
    { v: "compete", t: "Beat my friends", s: "Climb the leaderboard", icon: ICON.trophy, react: "Your friends should be worried. Every rep on the leaderboard is camera-verified, so a win is a real win.", label: "beating your friends" },
  ];
  const MAX_GOALS = 3;
  const SOURCES = [
    { v: "friend", t: "A friend or family member", icon: ICON.people },
    { v: "tiktok", t: "TikTok", icon: ICON.play },
    { v: "instagram", t: "Instagram", icon: ICON.camera },
    { v: "youtube", t: "YouTube", icon: ICON.play },
    { v: "appstore", t: "Searching the App Store", icon: ICON.search },
    { v: "other", t: "Somewhere else", icon: ICON.dots },
  ];
  // "How many push-ups in a row?" -> where the plan starts (never below the
  // server's floors). The camera test replaces this with real numbers.
  const LEVELS = [
    { v: "l0", t: "0 to 5", s: "A fine place to start", targets: { pushups: 5, squats: 10, planks: 20 } },
    { v: "l1", t: "6 to 15", s: "A solid base", targets: { pushups: 8, squats: 15, planks: 30 } },
    { v: "l2", t: "16 to 30", s: "You're strong already", targets: { pushups: 15, squats: 25, planks: 45 } },
    { v: "l3", t: "More than 30", s: "Impressive", targets: { pushups: 25, squats: 40, planks: 60 } },
  ];
  const PACES = [
    { v: "easy", t: "Easy", bars: 1 },
    { v: "regular", t: "Regular", bars: 2 },
    { v: "serious", t: "Serious", bars: 3 },
    { v: "intense", t: "Intense", bars: 4 },
  ];
  // The main goal picks the recommended pace.
  const RECOMMENDED_PACE = { stronger: "serious", habit: "easy", weight: "regular", feel: "easy", compete: "serious" };
  const EXERCISES = [
    { exercise: "pushup", key: "pushups", title: "Push-ups", name: "push-ups" },
    { exercise: "squat", key: "squats", title: "Squats", name: "squats" },
    { exercise: "plank", key: "planks", title: "Plank", name: "plank" },
  ];
  const REMINDER_HOURS = [7, 12, 18, 20];
  // Minimums nobody can reach, used only while the "Find my level" test runs
  // (before there's a plan), so a test set can't complete the day early.
  const NOT_PLANNED_YET = { pushups: 99999, planks: 99999, squats: 99999, walkRun: null };

  let active = false;
  let state = null;
  let current = "welcome";
  let trail = [];
  let lastRendered = null;

  function freshState() {
    return { goals: [], source: null, level: null, placement: null, pace: null, walk: null, walkMinutes: 15, tested: {}, committed: false, reminderHour: null, usernameOnly: false, accountDone: false, error: "", errorIsInfo: false, busy: false, showLogin: false };
  }

  const find = (list, v) => list.find((x) => x.v === v);
  const mainGoal = () => find(GOALS, state.goals[0]) || GOALS[0];
  const recommendedPace = () => RECOMMENDED_PACE[mainGoal().v];
  const listWords = (words) => (words.length < 2 ? words.join("") : words.slice(0, -1).join(", ") + " and " + words[words.length - 1]);
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const allTested = () => EXERCISES.every((e) => state.tested[e.key] > 0);

  // ---------- the plan ----------
  function startingTargets() {
    if (state.placement === "test" && allTested()) return ForjaRules.startTargets(state.tested);
    return { ...(find(LEVELS, state.level) || LEVELS[0]).targets };
  }

  // The plan's targets for each of the first `days` days, completing every
  // day exactly on target - the same rules the server runs.
  function planDays(targets, pace, days) {
    let plan = ForjaRules.newPlan(pace, targets);
    let day = todayString();
    const out = [];
    for (let i = 0; i < days; i++) {
      const today = ForjaRules.planOn(plan, day).plan.targets;
      out.push(today);
      plan = ForjaRules.completePlanDay(plan, day, { totals: today, sets: { pushups: 1, squats: 1, planks: 1 } }).plan;
      day = ForjaRules.addDays(day, 1);
    }
    return out;
  }

  // A guest's local data, created the first time a set is recorded.
  function ensureGuestData() {
    if (data) return;
    data = loadLocalData() || defaultData();
    if (!state.committed) data.minimums = { ...NOT_PLANNED_YET };
  }

  // "Looks good" on the plan: the answers become the guest's real data.
  // Safe to run again (after Back): today's sets are kept.
  function commitPlan() {
    ensureGuestData();
    const t = startingTargets();
    data.minimums = { pushups: t.pushups, planks: t.planks, squats: t.squats, walkRun: state.walk === "yes" ? state.walkMinutes : null };
    data.startPace = state.pace;
    data.goals = [...state.goals];
    data.heardFrom = state.source;
    saveData(data);
    localStorage.setItem("streakfit-seen-onboarding", "true");
    state.committed = true;
    // A finished "Find my level" test already covers Day 1's targets.
    maybeCompleteDay();
  }

  const exercisesMet = () => !!data && EXERCISES.every((e) => todayProgress()[e.key] >= data.minimums[e.key]);
  const afterDay1 = () => (state.walk === "yes" ? "almost" : "streak");

  // ---------- pieces ----------
  function mascot(mood) {
    const mouth = mood === "wow" ? '<ellipse cx="50" cy="76" rx="6" ry="7" fill="#3a1d0b"/>' : '<path d="M40 73 Q50 83 60 73" stroke="#3a1d0b" stroke-width="4" fill="none" stroke-linecap="round"/>';
    return `<svg class="ob-mascot" viewBox="0 0 100 112" aria-hidden="true">
      <defs><linearGradient id="ob-ember-${mood}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ember-light)"/><stop offset="1" stop-color="var(--ember)"/></linearGradient></defs>
      <path d="M50 4 C60 26 86 38 86 68 C86 92 70 108 50 108 C30 108 14 92 14 68 C14 50 26 42 32 24 C38 34 44 36 50 4 Z" fill="url(#ob-ember-${mood})"/>
      <ellipse cx="38" cy="62" rx="7" ry="9" fill="#fff"/><ellipse cx="62" cy="62" rx="7" ry="9" fill="#fff"/>
      <circle cx="40" cy="64" r="4" fill="#1c1c1e"/><circle cx="60" cy="64" r="4" fill="#1c1c1e"/>${mouth}
    </svg>`;
  }
  const coach = (text) => `<div class="ob-coach">${mascot("happy")}<p class="ob-bubble">${text}</p></div>`;
  const bars = (n) => `<span class="ob-bars">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? "on" : ""}" style="height:${4 + i * 4}px"></i>`).join("")}</span>`;

  // A list of single-choice answers. `opts.sub(o)` and `opts.tag(o)` add a
  // second line and a badge.
  function choices(list, key, opts = {}) {
    return `<div class="ob-options" role="radiogroup">${list
      .map((o) => {
        const sub = opts.sub ? opts.sub(o) : o.s;
        const tag = opts.tag ? opts.tag(o) : "";
        return `<button class="ob-option" role="radio" aria-checked="${state[key] === o.v}" data-pick="${key}" data-value="${o.v}">
          ${o.icon ? `<span class="ob-option-icon">${o.icon}</span>` : ""}${o.bars ? `<span class="ob-option-icon">${bars(o.bars)}</span>` : ""}
          <span class="ob-option-text"><b>${o.t}${tag ? ` <span class="ob-tag">${tag}</span>` : ""}</b>${sub ? `<small>${sub}</small>` : ""}</span>
        </button>`;
      })
      .join("")}</div>`;
  }

  // Day 1 (or the test) as a short list: what each exercise asks and what's done.
  function exerciseList(mode) {
    const progress = data ? todayProgress() : { pushups: 0, squats: 0, planks: 0 };
    const rows = EXERCISES.map((e) => {
      let value, done;
      if (mode === "test") {
        done = state.tested[e.key] > 0;
        value = done ? (e.key === "planks" ? fmtTime(state.tested[e.key]) : state.tested[e.key]) : e.key === "planks" ? "Longest hold" : "Max reps";
      } else {
        const target = data.minimums[e.key];
        const have = progress[e.key];
        done = have >= target;
        const show = (n) => (e.key === "planks" ? fmtTime(n) : n);
        value = done || have === 0 ? show(target) : `${show(have)} / ${show(target)}`;
      }
      return `<div class="ob-row${done ? " done" : ""}"><span>${done ? "✓ " : ""}${e.title}</span><span>${value}</span></div>`;
    });
    if (mode !== "test" && data.minimums.walkRun !== null) rows.push(`<div class="ob-row"><span>Walk or run</span><span>${data.minimums.walkRun} min, later today</span></div>`);
    return `<div class="ob-list">${rows.join("")}</div>`;
  }

  function planChart(days) {
    const W = 300, H = 120, pad = 22;
    const values = days.map((t) => t.pushups);
    const lo = values[0], hi = values[values.length - 1];
    const x = (i) => pad + ((W - pad * 2) * i) / (values.length - 1);
    const y = (v) => H - 20 - ((H - 48) * (v - lo)) / Math.max(1, hi - lo);
    let path = `M${x(0)},${y(values[0])}`;
    for (let i = 1; i < values.length; i++) path += ` H${x(i)} V${y(values[i])}`;
    return `<div class="ob-chart"><p class="ob-chart-label">Push-ups a day</p>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Push-ups go from ${lo} to ${hi} over 30 days">
        <line x1="${pad}" y1="${H - 20}" x2="${W - pad}" y2="${H - 20}" stroke="var(--border)" stroke-width="1"/>
        <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
        <circle cx="${x(0)}" cy="${y(lo)}" r="4.5" fill="var(--accent)"/><circle cx="${x(values.length - 1)}" cy="${y(hi)}" r="5.5" fill="var(--accent)"/>
        <text x="${x(0)}" y="${y(lo) - 10}" fill="var(--text-secondary)" font-size="12" font-weight="600">${lo}</text>
        <text x="${x(values.length - 1)}" y="${y(hi) - 12}" fill="var(--text-primary)" font-size="13" font-weight="700" text-anchor="end">${hi}</text>
        <text x="${x(0)}" y="${H - 4}" fill="var(--text-muted)" font-size="11">Today</text>
        <text x="${x(values.length - 1)}" y="${H - 4}" fill="var(--text-muted)" font-size="11" text-anchor="end">Day 30</text>
      </svg></div>`;
  }

  const cta = (label, action, disabled) => `<button class="auth-submit-button" data-action="${action}"${disabled ? " disabled" : ""}>${label}</button>`;
  const quiet = (label, action) => `<button class="auth-skip" data-action="${action}">${label}</button>`;
  const continueButton = (ready) => cta("Continue", "next", !ready);
  const errorLine = () => (state.error ? `<p class="error${state.errorIsInfo ? " success" : ""}" role="alert">${esc(state.error)}</p>` : "");

  // ---------- the screens ----------
  // body: the middle; footer: the buttons; centered: a celebration-style
  // screen; noBack: no going back from here.
  const SCREENS = {
    welcome: {
      centered: true,
      noBack: true,
      body: () => `${mascot("happy")}<p class="ob-wordmark">Forja</p><p class="ob-lead">Show up every day. The camera counts your reps, so every streak is real.</p>`,
      footer: () => cta("Get Started", "next") + quiet("I already have an account", "login"),
    },
    goal: {
      body: () => {
        const full = state.goals.length >= MAX_GOALS;
        return `${coach("Hi! Why do you want to work out? Pick up to 3.")}
          <div class="ob-options" role="group">${GOALS.map((o) => {
            const at = state.goals.indexOf(o.v);
            return `<button class="ob-option${full && at < 0 ? " dimmed" : ""}" role="checkbox" aria-checked="${at >= 0}" data-goal="${o.v}">
              <span class="ob-option-icon">${o.icon}</span>
              <span class="ob-option-text"><b>${o.t}${at === 0 && state.goals.length > 1 ? ` <span class="ob-tag">Main</span>` : ""}</b><small>${o.s}</small></span>
            </button>`;
          }).join("")}</div>`;
      },
      footer: () => continueButton(state.goals.length > 0),
    },
    reaction: {
      centered: true,
      body: () => {
        const others = state.goals.slice(1).map((v) => find(GOALS, v).label);
        return `${mascot("wow")}<h1 class="ob-title">${mainGoal().react}</h1>${others.length ? `<p class="ob-lead">We'll keep ${listWords(others)} in mind too.</p>` : ""}`;
      },
      footer: () => continueButton(true),
    },
    source: {
      body: () => coach("How did you hear about Forja?") + choices(SOURCES, "source"),
      footer: () => continueButton(!!state.source),
    },
    level: {
      body: () => coach("How many push-ups can you do in a row?") + choices(LEVELS, "level") + `<p class="ob-fine">A rough guess is fine.</p>`,
      footer: () => continueButton(!!state.level),
    },
    placement: {
      body: () =>
        coach("Where should we start?") +
        choices(
          [
            { v: "answer", t: "Start from my answer", s: "Begin right away", icon: ICON.seedling },
            { v: "test", t: "Find my level", s: "Max push-ups, max squats, longest plank. Counts as Day 1.", icon: ICON.target },
          ],
          "placement",
          { tag: (o) => (o.v === "test" ? "Most accurate" : "") }
        ),
      footer: () => continueButton(!!state.placement),
    },
    test: {
      body: () => coach("Three quick tests. Go until you can't do another good rep.") + exerciseList("test") + `<p class="ob-fine">Prop your phone on the floor about 2 m away, side-on, with your whole body in view.</p>`,
      footer: () => {
        const next = EXERCISES.find((e) => !(state.tested[e.key] > 0));
        return (next ? cta(`Start ${next.name} test`, "camera") : continueButton(true)) + quiet("Use my answer instead", "skip-test");
      },
    },
    result: {
      centered: true,
      body: () => `${mascot("wow")}<h1 class="ob-title">Here's your level</h1>
        <div class="ob-list">${EXERCISES.map((e) => `<div class="ob-row"><span>${e.title}</span><span>${e.key === "planks" ? fmtTime(state.tested[e.key]) : state.tested[e.key]}</span></div>`).join("")}</div>
        <p class="ob-fine">Your daily targets start a little below these.</p>`,
      footer: () => continueButton(true),
    },
    pace: {
      body: () => {
        if (!state.pace) state.pace = recommendedPace();
        const start = startingTargets();
        return (
          coach(`For ${mainGoal().label}, we recommend <span class="ob-em">${find(PACES, recommendedPace()).t}</span>. Pick your pace:`) +
          choices(PACES, "pace", {
            sub: (o) => `${start.pushups} → ${planDays(start, o.v, 30)[29].pushups} push-ups in 30 days`,
            tag: (o) => (o.v === recommendedPace() ? "For you" : ""),
          })
        );
      },
      footer: () => continueButton(!!state.pace),
    },
    walk: {
      body: () =>
        coach("Want walks or runs as part of your day?") +
        choices(
          [
            { v: "yes", t: "Yes, add cardio", s: "Tracked with GPS", icon: ICON.walk },
            { v: "no", t: "Not now", s: "You can add it any time", icon: ICON.close },
          ],
          "walk"
        ) +
        (state.walk === "yes"
          ? `<p class="ob-label">Minutes a day</p><div class="ob-chips" role="radiogroup">${[10, 15, 20, 30]
              .map((m) => `<button role="radio" aria-checked="${state.walkMinutes === m}" data-pick="walkMinutes" data-value="${m}">${m} min</button>`)
              .join("")}</div>`
          : ""),
      footer: () => continueButton(!!state.walk),
    },
    plan: {
      body: () => {
        const days = planDays(startingTargets(), state.pace, 30);
        const first = days[0], last = days[29];
        const row = (name, a, b) => `<div class="ob-row"><span>${name}</span><span>${a}</span><span class="ob-goal">${b}</span></div>`;
        return `${coach("Here's your plan. This is where you'll be in 30 days:")}
          <div class="ob-list ob-plan">
            <div class="ob-row ob-head"><span></span><span>Today</span><span>Day 30</span></div>
            ${row("Push-ups", first.pushups, last.pushups)}${row("Squats", first.squats, last.squats)}${row("Plank", fmtTime(first.planks), fmtTime(last.planks))}
            ${state.walk === "yes" ? row("Walk or run", `${state.walkMinutes} min`, `${state.walkMinutes} min`) : ""}
          </div>${planChart(days)}`;
      },
      footer: () => cta("Looks Good", "next"),
    },
    day1: {
      body: () => coach("Let's do Day 1! Your streak starts when you finish all of it.") + exerciseList("day") + `<p class="ob-fine">Prop your phone on the floor about 2 m away, side-on, with your whole body in view.</p>`,
      footer: () => {
        const next = EXERCISES.find((e) => todayProgress()[e.key] < data.minimums[e.key]);
        return (next ? cta(`Start ${next.name}`, "camera") : continueButton(true)) + quiet("I'll do it later today", "later");
      },
    },
    almost: {
      centered: true,
      noBack: true,
      body: () => `${mascot("wow")}<h1 class="ob-title">3 of 4 done!</h1><p class="ob-lead">Finish your ${data.minimums.walkRun}-minute walk or run today and Day 1 is complete.</p>`,
      footer: () => cta("Got It", "next"),
    },
    streak: {
      centered: true,
      noBack: true,
      body: () => {
        const today = (new Date().getDay() + 6) % 7; // Monday first
        return `<div class="ob-flame ob-pop"><svg viewBox="0 0 100 112" aria-hidden="true"><defs><linearGradient id="ob-flame-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ember-light)"/><stop offset="1" stop-color="var(--ember)"/></linearGradient></defs>
            <path d="M50 4 C60 26 86 38 86 68 C86 92 70 108 50 108 C30 108 14 92 14 68 C14 50 26 42 32 24 C38 34 44 36 50 4 Z" fill="url(#ob-flame-fill)"/></svg>
            <span class="ob-flame-number">${data.streak}</span></div>
          <h1 class="ob-title">Your streak has started!</h1><p class="ob-lead">Show up tomorrow to make it ${data.streak + 1}.</p>
          <div class="ob-week" aria-hidden="true">${["M", "T", "W", "T", "F", "S", "S"].map((d, i) => `<span class="${i === today ? "done" : ""}">${d}</span>`).join("")}</div>`;
      },
      footer: () => continueButton(true),
    },
    account: {
      noBack: true,
      body: () => {
        if (state.usernameOnly) {
          return `${coach("Your account is ready. Pick a username so friends can find you.")}
            <div class="auth-fields"><input id="ob-username" placeholder="Username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20"></div>${errorLine()}`;
        }
        // Sign in with Apple goes first here once there's an Apple Developer account.
        return `${coach("Save your progress so your streak follows you, and so you can compete with friends.")}
          <div class="auth-fields">
            <input id="ob-username" placeholder="Username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20">
            <input id="ob-email" type="email" placeholder="Email" autocomplete="email">
            <input id="ob-password" type="password" placeholder="Password (8+ characters)" autocomplete="new-password">
          </div>${errorLine()}
          ${state.showLogin ? `<button class="link-button ob-login" data-action="login">Log in instead</button>` : ""}
          <p class="auth-legal">By creating an account you agree to our <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p>`;
      },
      footer: () =>
        state.usernameOnly
          ? cta(state.busy ? "Saving..." : "Save Username", "save-username", state.busy || !accountReady())
          : cta(state.busy ? "Creating..." : "Create Account", "create", state.busy || !accountReady()) + quiet("Later", "finish"),
    },
    reminder: {
      noBack: true,
      body: () => {
        const label = (h) => `${h % 12 || 12}:00 ${h < 12 ? "AM" : "PM"}`;
        return `${coach("Your streak is on the line every day. When should we remind you?")}
          <div class="ob-chips" role="radiogroup">${REMINDER_HOURS.map((h) => `<button role="radio" aria-checked="${state.reminderHour === h}" data-pick="reminderHour" data-value="${h}">${label(h)}</button>`).join("")}</div>
          <p class="ob-fine">Only on days you haven't finished yet.</p>${errorLine()}`;
      },
      footer: () => cta(state.busy ? "Turning On..." : "Remind Me", "remind", state.busy || state.reminderHour === null) + quiet("Not now", "next"),
    },
    friends: {
      centered: true,
      noBack: true,
      body: () => `${mascot("happy")}<h1 class="ob-title">Forja is better with friends</h1><p class="ob-lead">Compete on the leaderboard and give each other kudos in the Feed.</p>`,
      footer: () => cta("Invite Friends", "invite") + quiet("Not now", "finish"),
    },
  };

  // The screens this person will see, in order (for the progress bar).
  function path() {
    const test = state.placement === "test";
    const skipDay1 = test && state.committed && exercisesMet();
    return [
      "goal", "reaction", "source", "level", "placement",
      ...(test ? ["test", "result"] : []),
      "pace", "walk", "plan",
      ...(skipDay1 ? [] : ["day1"]),
      state.walk === "yes" ? "almost" : "streak",
      "account",
      ...(pushSupported() ? ["reminder"] : []),
      "friends",
    ];
  }

  function nextScreen() {
    switch (current) {
      case "welcome": return "goal";
      case "goal": return "reaction";
      case "reaction": return "source";
      case "source": return "level";
      case "level": return "placement";
      case "placement": return state.placement === "test" ? "test" : "pace";
      case "test": return "result";
      case "result": return "pace";
      case "pace": return "walk";
      case "walk": return "plan";
      case "plan": return exercisesMet() ? afterDay1() : "day1";
      case "day1": return afterDay1();
      case "almost":
      case "streak": return "account";
      case "account": return pushSupported() ? "reminder" : "friends";
      case "reminder": return "friends";
      default: return null;
    }
  }

  function go(id) {
    if (!id) return finish();
    if (SCREENS[id].noBack) trail = [];
    else trail.push(current);
    current = id;
    state.error = "";
    state.errorIsInfo = false;
    render();
  }

  function back() {
    if (!trail.length) return;
    current = trail.pop();
    state.error = "";
    render();
  }

  function accountReady() {
    const name = ($("ob-username") || {}).value || "";
    if (state.usernameOnly) return USERNAME_PATTERN.test(name.trim());
    const email = ($("ob-email") || {}).value || "";
    const password = ($("ob-password") || {}).value || "";
    return USERNAME_PATTERN.test(name.trim()) && /\S+@\S+\.\S+/.test(email.trim()) && password.length >= 8;
  }

  function render() {
    const screen = SCREENS[current];
    const steps = path();
    const at = steps.indexOf(current);
    $("ob-back").classList.toggle("invisible", !trail.length || !!screen.noBack);
    $("ob-progress").classList.toggle("invisible", current === "welcome");
    const fraction = at < 0 ? 0 : (at + 1) / (steps.length + 1);
    $("ob-progress-fill").style.width = fraction * 100 + "%";
    $("ob-progress").setAttribute("aria-valuenow", String(Math.round(fraction * 100)));

    // Typed fields survive a re-render (e.g. an error appearing).
    const typed = {};
    ["ob-username", "ob-email", "ob-password"].forEach((id) => $(id) && (typed[id] = $(id).value));

    const body = $("ob-body");
    body.className = "ob-body" + (screen.centered ? " centered" : "");
    body.innerHTML = screen.body();
    Object.entries(typed).forEach(([id, value]) => $(id) && ($(id).value = value));
    $("ob-footer").innerHTML = screen.footer();

    // Slide in only when arriving on a new screen, not on every answer tap.
    if (current !== lastRendered) {
      lastRendered = current;
      body.classList.add("entering");
      window.scrollTo(0, 0);
      body.focus({ preventScroll: true });
    }
  }

  // ---------- actions ----------
  function openCamera() {
    const testing = current === "test";
    const list = testing ? EXERCISES.filter((e) => !(state.tested[e.key] > 0)) : EXERCISES.filter((e) => todayProgress()[e.key] < data.minimums[e.key]);
    if (!list.length) return;
    const e = list[0];
    ensureGuestData();
    ForjaCamera.open(
      e.exercise,
      async (set) => {
        const outcome = await saveCameraSet(set);
        if (outcome.ok && testing) state.tested[e.key] = Math.max(state.tested[e.key] || 0, outcome.value);
        return outcome;
      },
      {
        onClose: () => {
          showScreen("onboarding-screen");
          if (testing && allTested()) go("result");
          else if (!testing && exercisesMet()) go(afterDay1());
          else render();
        },
      }
    );
  }

  async function createAccount() {
    const username = $("ob-username").value.trim();
    const email = $("ob-email").value.trim();
    const password = $("ob-password").value;
    state.busy = true;
    state.error = "";
    state.showLogin = false;
    render();

    // Claimed by showApp once the account exists (see claimPendingUsername).
    localStorage.setItem("forja-pending-username", username);
    const { data: reply, error } = await supabaseClient.auth.signUp({ email, password });
    state.busy = false;
    if (error) {
      localStorage.removeItem("forja-pending-username");
      if (/already registered|already exists/i.test(error.message)) {
        state.error = "This email already has an account.";
        state.showLogin = true;
      } else {
        state.error = error.message;
      }
    } else if (!reply.session) {
      // Only if the project still asks people to confirm their email.
      state.error = "Check your email to confirm your account, then log in.";
      state.errorIsInfo = true;
    } else {
      // Signed in: showApp() loads the new account, then calls accountReady()
      // (which may already have moved on to the next screen).
      if (state.accountDone || current !== "account") return;
      state.busy = true;
    }
    render();
  }

  async function saveUsername() {
    const username = $("ob-username").value.trim();
    state.busy = true;
    state.error = "";
    render();
    const { error } = await supabaseClient.from("profiles").insert({ user_id: currentUserId, username });
    state.busy = false;
    if (error) {
      state.error = error.code === "23505" ? "That username is taken. Try another." : "Couldn't save your username. Try again.";
      render();
      return;
    }
    myUsername = username;
    state.accountDone = true;
    go(nextScreen());
  }

  async function remind() {
    state.busy = true;
    render();
    data.reminderHour = state.reminderHour;
    saveData(data);
    const ok = await enableReminderNotifications().catch(() => false);
    state.busy = false;
    if (!ok) {
      state.error = "Couldn't turn on reminders. You can do it later in Settings.";
      render();
      return;
    }
    go(nextScreen());
  }

  async function invite() {
    const text = myUsername ? `Add me on Forja! My username is ${myUsername}` : "Join me on Forja - a daily workout streak, verified by the camera.";
    const url = location.origin + location.pathname;
    if (navigator.share) {
      try {
        await navigator.share({ text, url });
      } catch (e) {
        return; // share sheet closed - stay here
      }
    } else {
      try {
        await navigator.clipboard.writeText(`${text} ${url}`);
      } catch (e) {
        // nothing to copy to
      }
    }
    finish();
  }

  function goToLogin() {
    active = false;
    authMode = "login";
    applyAuthMode();
    const email = $("ob-email");
    if (email && email.value) authEmailEl.value = email.value.trim();
    showAuthScreen({ fromOnboarding: true });
  }

  // Into the app: the account's if one was made, otherwise as a guest with
  // the plan saved on this phone.
  function finish() {
    active = false;
    signupInvitePending = false;
    if (currentUserId) {
      revealApp();
      showTab("today");
    } else {
      showAppAsGuest();
    }
  }

  // ---------- events ----------
  const screenEl = $("onboarding-screen");

  screenEl.addEventListener("click", (event) => {
    if (event.target.closest("#ob-back")) return back();

    const goalButton = event.target.closest("[data-goal]");
    if (goalButton) {
      // Tap to add (up to 3) or remove; the first one picked is the main goal.
      const at = state.goals.indexOf(goalButton.dataset.goal);
      if (at >= 0) state.goals.splice(at, 1);
      else if (state.goals.length < MAX_GOALS) state.goals.push(goalButton.dataset.goal);
      state.pace = null; // the recommended pace follows the main goal
      return render();
    }

    const pick = event.target.closest("[data-pick]");
    if (pick) {
      const key = pick.dataset.pick;
      state[key] = key === "walkMinutes" || key === "reminderHour" ? Number(pick.dataset.value) : pick.dataset.value;
      return render();
    }

    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    switch (button.dataset.action) {
      case "next":
        if (current === "plan") commitPlan();
        return go(nextScreen());
      case "login": return goToLogin();
      case "camera": return openCamera();
      case "skip-test":
        state.placement = "answer";
        return go("pace");
      case "later": return go("account");
      case "create": return createAccount();
      case "save-username": return saveUsername();
      case "remind": return remind();
      case "invite": return invite();
      case "finish": return finish();
    }
  });

  // The account button turns on as soon as the fields are filled in.
  screenEl.addEventListener("input", () => {
    const button = $("ob-footer").querySelector('[data-action="create"], [data-action="save-username"]');
    if (button && !state.busy) button.disabled = !accountReady();
  });

  $("ob-body").addEventListener("animationend", () => $("ob-body").classList.remove("entering"));

  return {
    isActive: () => active,

    start() {
      active = true;
      state = freshState();
      trail = [];
      current = "welcome";
      lastRendered = null;
      showScreen("onboarding-screen");
      render();
    },

    // Called by showApp() once an account created on the account screen has
    // loaded (its guest sets and username already claimed).
    accountReady({ isNewAccount, usernameTaken }) {
      if (!active || current !== "account" || state.accountDone) return;
      state.busy = false;
      if (!isNewAccount) return finish();
      if (usernameTaken) {
        state.usernameOnly = true;
        state.error = "That username is taken. Try another.";
        return render();
      }
      state.accountDone = true;
      go(nextScreen());
    },
  };
})();
