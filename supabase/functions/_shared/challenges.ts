// Friend challenges on the server. What the `challenge` function does
// (create, accept or decline, list, mark results seen) and what the
// `challenge-tick` schedule does every 15 minutes (start, save finished
// days, put people out, tell people they've been passed, end). The
// database client, the push sender and the clock are passed in, so all of
// it can be tested away from Supabase.
//
// Scores come only from what the server itself recorded - verified camera
// sets, walk/run posts and day posts - each placed on a challenge day by
// WHEN the server received it, in the time zone the player joined from.
import "./game-rules.js";
import * as pet from "./pet-voice.ts";

// deno-lint-ignore no-explicit-any
const rules = (globalThis as any).ForjaRules;

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = any;
type Push = (userIds: string[], payload: { title: string; body: string }) => Promise<unknown>;
export type Deps = { admin: Db; push: Push; now: number };
type Reply = { status: number; body: Record<string, unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86400000;
const PAGE = 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const ok = (body: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, ...body } });
const fail = (error: string, status = 400): Reply => ({ status, body: { ok: false, error } });

// "a Push-up Race" / "Last One Standing", "The Climb is over" / "Last One Standing is over".
const withArticle = (name: string) => (name === "Last One Standing" ? name : `a ${name}`);
const withThe = (name: string) => (name === "Last One Standing" ? name : `the ${name}`);
const capitalized = (text: string) => text[0].toUpperCase() + text.slice(1);
function ordinal(n: number) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

