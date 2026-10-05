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
  // only from the server's own totals and streak math.
  function feedPost(userId, day, totals, before, after) {
    return {
      user_id: userId,
      day,
      streak: after.streak,
      pushups: totals.pushups,
      plank_seconds: totals.planks,
      squats: totals.squats,
      new_best: after.streak > (before.bestStreak || 0) && after.streak >= NEW_BEST_MIN_STREAK,
    };
  }

  return { FLOORS, REST_DAYS_PER_WEEK, MAX_SETS_PER_DAY, MAX_REPS_PER_DAY, isValidDay, daysBetween, dayInRange, totalsFromSets, shortfalls, nextStats, feedPost };
});
