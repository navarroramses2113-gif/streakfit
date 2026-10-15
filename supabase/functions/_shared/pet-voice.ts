// Every push notification's text, in the pet's voice: blunt and funny,
// never rude. It teases the effort (skipping, the couch), never the person
// - nothing about bodies, weight or looks.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Today's reminder, for someone who hasn't finished their day yet.
// `streak` is the streak they'd keep by working out today (0 = none).
const STREAK_LINES = [
  (n: number) => `Your ${n}-day streak is looking nervous. Go fix that.`,
  (n: number) => `${plural(n, "day")} in. Quitting now would be a weird plot twist.`,
  (n: number) => `I didn't flex for ${plural(n, "day")} to watch you skip tonight.`,
  () => "Push-ups won't do themselves. Trust me, I've asked.",
  (n: number) => `Day ${n + 1} isn't going to earn itself.`,
  () => "Your couch called. I told it you're busy.",
  () => "Squats. Now. I'll wait.",
  (n: number) => `Me and your ${n}-day streak are just sitting here. Waiting. No pressure.`,
];
const FRESH_LINES = [
  () => "Day 1 is the hardest one. Get it over with.",
  () => "Zero-day streak. Bold strategy. Let's change it.",
  () => "No streak to lose. Nothing stopping you either.",
  () => "Fresh start. I'm already warmed up.",
];

// A different line each day, and not the same one for everyone on the
// same day: picked from the person and the date, so a retry on the same
// day picks the same line again.
function pick<T>(lines: T[], seed: string): T {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return lines[hash % lines.length];
}

export function reminder(userId: string, day: string, streak: number) {
  const line = streak > 0 ? pick(STREAK_LINES, userId + day)(streak) : pick(FRESH_LINES, userId + day)();
  return { title: "Forja", body: line };
}

export const friendRequest = (name: string) => ({ title: "Forja", body: `${name} wants in. Let them?` });

// A friend tapped "Nudge". Encouraging, never guilt: the friend is cheering
// you on. `streak` is the streak they'd keep by working out today (0 = none).
const NUDGE_STREAK_LINES = [
  (n: number) => `Your ${n}-day streak is waiting. Show them what you've got!`,
  (n: number) => `Day ${n + 1} is one workout away. They're watching.`,
  () => "They believe in you. I mostly do too.",
  () => "A friend's in your corner. Go make them proud.",
];
const NUDGE_FRESH_LINES = [
  () => "Today's still open. A quick workout and you're on the board.",
  () => "Someone's rooting for you. Day 1 starts now.",
  () => "They want a workout buddy. Don't leave them hanging.",
];

export function nudge(name: string, receiverId: string, day: string, streak: number) {
  const seed = receiverId + day + name;
  const line = streak > 0 ? pick(NUDGE_STREAK_LINES, seed)(streak) : pick(NUDGE_FRESH_LINES, seed)();
  return { title: `${name} nudged you`, body: line };
}

// Challenge texts get the challenge already worded: "a Rep Race",
// "the Rep Race", "The Rep Race" ("Last One Standing" has no article).
export const challengeInvite = (name: string, aChallenge: string) => ({
  title: "Forja",
  body: `${name} just challenged you to ${aChallenge}. You're not scared, right?`,
});
export const passedYou = (name: string, theChallenge: string) => ({
  title: "Forja",
  body: `${name} just passed you in ${theChallenge}. You gonna let that slide?`,
});
export const nobodyJoined = (challenge: string) => ({ title: "Forja", body: `Nobody showed up for your ${challenge}. Their loss.` });
export const youWon = (theChallenge: string) => ({ title: "Forja", body: `You won ${theChallenge}. Never doubted you. (Okay, once.)` });
export const challengeOver = (TheChallenge: string, place: string) => ({
  title: "Forja",
  body: `${TheChallenge} is over. You came ${place}. We'll talk about it.`,
});