// Every row a query matches, a page at a time (the API hands back at most
// 1000 rows per request).
async function selectAll(build: (from: number, to: number) => Promise<{ data: Row[] | null; error: Row }>) {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

async function usernames(admin: Db, userIds: string[]) {
  const names = new Map<string, string>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return names;
  const rows = await selectAll((from, to) => admin.from("profiles").select("user_id, username").in("user_id", ids).range(from, to));
  for (const row of rows) names.set(row.user_id, row.username);
  return names;
}

// ---------- the server's records, placed on challenge days ----------

// Verified sets, walk/run posts and day posts for these players since
// `sinceMs`, each with when it reached the server.
async function loadRecords(admin: Db, userIds: string[], sinceMs: number) {
  if (userIds.length === 0) return { sets: [], posts: [] };
  const since = iso(sinceMs);
  const sets = await selectAll((from, to) =>
    admin.from("verified_sets").select("user_id, exercise, value, created_at").in("user_id", userIds).gte("created_at", since).order("created_at").range(from, to)
  );
  const posts = await selectAll((from, to) =>
    admin.from("feed_events").select("user_id, kind, distance_m, created_at").in("user_id", userIds).in("kind", ["day", "walk", "run"]).gte("created_at", since).order("created_at").range(from, to)
  );
  return { sets, posts };
}

// One player's records grouped by the day they landed on in that player's
// time zone: Map day -> { sets, walks, logged }.
function recordsByDay(records: { sets: Row[]; posts: Row[] }, userId: string, timeZone: string) {
  const days = new Map<string, { sets: Row[]; walks: Row[]; logged: boolean }>();
  const dayOf = (row: Row) => {
    const day = rules.localDate(timeZone, new Date(row.created_at).getTime());
    if (!days.has(day)) days.set(day, { sets: [], walks: [], logged: false });
    return days.get(day)!;
  };
  for (const set of records.sets) if (set.user_id === userId) dayOf(set).sets.push(set);
  for (const post of records.posts) {
    if (post.user_id !== userId) continue;
    if (post.kind === "day") dayOf(post).logged = true;
    else dayOf(post).walks.push(post);
  }
  return days;
}
const NO_RECORDS = { sets: [], walks: [], logged: false };

// Saved days for a challenge: Map userId -> Map day -> { value, done }.
async function savedDays(admin: Db, challengeIds: string[]) {
  const byPlayer = new Map<string, Map<string, Map<string, { value: number; done: boolean }>>>();
  if (challengeIds.length === 0) return byPlayer;
  const rows = await selectAll((from, to) =>
    admin.from("challenge_days").select("challenge_id, user_id, day, value, done").in("challenge_id", challengeIds).range(from, to)
  );
  for (const row of rows) {
    const key = `${row.challenge_id}/${row.user_id}`;
    if (!byPlayer.has(key)) byPlayer.set(key, new Map());
    byPlayer.get(key)!.set(dayString(row.day), { value: Number(row.value), done: !!row.done });
  }
  return byPlayer;
}
// Dates come back as "YYYY-MM-DD" from the API (or as Dates in tests).
const dayString = (day: string | Date) => (typeof day === "string" ? day.slice(0, 10) : day.toISOString().slice(0, 10));

// A player's standing right now: saved days plus any day not saved yet
// (today, or yesterday until the next tick saves it), from live records.
function liveStanding(c: Row, player: Row, saved: Map<string, { value: number; done: boolean }>, live: Map<string, Row>, now: number) {
  const today = rules.localDate(player.time_zone, now);
  const end = rules.challengeEndDay(c);
  const last = today < end ? today : end;
  let score = 0;
  let todayValue = 0;
  let doneToday = false;
  for (let day = c.startDay; day <= last; day = rules.addDays(day, 1)) {
    const result = saved.get(day) ?? rules.challengeDayResult(c, rules.challengeDayNumber(c, day), live.get(day) ?? NO_RECORDS);
    score += result.value;
    if (day === today) {
      todayValue = result.value;
      doneToday = result.done;
    }
  }
  return { score, todayValue, doneToday };
}

// ---------- the 15-minute check ----------

export async function tick(deps: Deps) {
  const rows = await selectAll((from, to) => deps.admin.from("challenges").select("*").in("status", ["pending", "running"]).range(from, to));
  let failed = 0;
  for (const row of rows) {
    try {
      await tickChallenge(deps, row);
    } catch (err) {
      failed++;
      console.error("challenge tick failed", row.id, String((err as Error).message ?? err));
    }
  }
  return { checked: rows.length, failed };
}

const challengeOf = (row: Row) => rules.challengeFromRow({ ...row, start_day: dayString(row.start_day) });

async function tickChallenge(deps: Deps, row: Row) {
  const { admin, push, now } = deps;
  const c = challengeOf(row);
  const name = rules.challengeName(c);
  const { data: players, error } = await admin.from("challenge_players").select("*").eq("challenge_id", c.id);
  if (error) throw new Error(error.message);
  const joined = (players || []).filter((p: Row) => p.status === "joined");

  if (c.status === "pending") {
    const action = rules.pendingAction(c, joined.map((p: Row) => ({ userId: p.user_id, timeZone: p.time_zone })), now);
    if (action === "wait") return;
    // Claimed with the status check, so two runs at once can't both act.
    const next = action === "start" ? "running" : "cancelled";
    const { data: claimed } = await admin
      .from("challenges")
      .update(next === "cancelled" ? { status: next, ended_at: iso(now) } : { status: next })
      .eq("id", c.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed || claimed.length === 0) return;
    if (next === "cancelled") {
      if (c.creatorId) await push([c.creatorId], pet.nobodyJoined(name));
      return;
    }
    c.status = "running";
  }

  // Save every finished day that isn't saved yet, so scores never depend
  // on posts or sets that get cleaned up later.
  const saved = await savedDays(admin, [c.id]);
  const savedFor = (userId: string) => {
    const key = `${c.id}/${userId}`;
    if (!saved.has(key)) saved.set(key, new Map());
    return saved.get(key)!;
  };
  const unsaved: { player: Row; day: string }[] = [];
  for (const player of joined) {
    for (const day of rules.finishedDays(c, player.time_zone, now)) {
      if (!savedFor(player.user_id).has(day)) unsaved.push({ player, day });
    }
  }
  if (unsaved.length > 0) {
    const earliest = unsaved.reduce((min, u) => (u.day < min ? u.day : min), unsaved[0].day);
    const records = await loadRecords(admin, [...new Set(unsaved.map((u) => u.player.user_id))], Date.parse(earliest + "T00:00:00Z") - DAY_MS);
    const grouped = new Map<string, Map<string, Row>>();
    const rowsToSave = unsaved.map(({ player, day }) => {
      if (!grouped.has(player.user_id)) grouped.set(player.user_id, recordsByDay(records, player.user_id, player.time_zone));
      const result = rules.challengeDayResult(c, rules.challengeDayNumber(c, day), grouped.get(player.user_id)!.get(day) ?? NO_RECORDS);
      savedFor(player.user_id).set(day, result);
      return { challenge_id: c.id, user_id: player.user_id, day, value: result.value, done: result.done };
    });
    const { error: saveError } = await admin.from("challenge_days").upsert(rowsToSave, { onConflict: "challenge_id,user_id,day", ignoreDuplicates: true });
    if (saveError) throw new Error(saveError.message);
  }

  // Last One Standing and Climb: a finished day that wasn't completed puts
  // that player out.
  if (c.type === "lms" || c.type === "climb") {
    for (const player of joined) {
      if (player.out_day !== null && player.out_day !== undefined) continue;
      const doneDays = new Set([...savedFor(player.user_id)].filter(([, d]) => d.done).map(([day]) => day));
      const out = rules.firstMissedDay(c, rules.finishedDays(c, player.time_zone, now), doneDays);
      if (out === null) continue;
      await admin.from("challenge_players").update({ out_day: out }).eq("challenge_id", c.id).eq("user_id", player.user_id);
      player.out_day = out;
    }
  }

  const standings = joined.map((player: Row) => {
    const days = savedFor(player.user_id);
    return {
      userId: player.user_id,
      timeZone: player.time_zone,
      score: [...days.values()].reduce((sum, d) => sum + d.value, 0),
      outDay: player.out_day ?? null,
      doneDays: new Set([...days].filter(([, d]) => d.done).map(([day]) => day)),
    };
  });

  if (c.type === "rep" || c.type === "dist") await notifyPassed(deps, c, name, joined, saved);

  const outcome = rules.challengeOutcome(c, standings, now);
  if (outcome.over) await endChallenge(deps, c, name, joined, standings, outcome.places);
}

// Rep Race and Distance: "jess_runs passed you in the Push-up Race", at
// most once a day per player, and only when someone who was behind you
// is now ahead (so everyone starting at 0 doesn't set it off).
async function notifyPassed(deps: Deps, c: Row, name: string, joined: Row[], saved: Map<string, Map<string, { value: number; done: boolean }>>) {
  const { admin, push, now } = deps;
  const records = await loadRecords(admin, joined.map((p) => p.user_id), now - 2 * DAY_MS);
  const scores: Record<string, number> = {};
  for (const player of joined) {
    const live = recordsByDay(records, player.user_id, player.time_zone);
    scores[player.user_id] = liveStanding(c, player, saved.get(`${c.id}/${player.user_id}`) ?? new Map(), live, now).score;
  }
  const after = rules.placesBy(joined.map((p) => ({ userId: p.user_id })), (p: Row) => scores[p.userId]);
  const before: Record<string, number> = {};
  for (const player of joined) if (player.rank) before[player.user_id] = player.rank;

  const passed = rules.passedPlayers(before, after);
  let names: Map<string, string> | null = null;
  for (const userId of passed) {
    const player = joined.find((p) => p.user_id === userId);
    const today = rules.localDate(player.time_zone, now);
    // Their last day is over: the result says it all.
    if (today > rules.challengeEndDay(c)) continue;
    if (player.passed_notified_on && dayString(player.passed_notified_on) === today) continue;
    const passer = joined.find((p) => before[p.user_id] > before[userId] && after[p.user_id] < after[userId]);
    if (!passer) continue;
    names = names ?? (await usernames(admin, joined.map((p) => p.user_id)));
    await push([userId], pet.passedYou(names.get(passer.user_id) || "A friend", withThe(name)));
    await admin.from("challenge_players").update({ passed_notified_on: today }).eq("challenge_id", c.id).eq("user_id", userId);
  }
  for (const player of joined) {
    if (player.rank !== after[player.user_id]) {
      await admin.from("challenge_players").update({ rank: after[player.user_id] }).eq("challenge_id", c.id).eq("user_id", player.user_id);
    }
  }
}

async function endChallenge(deps: Deps, c: Row, name: string, joined: Row[], standings: Row[], places: Record<string, number>) {
  const { admin, push, now } = deps;
  const { data: claimed } = await admin.from("challenges").update({ status: "ended", ended_at: iso(now) }).eq("id", c.id).eq("status", "running").select("id");
  if (!claimed || claimed.length === 0) return;

  for (const player of joined) {
    await admin.from("challenge_players").update({ place: places[player.user_id] }).eq("challenge_id", c.id).eq("user_id", player.user_id);
  }

  const winners = standings.filter((s) => places[s.userId] === 1);
  const beaten = standings.length - winners.length;
  for (const winner of winners) {
    const lasted = winner.doneDays.size;
    const racing = c.type === "rep" || c.type === "dist";
    const post = rules.challengeFeedPost(
      winner.userId,
      rules.localDate(winner.timeZone, now),
      c,
      racing ? winner.score : lasted,
      racing ? c.days : Math.max(1, lasted),
      beaten
    );
    // The challenge is over either way; a Feed hiccup only loses the post.
    const { error } = await admin.from("feed_events").insert(post);
    if (error) console.error("challenge feed post failed", error.message);
  }

  const results: Promise<unknown>[] = [];
  for (const player of joined) {
    const place = places[player.user_id];
    const message = place === 1 ? pet.youWon(withThe(name)) : pet.challengeOver(capitalized(withThe(name)), ordinal(place));
    results.push(push([player.user_id], message));
  }
  await Promise.all(results);
}

// ---------- what the app asks for ----------

export async function handle(deps: Deps, userId: string, body: Row): Promise<Reply> {
  const action = body && body.action;
  if (action === "list") return listChallenges(deps, userId, body.timeZone);
  if (action === "create") return createChallenge(deps, userId, body);
  if (action === "respond") return respond(deps, userId, body);
  if (action === "seen") return markSeen(deps, userId, body);
  return fail("bad_action");
}

// How many unfinished challenges this player has joined.
async function activeCount(admin: Db, userId: string) {
  const mine = await selectAll((from, to) =>
    admin.from("challenge_players").select("challenge_id").eq("user_id", userId).eq("status", "joined").range(from, to)
  );
  if (mine.length === 0) return 0;
  const active = await selectAll((from, to) =>
    admin.from("challenges").select("id").in("id", mine.map((r) => r.challenge_id)).in("status", ["pending", "running"]).range(from, to)
  );
  return active.length;
}

async function createChallenge(deps: Deps, userId: string, body: Row): Promise<Reply> {
  const { admin, push, now } = deps;
  if (!rules.isValidTimeZone(body.timeZone)) return fail("bad_time_zone");
  const checked = rules.checkChallengeSettings(body);
  if (!checked.ok) return fail(checked.error);

  const friendIds = body.friendIds;
  if (!Array.isArray(friendIds) || friendIds.length === 0 || friendIds.length > rules.CHALLENGE_RULES.maxFriends) return fail("bad_friends");
  if (friendIds.some((id: unknown) => typeof id !== "string" || !UUID.test(id) || id === userId)) return fail("bad_friends");
  if (new Set(friendIds).size !== friendIds.length) return fail("bad_friends");

  // Friends only: every invitee must be an accepted friend right now.
  const friendships = await selectAll((from, to) =>
    admin.from("friendships").select("requester_id, addressee_id").eq("status", "accepted").or(`requester_id.eq.${userId},addressee_id.eq.${userId}`).range(from, to)
  );
  const friends = new Set(friendships.map((f) => (f.requester_id === userId ? f.addressee_id : f.requester_id)));
  if (!friendIds.every((id: string) => friends.has(id))) return fail("not_friends", 403);

  if ((await activeCount(admin, userId)) >= rules.CHALLENGE_RULES.maxActive) return fail("too_many", 409);
  const madeToday = await selectAll((from, to) =>
    admin.from("challenges").select("id").eq("creator_id", userId).gte("created_at", iso(now - DAY_MS)).range(from, to)
  );
  if (madeToday.length >= rules.CHALLENGE_RULES.maxCreatesPerDay) return fail("rate_limited", 429);

  // Day 1 is tomorrow for the creator, so nobody gets a head start.
  const startDay = rules.addDays(rules.localDate(body.timeZone, now), 1);
  const { data: created, error } = await admin.from("challenges").insert(rules.challengeToRow(userId, startDay, checked.settings)).select("id");
  if (error || !created || created.length === 0) return fail("server_error", 500);
  const challengeId = created[0].id;

  const { error: playersError } = await admin.from("challenge_players").insert([
    { challenge_id: challengeId, user_id: userId, status: "joined", time_zone: body.timeZone, joined_at: iso(now) },
    ...friendIds.map((id: string) => ({ challenge_id: challengeId, user_id: id, status: "invited" })),
  ]);
  if (playersError) {
    await admin.from("challenges").delete().eq("id", challengeId);
    return fail("server_error", 500);
  }

  const names = await usernames(admin, [userId]);
  const name = rules.challengeName(checked.settings);
  await push(friendIds, pet.challengeInvite(names.get(userId) || "A friend", withArticle(name)));
  return ok({ challengeId, startDay });
}

async function respond(deps: Deps, userId: string, body: Row): Promise<Reply> {
  const { admin, now } = deps;
  if (typeof body.challengeId !== "string" || !UUID.test(body.challengeId)) return fail("bad_challenge");
  const accept = body.accept === true;
  if (accept && !rules.isValidTimeZone(body.timeZone)) return fail("bad_time_zone");

  const { data: invite } = await admin
    .from("challenge_players")
    .select("status")
    .eq("challenge_id", body.challengeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!invite || invite.status !== "invited") return fail("not_invited", 404);
  const { data: challenge } = await admin.from("challenges").select("*").eq("id", body.challengeId).maybeSingle();
  if (!challenge) return fail("not_found", 404);
  // Invites close when the challenge starts.
  const startDay = dayString(challenge.start_day);
  if (challenge.status !== "pending") return fail("closed", 409);
  if (accept) {
    if (rules.localDate(body.timeZone, now) >= startDay) return fail("closed", 409);
    if ((await activeCount(admin, userId)) >= rules.CHALLENGE_RULES.maxActive) return fail("too_many", 409);
  }

  const { data: updated } = await admin
    .from("challenge_players")
    .update(accept ? { status: "joined", time_zone: body.timeZone, joined_at: iso(now) } : { status: "declined" })
    .eq("challenge_id", body.challengeId)
    .eq("user_id", userId)
    .eq("status", "invited")
    .select("challenge_id");
  if (!updated || updated.length === 0) return fail("not_invited", 404);
  return ok({ joined: accept, startDay });
}

async function markSeen(deps: Deps, userId: string, body: Row): Promise<Reply> {
  if (typeof body.challengeId !== "string" || !UUID.test(body.challengeId)) return fail("bad_challenge");
  await deps.admin.from("challenge_players").update({ result_seen: true }).eq("challenge_id", body.challengeId).eq("user_id", userId);
  return ok();
}

// Everything the Competition tab shows: invites, pending and running
// challenges with live standings, recently ended ones, and trophies.
async function listChallenges(deps: Deps, userId: string, timeZone: unknown): Promise<Reply> {
  const { admin, now } = deps;
  const zone = rules.isValidTimeZone(timeZone) ? (timeZone as string) : "UTC";
  const mine = await selectAll((from, to) =>
    admin.from("challenge_players").select("*").eq("user_id", userId).in("status", ["invited", "joined"]).range(from, to)
  );
  if (mine.length === 0) return ok({ challenges: [], trophies: [] });
  const meIn = new Map(mine.map((r) => [r.challenge_id, r]));
  const rows = await selectAll((from, to) => admin.from("challenges").select("*").in("id", [...meIn.keys()]).range(from, to));

  const shownSince = now - rules.CHALLENGE_RULES.resultsShownDays * DAY_MS;
  const shown = rows.filter((row) => {
    const me = meIn.get(row.id);
    if (me.status === "invited") return row.status === "pending";
    if (row.status === "pending" || row.status === "running") return true;
    return !!row.ended_at && new Date(row.ended_at).getTime() >= shownSince;
  });
  const trophies = rows
    .filter((row) => row.status === "ended" && meIn.get(row.id).place === 1)
    .sort((a, b) => new Date(b.ended_at).getTime() - new Date(a.ended_at).getTime())
    .map((row) => ({ name: rules.challengeName(challengeOf(row)), endedAt: row.ended_at }));
  if (shown.length === 0) return ok({ challenges: [], trophies });

  const ids = shown.map((row) => row.id);
  const players = await selectAll((from, to) => admin.from("challenge_players").select("*").in("challenge_id", ids).range(from, to));
  const saved = await savedDays(admin, ids);
  const names = await usernames(admin, [...players.map((p) => p.user_id), ...shown.map((row) => row.creator_id)]);
  const liveIds = [...new Set(players.filter((p) => p.status === "joined").map((p) => p.user_id))];
  const records = await loadRecords(admin, liveIds, now - 2 * DAY_MS);
  const liveByPlayer = new Map<string, Map<string, Row>>();

  const challenges = shown.map((row) => {
    const c = challengeOf(row);
    const me = meIn.get(row.id);
    const theirs = players.filter((p) => p.challenge_id === row.id);
    const joined = theirs.filter((p) => p.status === "joined");
    const myDay = me.status === "joined" ? rules.localDate(me.time_zone, now) : rules.localDate(zone, now);
    const dayNumber = rules.challengeDayNumber(c, myDay);

    const standings = joined.map((player) => {
      const key = `${player.user_id}|${player.time_zone}`;
      if (!liveByPlayer.has(key)) liveByPlayer.set(key, recordsByDay(records, player.user_id, player.time_zone));
      const standing =
        row.status === "pending"
          ? { score: 0, todayValue: 0, doneToday: false }
          : liveStanding(c, player, saved.get(`${row.id}/${player.user_id}`) ?? new Map(), liveByPlayer.get(key)!, now);
      return {
        userId: player.user_id,
        name: names.get(player.user_id) || "Unknown",
        you: player.user_id === userId,
        score: standing.score,
        today: standing.todayValue,
        doneToday: standing.doneToday,
        outDay: player.out_day ?? null,
        place: player.place ?? null,
      };
    });
    // Races: most first. Last One Standing / Climb: still in first, then
    // whoever lasted longest.
    const racing = c.type === "rep" || c.type === "dist";
    const rank = (s: Row) => (racing ? s.score : s.outDay === null ? Infinity : s.outDay);
    standings.sort((a, b) => (rank(a) === rank(b) ? 0 : rank(b) > rank(a) ? 1 : -1));

    return {
      id: row.id,
      type: c.type,
      exercise: c.exercise ?? null,
      days: c.days ?? null,
      speed: c.speed ?? null,
      name: rules.challengeName(c),
      status: row.status,
      myStatus: me.status,
      from: names.get(row.creator_id) || null,
      fromYou: row.creator_id === userId,
      startDay: c.startDay,
      dayNumber,
      joinedCount: joined.length,
      invitedCount: theirs.filter((p) => p.status === "invited").length,
      players: standings,
      targets: c.type === "climb" ? { today: rules.climbTargetsOn(c, Math.max(1, dayNumber)), tomorrow: rules.climbTargetsOn(c, Math.max(1, dayNumber) + 1) } : null,
      myPlace: me.place ?? null,
      unseenResult: row.status === "ended" && !me.result_seen,
    };
  });
  return ok({ challenges, trophies });
}
