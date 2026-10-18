// Every push notification's text, in the pet's voice: blunt and funny,
// never rude. It teases the effort (skipping, the couch), never the person
// - nothing about bodies, weight or looks.
//
// Each message is English ({ title, body }) with its Spanish riding along
// as `es`; push.ts sends each person the one their app uses (the language
// the app saved in their data). Same line in both, picked the same way.

type Text = { title: string; body: string };
export type Message = Text & { es: Text };
const both = (en: Text, es: Text): Message => ({ ...en, es });
type Line = (n: number) => string;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Spanish counts: "1 día", "2 días".
const cuenta = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dias = (n: number) => cuenta(n, "día", "días");
// The name the server falls back to when there isn't one.
const nombre = (name: string) => (name === "A friend" ? "Un amigo" : name);

// Today's reminder, for someone who hasn't finished their day yet.
// `streak` is the streak they'd keep by working out today (0 = none).
// The English and Spanish lists line up: the same pick in both.
const STREAK_LINES: Line[] = [
  (n: number) => `Your ${n}-day streak is looking nervous. Go fix that.`,
  (n: number) => `${plural(n, "day")} in. Quitting now would be a weird plot twist.`,
  (n: number) => `I didn't flex for ${plural(n, "day")} to watch you skip tonight.`,
  () => "Push-ups won't do themselves. Trust me, I've asked.",
  (n: number) => `Day ${n + 1} isn't going to earn itself.`,
  () => "Your couch called. I told it you're busy.",
  () => "Squats. Now. I'll wait.",
  (n: number) => `Me and your ${n}-day streak are just sitting here. Waiting. No pressure.`,
];
const STREAK_LINES_ES: Line[] = [
  (n: number) => `Tu racha de ${dias(n)} se ve nerviosa. Ve a arreglar eso.`,
  (n: number) => `${dias(n)} seguidos. Rendirte ahora sería un giro de trama muy raro.`,
  (n: number) => `No llevo ${dias(n)} sacando músculo para verte faltar esta noche.`,
  () => "Las flexiones no se hacen solas. Créeme, ya les pregunté.",
  (n: number) => `El día ${n + 1} no se va a ganar solo.`,
  () => "Tu sillón llamó. Le dije que estás ocupado.",
  () => "Sentadillas. Ya. Aquí espero.",
  (n: number) => `Tu racha de ${dias(n)} y yo aquí sentados. Esperando. Sin presión.`,
];
const FRESH_LINES: Line[] = [
  () => "Day 1 is the hardest one. Get it over with.",
  () => "Zero-day streak. Bold strategy. Let's change it.",
  () => "No streak to lose. Nothing stopping you either.",
  () => "Fresh start. I'm already warmed up.",
];
const FRESH_LINES_ES: Line[] = [
  () => "El día 1 es el más difícil. Quítatelo de encima.",
  () => "Racha de cero días. Estrategia valiente. Cambiémosla.",
  () => "No tienes racha que perder. Tampoco nada que te detenga.",
  () => "Empezamos de cero. Yo ya calenté.",
];

// A different line each day, and not the same one for everyone on the
// same day: picked from the person and the date, so a retry on the same
// day picks the same line again.
function pickIndex(count: number, seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % count;
}

export function reminder(userId: string, day: string, streak: number): Message {
  if (streak > 0) {
    const i = pickIndex(STREAK_LINES.length, userId + day);
    return both({ title: "Forja", body: STREAK_LINES[i](streak) }, { title: "Forja", body: STREAK_LINES_ES[i](streak) });
  }
  const i = pickIndex(FRESH_LINES.length, userId + day);
  return both({ title: "Forja", body: FRESH_LINES[i](streak) }, { title: "Forja", body: FRESH_LINES_ES[i](streak) });
}

export const friendRequest = (name: string): Message =>
  both({ title: "Forja", body: `${name} wants in. Let them?` }, { title: "Forja", body: `${nombre(name)} quiere unirse. ¿Le das chance?` });

// A friend tapped "Nudge". Encouraging, never guilt: the friend is cheering
// you on. `streak` is the streak they'd keep by working out today (0 = none).
const NUDGE_STREAK_LINES: Line[] = [
  (n: number) => `Your ${n}-day streak is waiting. Show them what you've got!`,
  (n: number) => `Day ${n + 1} is one workout away. They're watching.`,
  () => "They believe in you. I mostly do too.",
  () => "A friend's in your corner. Go make them proud.",
];
const NUDGE_STREAK_LINES_ES: Line[] = [
  (n: number) => `Tu racha de ${dias(n)} te espera. ¡Demuéstrales lo que tienes!`,
  (n: number) => `El día ${n + 1} está a un entrenamiento. Te están mirando.`,
  () => "Creen en ti. Yo casi siempre también.",
  () => "Alguien está de tu lado. Dale un motivo de orgullo.",
];
const NUDGE_FRESH_LINES: Line[] = [
  () => "Today's still open. A quick workout and you're on the board.",
  () => "Someone's rooting for you. Day 1 starts now.",
  () => "They want a workout buddy. Don't leave them hanging.",
];
const NUDGE_FRESH_LINES_ES: Line[] = [
  () => "Hoy sigue abierto. Un entrenamiento rápido y ya estás en la tabla.",
  () => "Alguien te está echando porras. El día 1 empieza ahora.",
  () => "Quieren alguien con quien entrenar. No los dejes plantados.",
];

