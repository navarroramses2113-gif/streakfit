// The rules of the game, in one place that both the server and the app run:
// what counts as a logged day, how the streak and rest days work, and the
// limits that keep results believable. The server is the one that
// ENFORCES these for signed-in players; guests (who aren't competing)
// use the same functions locally so there's only one implementation of the
// streak math to get right.
//
// Works in the browser (as the global `ForjaRules`), in Deno, and in Node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ForjaRules = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The least a day can ask of anyone who is competing. Players can set
  // their own minimums higher in Settings, never lower - otherwise someone
  // could rank on 1 push-up a day. (These equal the beginner level.)
  const FLOORS = { pushups: 5, planks: 20, squats: 10 };

  // You get this many missed days forgiven per rolling 7-day window.
  const REST_DAYS_PER_WEEK = 2;

  const MAX_SETS_PER_DAY = 60;
  const MAX_REPS_PER_DAY = { pushups: 1000, squats: 1500 };

  const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

  function isValidDay(day) {
    if (typeof day !== "string" || !DAY_PATTERN.test(day)) return false;
    const parsed = new Date(day + "T00:00:00Z");
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
  }

  // Number of days between two "YYYY-MM-DD" strings (b - a).
  function daysBetween(a, b) {
    return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
  }

  // The client says what day it is for them, but the server can't see
  // their clock - only that no timezone is more than a day away from UTC.
  // So any day within one calendar day of the server's UTC date is real.
  function dayInRange(day, nowMs) {
    if (!isValidDay(day)) return false;
    const today = new Date(nowMs).toISOString().slice(0, 10);
    return Math.abs(daysBetween(today, day)) <= 1;
  }

  // Today's verified totals from a list of {exercise, value} sets: reps
  // add up across sets, a plank is the best single hold.
  function totalsFromSets(sets) {
    const totals = { pushups: 0, planks: 0, squats: 0 };
    for (const set of sets) {
      if (set.exercise === "pushup") totals.pushups += set.value;
      else if (set.exercise === "squat") totals.squats += set.value;
      else if (set.exercise === "plank") totals.planks = Math.max(totals.planks, set.value);
    }
    return totals;
  }

  // Which exercises fall short of the floor, as a list (empty = fine).
  function shortfalls(totals) {
    return Object.keys(FLOORS).filter((key) => (totals[key] || 0) < FLOORS[key]);
  }

  // What the streak numbers become when `day` is logged. `stats` is
  // {streak, bestStreak, lastLoggedDate, restDaysUsed, weekStartDate}.
  function nextStats(stats, day) {
    let weekStartDate = stats.weekStartDate;
    let restDaysUsed = stats.restDaysUsed || 0;
    // A rest-day week lasts 7 days from when it started; after that the
    // allowance resets.
    if (!weekStartDate || daysBetween(weekStartDate, day) >= 7) {
      weekStartDate = day;
      restDaysUsed = 0;
    }

    let streak;
    if (!stats.lastLoggedDate) {
      streak = 1; // first workout ever logged
    } else {
      const missedDays = daysBetween(stats.lastLoggedDate, day) - 1; // a gap of 1 means nothing was skipped
      if (missedDays <= 0) {
        streak = (stats.streak || 0) + 1;
      } else if (restDaysUsed + missedDays <= REST_DAYS_PER_WEEK) {
        // The gap fits in this week's rest days: the streak survives.
        streak = (stats.streak || 0) + 1;
        restDaysUsed += missedDays;
      } else {
        streak = 1;
      }
    }

    return {
      streak,
      bestStreak: Math.max(stats.bestStreak || 0, streak),
      lastLoggedDate: day,
      restDaysUsed,
      weekStartDate,
    };
  }

  // A new best only makes the Feed from day 3 - "new best: 1 day" on
  // someone's very first workout would be noise, not news.
  const NEW_BEST_MIN_STREAK = 3;

  // The Feed post friends see for a logged day, as a feed_events row. Built
  // only from the server's own totals and streak math. cardioMinutes is
  // the day's walks/runs as the server recorded them (null if none).
  function feedPost(userId, day, totals, before, after, cardioMinutes) {
    return {
      user_id: userId,
      kind: "day",
      day,
      streak: after.streak,
      pushups: totals.pushups,
      plank_seconds: totals.planks,
      squats: totals.squats,
      cardio_minutes: cardioMinutes > 0 ? cardioMinutes : null,
      new_best: after.streak > (before.bestStreak || 0) && after.streak >= NEW_BEST_MIN_STREAK,
    };
  }

  // Walks and runs. GPS can't be verified the way the camera can, but the
  // server works out the distance from the points itself and refuses what
  // no walker or runner could do (a bike or a car is faster than 25 km/h).
  const ACTIVITY = {
    MIN_KMH: 2.5, // slower than this isn't really moving (same rule as the app)
    RUN_KMH: 8, // at or above this average pace it's a run, below it a walk
    MAX_KMH: 25,
    MIN_MS: 60 * 1000,
    MAX_MS: 6 * 60 * 60 * 1000,
    MAX_POINTS: 20000,
    MAX_PER_DAY: 10,
  };

  // Length of a GPS route ([[lat, lng], ...]) in km, point to point.
  function routeDistanceKm(points) {
    const toRadians = (deg) => (deg * Math.PI) / 180;
    let km = 0;
    for (let i = 1; i < points.length; i++) {
      const [lat1, lon1] = points[i - 1];
      const [lat2, lon2] = points[i];
      const dLat = toRadians(lat2 - lat1);
      const dLon = toRadians(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
      km += 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    return km;
  }

  // Checks one finished walk/run (its GPS points and moving time). Returns
  // { ok: true, kind, distanceM, durationS } or { ok: false, error }.
  function checkActivity(points, durationMs) {
    if (!Array.isArray(points) || points.length < 2 || points.length > ACTIVITY.MAX_POINTS) return { ok: false, error: "bad_route" };
    for (const p of points) {
      if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) {
        return { ok: false, error: "bad_route" };
      }
    }
    if (!Number.isInteger(durationMs) || durationMs < ACTIVITY.MIN_MS || durationMs > ACTIVITY.MAX_MS) return { ok: false, error: "bad_duration" };
    const km = routeDistanceKm(points);
    const kmh = km / (durationMs / 3600000);
    if (kmh < ACTIVITY.MIN_KMH) return { ok: false, error: "too_slow" };
    if (kmh > ACTIVITY.MAX_KMH) return { ok: false, error: "too_fast" };
    return { ok: true, kind: kmh >= ACTIVITY.RUN_KMH ? "run" : "walk", distanceM: Math.round(km * 1000), durationS: Math.round(durationMs / 1000) };
  }

  // ---------- Progressive overload ----------
  // Each player's daily targets grow in STEPS: every few completed days (set
  // by their pace) all three go up one step. How a day went adjusts single
  // exercises, missed days ease the targets back, and a ceiling turns growth
  // into "maintain". Targets are a plan object the server keeps; these pure
  // functions are the only way it changes, so the app, the server and the
  // simulator all agree. `rules` can be overridden (the simulator does).
  const EXERCISE_KEYS = ["pushups", "squats", "planks"];
  const PLAN_RULES = {
    // Steps earned per completed day: Easy = 1 every 4th day, Regular = every
    // 3rd, Serious = every 2nd, Intense = 2 of every 3.
    paces: { easy: 1 / 4, regular: 1 / 3, serious: 1 / 2, intense: 2 / 3 },
    // One step: at least this much, or this share of the target once it's big.
    minStep: { pushups: 1, squats: 2, planks: 5 },
    stepShare: 0.05,
    ceiling: { pushups: 100, squats: 150, planks: 300 },
    startShare: 0.7, // targets start at 70% of a tested max
    crushedShare: 1.5, // 150% of the target in a day = a bonus step
    struggledSets: 3, // needing this many sets = skip the next step
    // Missed days in a row -> steps back (a share means "back to 75%").
    easeBack: [
      { missedAtLeast: 8, share: 0.75 },
      { missedAtLeast: 4, steps: 3 },
      { missedAtLeast: 2, steps: 1 },
    ],
  };

  const roundPlank = (seconds) => Math.round(seconds / 5) * 5;

  function stepSize(key, target, rules = PLAN_RULES) {
    const share = target * rules.stepShare;
    const size = key === "planks" ? roundPlank(share) : Math.round(share);
    return Math.max(rules.minStep[key], size);
  }

  // A plan's starting targets from a tested max (camera "Find my level"):
  // a little below it, never below the floors.
  function startTargets(max, rules = PLAN_RULES) {
    const t = {};
    for (const key of EXERCISE_KEYS) {
      const raw = (max[key] || 0) * rules.startShare;
      t[key] = Math.min(rules.ceiling[key], Math.max(FLOORS[key], key === "planks" ? roundPlank(raw) : Math.round(raw)));
    }
    return t;
  }

  function newPlan(pace, targets) {
    return { pace, targets: { ...targets }, start: { ...targets }, credit: 0, skip: {}, lastDay: null };
  }

  // The plan as it stands on `day`: missed days since the last completed one
  // ease the targets back (never below where the plan started). Pure - the
  // stored plan only changes when a day is completed.
  function planOn(plan, day, rules = PLAN_RULES) {
    const missed = plan.lastDay ? Math.max(0, daysBetween(plan.lastDay, day) - 1) : 0;
    const rule = rules.easeBack.find((r) => missed >= r.missedAtLeast);
    if (!rule) return { plan, missed, easedSteps: 0 };
    const targets = { ...plan.targets };
    for (const key of EXERCISE_KEYS) {
      let t = targets[key];
      if (rule.share) t = key === "planks" ? roundPlank(t * rule.share) : Math.round(t * rule.share);
      else for (let i = 0; i < rule.steps; i++) t -= stepSize(key, t, rules);
      targets[key] = Math.max(plan.start[key], FLOORS[key], t);
    }
    return { plan: { ...plan, targets, credit: 0, skip: {} }, missed, easedSteps: rule.steps || "share" };
  }

  // Completes `day`: today's targets were planOn(plan, day).plan.targets.
  // result = { totals: {pushups, squats, planks}, sets: {pushups, squats, planks} }
  // (sets = how many sets it took; a plank's "total" is its best hold).
  // Returns the plan for the following days and what happened, so the app
  // can show "Level up!" and friends.
  function completePlanDay(plan, day, result, rules = PLAN_RULES) {
    const eased = planOn(plan, day, rules);
    const today = eased.plan.targets;
    const next = { ...eased.plan, targets: { ...today }, skip: { ...eased.plan.skip }, lastDay: day };
    const events = { levelUp: false, bonus: [], skipped: [], maxed: [], missed: eased.missed, easedSteps: eased.easedSteps };
    const grow = (key) => {
      if (next.targets[key] >= rules.ceiling[key]) return false;
      next.targets[key] = Math.min(rules.ceiling[key], next.targets[key] + stepSize(key, next.targets[key], rules));
      if (next.targets[key] >= rules.ceiling[key]) events.maxed.push(key);
      return true;
    };

    for (const key of EXERCISE_KEYS) {
      const total = (result.totals && result.totals[key]) || 0;
      const sets = (result.sets && result.sets[key]) || 1;
      if (total >= today[key] * rules.crushedShare) {
        if (grow(key)) events.bonus.push(key);
      } else if (sets >= rules.struggledSets) {
        next.skip[key] = true;
      }
    }

    // Rounded so repeated thirds can't drift (and can't dip below zero);
    // three rounded thirds (0.999999) still count as a whole step.
    next.credit = Math.round((eased.plan.credit + (rules.paces[next.pace] ?? rules.paces.regular)) * 1e6) / 1e6;
    if (next.credit >= 1 - 1e-5) {
      next.credit = Math.max(0, Math.round((next.credit - 1) * 1e6) / 1e6);
      for (const key of EXERCISE_KEYS) {
        if (next.skip[key]) {
          delete next.skip[key];
          events.skipped.push(key);
        } else if (grow(key)) {
          events.levelUp = true;
        }
      }
    }
    return { plan: next, events };
  }

  const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

  // When the next level-up comes (counting `day` as the first day) and what
  // it brings, found by living the coming days exactly on target with these
  // same rules - so held steps and the ceiling are always right. null when
  // every target is at the ceiling (the plan just maintains).
  function nextLevelUp(plan, day, rules = PLAN_RULES) {
    let sim = plan;
    for (let i = 0; i < 12; i++) {
      const d = addDays(day, i);
      const target = planOn(sim, d, rules).plan.targets;
      const out = completePlanDay(sim, d, { totals: target, sets: { pushups: 1, squats: 1, planks: 1 } }, rules);
      if (out.events.levelUp || out.events.skipped.length) return { inDays: i + 1, targets: out.plan.targets, held: out.events.skipped };
      sim = out.plan;
    }
    return null;
  }

  // Which exercises fall short of today's plan targets (empty = day done).
  // A plank's total is its best single hold, same as everywhere else.
  function planShortfalls(totals, targets) {
    return EXERCISE_KEYS.filter((key) => (totals[key] || 0) < targets[key]);
  }

  // How many sets each exercise took today - "needed 3+ sets" holds a step.
  function setCountsFromSets(sets) {
    const counts = { pushups: 0, squats: 0, planks: 0 };
    for (const set of sets) {
      if (set.exercise === "pushup") counts.pushups++;
      else if (set.exercise === "squat") counts.squats++;
      else if (set.exercise === "plank") counts.planks++;
    }
    return counts;
  }

  // A brand-new plan for someone who had fixed minimums before plans
  // existed: start from those (inside the floors and the ceiling), Regular
  // pace - so nobody's day gets harder overnight.
  function planFromMinimums(minimums, rules = PLAN_RULES) {
    const targets = {};
    for (const key of EXERCISE_KEYS) {
      const asked = Math.round(Number(minimums && minimums[key]) || 0);
      targets[key] = Math.min(rules.ceiling[key], Math.max(FLOORS[key], asked));
    }
    return newPlan("regular", targets);
  }

  // The plan <-> its player_plans database row.
  function planFromRow(row) {
    return {
      pace: row.pace,
      targets: { pushups: row.pushups, squats: row.squats, planks: row.planks },
      start: { pushups: row.start_pushups, squats: row.start_squats, planks: row.start_planks },
      credit: Number(row.credit) || 0,
      skip: Object.fromEntries((row.skip || []).map((key) => [key, true])),
      lastDay: row.last_day || null,
    };
  }
  function planToRow(userId, plan) {
    return {
      user_id: userId,
      pace: plan.pace,
      pushups: plan.targets.pushups,
      squats: plan.targets.squats,
      planks: plan.targets.planks,
      start_pushups: plan.start.pushups,
      start_squats: plan.start.squats,
      start_planks: plan.start.planks,
      credit: plan.credit,
      skip: EXERCISE_KEYS.filter((key) => plan.skip && plan.skip[key]),
      last_day: plan.lastDay,
    };
  }

  // ---------- Friend challenges ----------
  // Four types: Rep Race (most reps of one exercise), Distance (most distance
  // walked or run), Last One Standing (hit your own plan every day; miss one
  // and you're out) and Climb (everyone does the same targets, which go up
  // every day; miss one and you're out).
  //
  // Each player's challenge day runs midnight to midnight in the time zone
  // they joined from, locked for that challenge. What counts is placed on a
  // day by WHEN the server received it, in that zone - so changing the
  // phone's clock or time zone can't add hours to a day.
  const CHALLENGE_RULES = {
    types: ["rep", "lms", "climb", "dist"],
    dayOptions: [3, 7, 14, 30],
    maxFriends: 10,
    maxActive: 4, // challenges you've joined that haven't ended
    maxCreatesPerDay: 10,
    lmsMaxDays: 30,
    // The climb ends it long before this; it's only a safety net.
    climbMaxDays: 365,
    climbSpeeds: [1, 2, 3], // steps a day: Slow, Medium, Fast
    climbStep: { pushups: 1, squats: 2, planks: 5 },
    climbStartMax: { pushups: 300, squats: 500, planks: 1800 },
    resultsShownDays: 7, // an ended challenge stays on the tab this long
  };

  function isValidTimeZone(timeZone) {
    if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return true;
    } catch (error) {
      return false;
    }
  }

  // "YYYY-MM-DD" in that time zone at that moment. Formatters are slow to
  // make and the server converts many times, so one is kept per zone.
  const dateFormats = new Map();
  function localDate(timeZone, ms) {
    if (!dateFormats.has(timeZone)) dateFormats.set(timeZone, new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }));
    const parts = dateFormats.get(timeZone).formatToParts(new Date(ms));
    const part = (type) => parts.find((p) => p.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  // Checks what the creator picked and keeps only what the type uses.
  // Returns { ok: true, settings } or { ok: false, error }.
  function checkChallengeSettings(input) {
    const rules = CHALLENGE_RULES;
    const s = input || {};
    if (!rules.types.includes(s.type)) return { ok: false, error: "bad_type" };
    if (s.type === "rep") {
      if (!EXERCISE_KEYS.includes(s.exercise)) return { ok: false, error: "bad_exercise" };
      if (!rules.dayOptions.includes(s.days)) return { ok: false, error: "bad_days" };
      return { ok: true, settings: { type: "rep", exercise: s.exercise, days: s.days } };
    }
    if (s.type === "dist") {
      if (!rules.dayOptions.includes(s.days)) return { ok: false, error: "bad_days" };
      return { ok: true, settings: { type: "dist", days: s.days } };
    }
    if (s.type === "lms") return { ok: true, settings: { type: "lms" } };
    if (!rules.climbSpeeds.includes(s.speed)) return { ok: false, error: "bad_speed" };
    const climb = {};
    for (const key of EXERCISE_KEYS) {
      const value = s.climb && s.climb[key];
      if (!Number.isInteger(value) || value < FLOORS[key] || value > rules.climbStartMax[key]) return { ok: false, error: "bad_targets" };
      climb[key] = value;
    }
    return { ok: true, settings: { type: "climb", speed: s.speed, climb } };
  }

  // The last day a challenge can run (inclusive).
  function challengeEndDay(c) {
    const length = c.type === "lms" ? CHALLENGE_RULES.lmsMaxDays : c.type === "climb" ? CHALLENGE_RULES.climbMaxDays : c.days;
    return addDays(c.startDay, length - 1);
  }

  // Day 1 is the start day.
  const challengeDayNumber = (c, day) => daysBetween(c.startDay, day) + 1;

  // A Climb's targets on a given day: Day 1's, plus `speed` steps a day.
  function climbTargetsOn(c, dayNumber) {
    const steps = Math.max(0, dayNumber - 1) * c.speed;
    const targets = {};
    for (const key of EXERCISE_KEYS) targets[key] = c.climb[key] + steps * CHALLENGE_RULES.climbStep[key];
    return targets;
  }

  // One player's result for one challenge day, from the server's own
  // records placed on that day: verified sets [{exercise, value}], walks and
  // runs [{distance_m}], and whether they logged the day (a day post).
  // `value` is what adds up (reps, plank seconds, meters); `done` is whether
  // the day counts as completed (Last One Standing, Climb).
  function challengeDayResult(c, dayNumber, records) {
    const sets = records.sets || [];
    const sum = (exercise) => sets.filter((s) => s.exercise === exercise).reduce((total, s) => total + s.value, 0);
    if (c.type === "rep") {
      // A Plank Race adds up every hold; the other two add up reps.
      const value = sum(c.exercise === "pushups" ? "pushup" : c.exercise === "squats" ? "squat" : "plank");
      return { value, done: true };
    }
    if (c.type === "dist") {
      return { value: (records.walks || []).reduce((total, w) => total + (w.distance_m || 0), 0), done: true };
    }
    if (c.type === "lms") {
      const done = !!records.logged;
      return { value: done ? 1 : 0, done };
    }
    const target = climbTargetsOn(c, dayNumber);
    const totals = totalsFromSets(sets);
    const done = EXERCISE_KEYS.every((key) => totals[key] >= target[key]);
    return { value: done ? 1 : 0, done };
  }

  // A pending challenge starts the moment the first joined player's day 1
  // begins - or is cancelled then, if nobody accepted. Invites close then.
  // Returns "wait", "start" or "cancel".
  function pendingAction(c, joined, nowMs) {
    const started = joined.some((p) => localDate(p.timeZone, nowMs) >= c.startDay);
    if (!started) return "wait";
    return joined.length >= 2 ? "start" : "cancel";
  }

  // The days a player has fully lived through, in their own time zone (up
  // to the challenge's last day), oldest first.
  function finishedDays(c, timeZone, nowMs) {
    const lastFinished = addDays(localDate(timeZone, nowMs), -1);
    const end = challengeEndDay(c);
    const until = lastFinished < end ? lastFinished : end;
    const days = [];
    for (let day = c.startDay; day <= until; day = addDays(day, 1)) days.push(day);
    return days;
  }

  // Last One Standing and Climb: the first finished day a player didn't
  // complete puts them out. `doneDays` is a Set of the days they completed.
  // Returns that day's number, or null if they're still in.
  function firstMissedDay(c, finished, doneDays) {
    const missed = finished.find((day) => !doneDays.has(day));
    return missed ? challengeDayNumber(c, missed) : null;
  }

  // Places from a score where higher is better; ties share a place.
  function placesBy(players, score) {
    const places = {};
    for (const p of players) places[p.userId] = 1 + players.filter((other) => score(other) > score(p)).length;
    return places;
  }

  // Whether a running challenge is over and, if so, everyone's place.
  // players: [{ userId, timeZone, score, outDay (null = still in), doneDays (Set) }]
  // - Rep Race and Distance end when every player's last day is over; most wins.
  // - Last One Standing and Climb end when one is left - but they have to
  //   get through the day the others fell on (if they miss it too, it's a
  //   shared win). If everyone goes out, whoever lasted longest wins. Reaching
  //   the last allowed day ends it with everyone still in sharing the win.
  function challengeOutcome(c, players, nowMs) {
    const end = challengeEndDay(c);
    const allFinished = players.every((p) => localDate(p.timeZone, nowMs) > end);
    if (c.type === "rep" || c.type === "dist") {
      return allFinished ? { over: true, places: placesBy(players, (p) => p.score) } : { over: false };
    }
    const stillIn = players.filter((p) => p.outDay === null);
    const lastOut = Math.max(0, ...players.filter((p) => p.outDay !== null).map((p) => p.outDay));
    let over = allFinished || stillIn.length === 0;
    if (!over && stillIn.length === 1 && lastOut > 0) {
      over = stillIn[0].doneDays.has(addDays(c.startDay, lastOut - 1));
    }
    if (!over) return { over: false };
    return { over: true, places: placesBy(players, (p) => (p.outDay === null ? Infinity : p.outDay)) };
  }

  // Who just got passed: everyone whose place got worse since last time.
  // before/after: { userId: place }.
  function passedPlayers(before, after) {
    return Object.keys(after).filter((userId) => before[userId] !== undefined && after[userId] > before[userId]);
  }

  // What the challenge is called on screen and in notifications.
  function challengeName(c) {
    if (c.type === "rep") return { pushups: "Push-up Race", squats: "Squat Race", planks: "Plank Race" }[c.exercise];
    return { lms: "Last One Standing", climb: "Climb", dist: "Distance Race" }[c.type];
  }

  // The Feed post for a winner, as a feed_events row. `value` is their
  // total (reps, plank seconds, meters) or, for Last One Standing and
  // Climb, how many days they lasted; `days` is how long it ran.
  function challengeFeedPost(userId, day, c, value, days, beaten) {
    return {
      user_id: userId,
      kind: "challenge",
      day,
      challenge_type: c.type,
      challenge_exercise: c.type === "rep" ? c.exercise : null,
      challenge_value: Math.round(value),
      challenge_days: days,
      challenge_beaten: beaten,
    };
  }

  // A challenge <-> its database row.
  function challengeFromRow(row) {
    const c = { id: row.id, type: row.type, startDay: row.start_day, status: row.status, creatorId: row.creator_id };
    if (row.type === "rep") Object.assign(c, { exercise: row.exercise, days: row.days });
    if (row.type === "dist") c.days = row.days;
    if (row.type === "climb") {
      c.speed = row.climb_speed;
      c.climb = { pushups: row.climb_pushups, squats: row.climb_squats, planks: row.climb_planks };
    }
    return c;
  }
  function challengeToRow(creatorId, startDay, s) {
    return {
      creator_id: creatorId,
      type: s.type,
      exercise: s.type === "rep" ? s.exercise : null,
      days: s.type === "rep" || s.type === "dist" ? s.days : null,
      climb_speed: s.type === "climb" ? s.speed : null,
      climb_pushups: s.type === "climb" ? s.climb.pushups : null,
      climb_squats: s.type === "climb" ? s.climb.squats : null,
      climb_planks: s.type === "climb" ? s.climb.planks : null,
      start_day: startDay,
    };
  }

  return {
    FLOORS, REST_DAYS_PER_WEEK, MAX_SETS_PER_DAY, MAX_REPS_PER_DAY, ACTIVITY, PLAN_RULES, EXERCISE_KEYS,
    isValidDay, daysBetween, dayInRange, totalsFromSets, shortfalls, nextStats, feedPost, routeDistanceKm, checkActivity,
    stepSize, startTargets, newPlan, planOn, completePlanDay,
    planShortfalls, setCountsFromSets, planFromMinimums, planFromRow, planToRow, nextLevelUp, addDays,
    CHALLENGE_RULES, isValidTimeZone, localDate, checkChallengeSettings, challengeEndDay, challengeDayNumber,
    climbTargetsOn, challengeDayResult, pendingAction, finishedDays, firstMissedDay, placesBy, challengeOutcome,
    passedPlayers, challengeName, challengeFeedPost, challengeFromRow, challengeToRow,
  };
});