export function nudge(name: string, receiverId: string, day: string, streak: number): Message {
  const seed = receiverId + day + name;
  const lines = streak > 0 ? [NUDGE_STREAK_LINES, NUDGE_STREAK_LINES_ES] : [NUDGE_FRESH_LINES, NUDGE_FRESH_LINES_ES];
  const i = pickIndex(lines[0].length, seed);
  return both({ title: `${name} nudged you`, body: lines[0][i](streak) }, { title: `Empujón de ${name === "A friend" ? "un amigo" : name}`, body: lines[1][i](streak) });
}

// Challenge texts get the challenge already worded in English: "a Rep
// Race", "the Rep Race", "The Rep Race" ("Last One Standing" has no
// article). Spanish words it again from the bare name.
const CHALLENGE_NAMES_ES: Record<string, string> = {
  "Push-up Race": "Carrera de flexiones",
  "Squat Race": "Carrera de sentadillas",
  "Plank Race": "Carrera de plancha",
  "Distance Race": "Carrera de distancia",
  Climb: "Escalada",
  "Last One Standing": "El último en pie",
};
const bare = (worded: string) => worded.replace(/^(a|an|the) /i, "");
const reto = (worded: string) => CHALLENGE_NAMES_ES[bare(worded)] || bare(worded);
// "la Carrera de flexiones" (every Spanish name but "El último en pie" takes "la").
const laReto = (worded: string) => (reto(worded).startsWith("El ") ? reto(worded) : `la ${reto(worded)}`);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const challengeInvite = (name: string, aChallenge: string): Message =>
  both(
    { title: "Forja", body: `${name} just challenged you to ${aChallenge}. You're not scared, right?` },
    { title: "Forja", body: `${nombre(name)} te retó: ${reto(aChallenge)}. No tienes miedo, ¿verdad?` },
  );
export const passedYou = (name: string, theChallenge: string): Message =>
  both(
    { title: "Forja", body: `${name} just passed you in ${theChallenge}. You gonna let that slide?` },
    { title: "Forja", body: `${nombre(name)} te acaba de pasar en ${laReto(theChallenge)}. ¿Vas a dejarlo así?` },
  );
export const nobodyJoined = (challenge: string): Message =>
  both({ title: "Forja", body: `Nobody showed up for your ${challenge}. Their loss.` }, { title: "Forja", body: `Nadie se unió a tu reto (${reto(challenge)}). Ellos se lo pierden.` });
export const youWon = (theChallenge: string): Message =>
  both({ title: "Forja", body: `You won ${theChallenge}. Never doubted you. (Okay, once.)` }, { title: "Forja", body: `Ganaste ${laReto(theChallenge)}. Nunca dudé de ti. (Bueno, una vez.)` });
export const challengeOver = (TheChallenge: string, place: string): Message =>
  both(
    { title: "Forja", body: `${TheChallenge} is over. You came ${place}. We'll talk about it.` },
    { title: "Forja", body: `${capital(laReto(TheChallenge))} terminó. Quedaste en ${parseInt(place, 10)}.º lugar. Ya hablaremos de eso.` },
  );

// Someone signed up (or came in) through your invite link.
export const inviteJoined = (name: string): Message =>
  both(
    { title: "Forja", body: `${name} joined from your link. You're friends now. Show them how it's done.` },
    { title: "Forja", body: `${nombre(name)} se unió con tu enlace. Ya son amigos. Enséñale cómo se hace.` },
  );

// Monday morning: last week in one line. Zeros are left out; `distance` is
// already worded in their units ("" = none); `place` and `of` are the league finish (0 = none).
export function weeklyRecap(days: number, totals: { pushups: number; squats: number; plankSeconds: number; distance: string }, place: number, of: number): Message {
  const plank = `${Math.floor(totals.plankSeconds / 60)}:${String(totals.plankSeconds % 60).padStart(2, "0")}`;
  const parts: string[] = [];
  const partes: string[] = [];
  if (totals.pushups > 0) {
    parts.push(plural(totals.pushups, "push-up"));
    partes.push(cuenta(totals.pushups, "flexión", "flexiones"));
  }
  if (totals.squats > 0) {
    parts.push(plural(totals.squats, "squat"));
    partes.push(cuenta(totals.squats, "sentadilla", "sentadillas"));
  }
  if (totals.plankSeconds > 0) {
    parts.push(`${plank} of plank`);
    partes.push(`${plank} de plancha`);
  }
  if (totals.distance) {
    parts.push(`${totals.distance} walked`);
    partes.push(`${totals.distance} caminados`);
  }
  const mood = days >= 6 ? "Monster week." : days >= 4 ? "Strong week." : days >= 2 ? "Solid start." : "A start is a start.";
  const animo = days >= 6 ? "Semana monstruosa." : days >= 4 ? "Semana fuerte." : days >= 2 ? "Buen comienzo." : "Empezar ya es algo.";
  const league = place > 0 && of > 1 ? ` #${place} of ${of} in your league.` : "";
  const liga = place > 0 && of > 1 ? ` #${place} de ${of} en tu liga.` : "";
  return both(
    { title: `Your week: ${plural(days, "day")}`, body: `${mood} ${parts.join(", ") || "Every day counted"}.${league}` },
    { title: `Tu semana: ${dias(days)}`, body: `${animo} ${partes.join(", ") || "Cada día contó"}.${liga}` },
  );
}
