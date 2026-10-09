// Celebrations on Today, kept small on purpose:
// - a saved set counts up, with a "+25" floating off its card;
// - an exercise that reaches its target gets a green check on its tag;
// - a finished day closes the ring into one full circle with the pet's
//   face inside (and it stays that way for the rest of the day);
// - every 7th day of a streak gets one full-screen celebration, where the
//   pet comes alive and flexes;
// - on days the plan steps up, the line under the ring says so.
// Each moment waits until Today is actually on screen (e.g. after the
// camera closes). With Reduce Motion nothing moves; the end states still show.

// ---------- the flexing pet ----------
// The pet, flexing: a cartoon in one SVG with joints (shoulders, elbows, a
// bicep that swells) and a few faces it switches between. FlexPet.svg()
// draws it; FlexPet.play(svg) runs it once (about 3.3 s), then it keeps
// breathing, blinking and flexing now and then until it's removed.
//
// The story: it pops up surprised, lands with a squish, scrunches up its
// face and crouches, jumps - arms burst out and curl into a flex - lands
// with an angry flex face, pumps twice with a "ting", winks, and relaxes
// into a proud smile. Every later flex brings the angry face back.
const FlexPet = (function () {
  const INK = "#1c1c1e";
  const FACE = "#fff6ea";
  const TONGUE = "#ff7a8a";
  // Where things sit in the drawing (ring center 50,60; radius 36), for the
  // right arm; the left one is mirrored.
  const SHOULDER = [86, 68];
  const ELBOW = [118, 68];
  const BICEP = [102, 63];

  const star = (x, y, r, cls) => `<path class="${cls}" style="transform-origin:${x}px ${y}px" d="M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r} Z" fill="var(--ring-planks)"/>`;

  // One arm in the flex pose (upper arm out, forearm up), drawn like the
  // rest of the pet: flat ring color, one darker shade for the underside,
  // one white shine on the bicep. side -1 mirrors every x around the
  // pet's middle (path points are written "x,y" so they can be mirrored).
  function arm(side, color) {
    const x = (v) => (side > 0 ? v : 100 - v);
    const P = (d) => d.replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, a, b) => `${+x(+a).toFixed(2)} ${b}`);
    const o = (p) => `transform-origin:${x(p[0])}px ${p[1]}px`;
    const shade = `fill="#000" fill-opacity="0.16"`;
    const crease = `fill="none" stroke="${INK}" stroke-opacity="0.3" stroke-width="1.8" stroke-linecap="round"`;
    return `<g class="fp-arm" data-side="${side}" style="${o(SHOULDER)}">
      <path d="${P("M82,59 L114,60 C122,60 126,64 126,70 C126,76 121,78 114,77.5 C104,80.5 92,80.5 82,77.5 Z")}" fill="${color}"/>
      <path d="${P("M86,75.5 C96,79 108,79 116,75.5 C121,74 124.5,72.5 126,70 C126,76 121,78 114,77.5 C104,80.5 92,80.5 84,77.8 Z")}" ${shade}/>
      <g class="fp-bicep" style="${o(BICEP)}">
        <path d="${P("M88,63.5 C87.5,50 97,43.5 105,45.5 C113,47.5 115.5,56 113.5,63.5 Z")}" fill="${color}"/>
        <path d="${P("M93.5,53 C96.5,48.5 102,47.5 106,49.5")}" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="2.6" stroke-linecap="round"/>
      </g>
      <g class="fp-forearm" style="${o(ELBOW)}">
        <path d="${P("M109,68 C107,60 108,52 111,44 L125,44 C128,52 129.5,60 127,68 Z")}" fill="${color}"/>
        <path d="${P("M109,68 C107,60 108,52 111,44 L114,44 C112,52 112,60 113,68 Z")}" ${shade}/>
        <rect x="${Math.min(x(107), x(129))}" y="23" width="22" height="23" rx="8" fill="${color}"/>
        <path d="${P("M107.5,29.5 L113,29.5 M107.5,34.5 L113,34.5 M107.5,39.5 L113,39.5 M110,24.5 C114,22.5 120,23 123,27")}" ${crease}/>
      </g>
    </g>`;
  }

  function svg() {
    const ringArc = (color, offset) => `<circle cx="50" cy="60" r="36" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-dasharray="54 172.2" stroke-dashoffset="${offset}"/>`;
    const openEye = (cx, cls) => `<g class="${cls}" style="transform-origin:${cx}px 56px"><ellipse cx="${cx}" cy="56" rx="5.8" ry="7" fill="${INK}"/><circle cx="${cx + 1.7}" cy="53.6" r="1.8" fill="#fff"/></g>`;
    const happyEye = (cx, cls) => `<path class="${cls}" d="M${cx - 6} 58 Q${cx} 49 ${cx + 6} 58" fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round"/>`;
    // Angry: the top of each eye cut off by a lid that slopes down to the nose.
    const m = (v) => 100 - v;
    const angryEyes = `<g class="fp-angry-eyes" fill="${INK}">
      <path d="M34.5 51.5 L47.5 56 C47.5 61.5 45 64 41 64 C36.8 64 34.5 60.5 34.5 51.5 Z"/><circle cx="43.2" cy="59" r="1.5" fill="#fff"/>
      <path d="M${m(34.5)} 51.5 L${m(47.5)} 56 C${m(47.5)} 61.5 ${m(45)} 64 ${m(41)} 64 C${m(36.8)} 64 ${m(34.5)} 60.5 ${m(34.5)} 51.5 Z"/><circle cx="${m(38.8)}" cy="59" r="1.5" fill="#fff"/>
    </g>`;
    // The "anger mark" on top of the head: four curved strokes, pulsing.
    const vein = `<g class="fp-vein" style="transform-origin:50px 19px" fill="none" stroke="var(--ring-pushups)" stroke-width="2.8" stroke-linecap="round">
      <path d="M47.5 13 Q47.5 16.5 44 16.5"/><path d="M52.5 13 Q52.5 16.5 56 16.5"/><path d="M47.5 25 Q47.5 21.5 44 21.5"/><path d="M52.5 25 Q52.5 21.5 56 21.5"/>
    </g>`;
    return `<svg class="flex-pet" viewBox="-36 -26 172 162" aria-hidden="true">
      <ellipse class="fp-shadow" cx="50" cy="112" rx="30" ry="4.5" style="transform-origin:50px 112px"/>
      <g class="fp-jump">
        <g class="fp-squash" style="transform-origin:50px 104px">
          <g class="fp-lean" style="transform-origin:50px 104px">
            ${arm(-1, "var(--ring-squats)")}${arm(1, "var(--ring-pushups)")}
            <g transform="rotate(-73 50 60)">${ringArc("var(--ring-pushups)", 0)}${ringArc("var(--ring-planks)", -75.4)}${ringArc("var(--ring-squats)", -150.8)}</g>
            <circle cx="50" cy="60" r="26.5" fill="${FACE}"/>
            <g class="fp-eyes">
              ${openEye(41, "fp-eye-l")}${openEye(59, "fp-eye-r")}
              ${happyEye(59, "fp-happy-r")}
              ${angryEyes}
            </g>
            <g class="fp-brows" stroke="${INK}" stroke-width="3.4" stroke-linecap="round">
              <line x1="34" y1="45" x2="45" y2="49"/><line x1="66" y1="45" x2="55" y2="49"/>
            </g>
            <g class="fp-brows-angry" stroke="${INK}" stroke-width="4.4" stroke-linecap="round">
              <line x1="32" y1="45" x2="47" y2="51.5"/><line x1="68" y1="45" x2="53" y2="51.5"/>
            </g>
            <g class="fp-mouth-o"><ellipse cx="50" cy="68" rx="4.6" ry="5.6" fill="${INK}"/><ellipse cx="50" cy="71" rx="2.8" ry="1.9" fill="${TONGUE}"/></g>
            <g class="fp-mouth-grit"><rect x="41" y="64.5" width="18" height="7" rx="3.5" fill="#fff" stroke="${INK}" stroke-width="2.4"/><line x1="42.5" y1="68" x2="57.5" y2="68" stroke="${INK}" stroke-width="1.4"/></g>
            <g class="fp-mouth-angry" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">
              <path d="M38.5 65 C44 63 56 63 61.5 65 L59.5 72.5 C54 74.5 46 74.5 40.5 72.5 Z" fill="#fff" stroke-width="2.4"/>
              <path d="M40 68.8 L60 68.8 M45 64.2 L45 73.6 M50 63.8 L50 74 M55 64.2 L55 73.6" fill="none" stroke-width="1.3"/>
            </g>
            <g class="fp-mouth-smile"><path d="M39.5 64.5 Q50 80 60.5 64.5 Z" fill="${INK}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><ellipse cx="50" cy="72.2" rx="4.4" ry="2.4" fill="${TONGUE}"/></g>
            ${vein}
          </g>
        </g>
        ${star(135, 18, 8, "fp-ting fp-ting-r")}${star(-35, 18, 8, "fp-ting fp-ting-l")}
      </g>
    </svg>`;
  }

  // ---------- the motion ----------
  const T = 3.3; // seconds the intro takes
  const LOOP = 4.2; // seconds per idle loop after it

  // frames: [[seconds, {css}, easing?], ...] from 0 to the total.
  function animate(el, frames, total, delay, iterations) {
    return el.animate(
      frames.map(([t, props, easing]) => ({ offset: t / total, easing: easing || "ease-in-out", ...props })),
      { duration: total * 1000, delay: (delay || 0) * 1000, iterations: iterations || 1, fill: iterations ? "none" : "both" }
    );
  }
  // Visible only during the given [from, to] spans (snaps, no fade).
  function show(el, spans) {
    const frames = [[0, { opacity: spans.some(([a]) => a === 0) ? 1 : 0 }, "steps(1, end)"]];
    for (const [a, b] of spans) {
      if (a > 0) frames.push([a, { opacity: 1 }, "steps(1, end)"]);
      if (b < T) frames.push([b, { opacity: 0 }, "steps(1, end)"]);
    }
    frames.push([T, { opacity: spans.some(([, b]) => b >= T) ? 1 : 0 }]);
    frames.sort((p, q) => p[0] - q[0]);
    animate(el, frames, T);
  }
  const tf = (s) => ({ transform: s });

  function play(root) {
    const q = (sel) => root.querySelector(sel);
    const all = (sel) => root.querySelectorAll(sel);
    const UP = "cubic-bezier(0.2, 0.7, 0.4, 1)"; // fast off the ground, slowing at the top
    const DOWN = "cubic-bezier(0.6, 0, 0.8, 0.4)"; // speeding up as it falls

    // Up and down. Pops up, lands, crouches, jumps into the flex, lands, then
    // bobs with each pump.
    animate(q(".fp-jump"), [
      [0, tf("translateY(26px)"), UP],
      [0.26, tf("translateY(-16px)"), DOWN],
      [0.42, tf("translateY(0)")],
      [0.8, tf("translateY(0)")],
      [0.95, tf("translateY(3px)"), UP],
      [1.2, tf("translateY(-30px)"), DOWN],
      [1.42, tf("translateY(0)")],
      [1.9, tf("translateY(0)")],
      [2.0, tf("translateY(-6px)")],
      [2.15, tf("translateY(0)")],
      [2.4, tf("translateY(0)")],
      [2.5, tf("translateY(-6px)")],
      [2.65, tf("translateY(0)")],
      [T, tf("translateY(0)")],
    ], T);

    // Squash and stretch: tall while flying, flat when it lands or crouches.
    animate(q(".fp-squash"), [
      [0, tf("scale(0.2, 0.3)")],
      [0.2, tf("scale(0.9, 1.14)")],
      [0.42, tf("scale(1.18, 0.82)")],
      [0.56, tf("scale(0.95, 1.05)")],
      [0.68, tf("scale(1)")],
      [0.8, tf("scale(1)")],
      [0.95, tf("scale(1.14, 0.84)")],
      [1.1, tf("scale(0.9, 1.12)")],
      [1.25, tf("scale(1)")],
      [1.42, tf("scale(1.16, 0.84)")],
      [1.56, tf("scale(0.96, 1.04)")],
      [1.7, tf("scale(1)")],
      [1.9, tf("scale(1.05, 0.95)")],
      [2.02, tf("scale(0.98, 1.03)")],
      [2.15, tf("scale(1)")],
      [2.4, tf("scale(1.05, 0.95)")],
      [2.52, tf("scale(0.98, 1.03)")],
      [2.65, tf("scale(1)")],
      [T, tf("scale(1)")],
    ], T);
    animate(q(".fp-squash"), [
      [0, tf("scale(1)")],
      [LOOP * 0.25, tf("scale(1.025, 0.975)")],
      [LOOP * 0.5, tf("scale(1)")],
      [LOOP * 0.68, tf("scale(1.05, 0.95)")],
      [LOOP * 0.76, tf("scale(0.98, 1.03)")],
      [LOOP * 0.85, tf("scale(1)")],
      [LOOP, tf("scale(1)")],
    ], LOOP, T, Infinity);

    // A little sway: first pump leans one way, the second the other.
    animate(q(".fp-lean"), [
      [0, tf("rotate(0)")],
      [1.8, tf("rotate(0)")],
      [2.0, tf("rotate(-7deg)")],
      [2.3, tf("rotate(0)")],
      [2.5, tf("rotate(7deg)")],
      [2.8, tf("rotate(0)")],
      [T, tf("rotate(0)")],
    ], T);

    // The shadow shrinks while it's in the air.
    animate(q(".fp-shadow"), [
      [0, { transform: "scale(0.2)", opacity: 0 }],
      [0.26, { transform: "scale(0.6)", opacity: 0.5 }],
      [0.42, { transform: "scale(1.15)", opacity: 1 }],
      [0.68, { transform: "scale(1)", opacity: 1 }],
      [0.95, { transform: "scale(1.1)", opacity: 1 }],
      [1.2, { transform: "scale(0.55)", opacity: 0.45 }],
      [1.42, { transform: "scale(1.15)", opacity: 1 }],
      [1.7, { transform: "scale(1)", opacity: 1 }],
      [T, { transform: "scale(1)", opacity: 1 }],
    ], T);

    // Arms: hidden until the jump, then burst out (overshooting upward),
    // drag a little on the landing, and lift with each pump.
    for (const el of all(".fp-arm")) {
      const s = Number(el.dataset.side);
      const r = (deg) => `rotate(${deg * s}deg)`;
      animate(el, [
        [0, tf(`${r(50)} scale(0)`)],
        [1.0, tf(`${r(50)} scale(0)`), "cubic-bezier(0.2, 0.9, 0.3, 1.2)"],
        [1.2, tf(`${r(-28)} scale(1.1)`)],
        [1.36, tf(`${r(-6)} scale(1)`)],
        [1.5, tf(`${r(12)} scale(1)`)],
        [1.68, tf(`${r(0)} scale(1)`)],
        [1.88, tf(`${r(0)} scale(1)`)],
        [2.0, tf(`${r(-9)} scale(1.04)`)],
        [2.18, tf(`${r(0)} scale(1)`)],
        [2.38, tf(`${r(0)} scale(1)`)],
        [2.5, tf(`${r(-9)} scale(1.04)`)],
        [2.68, tf(`${r(0)} scale(1)`)],
        [T, tf(`${r(0)} scale(1)`)],
      ], T);
      animate(el, [
        [0, tf(`${r(0)}`)],
        [LOOP * 0.66, tf(`${r(0)}`)],
        [LOOP * 0.72, tf(`${r(-8)}`)],
        [LOOP * 0.84, tf(`${r(0)}`)],
        [LOOP, tf(`${r(0)}`)],
      ], LOOP, T, Infinity);
    }

    // Forearms: straight out as the arms appear, then curl up past the
    // flex and settle; each pump curls them in a bit tighter.
    for (const el of all(".fp-forearm")) {
      const s = Number(el.closest(".fp-arm").dataset.side);
      const r = (deg) => tf(`rotate(${deg * s}deg)`);
      animate(el, [
        [0, r(90)],
        [1.12, r(80), "cubic-bezier(0.3, 0, 0.3, 1.3)"],
        [1.36, r(-22)],
        [1.52, r(6)],
        [1.68, r(0)],
        [1.88, r(0)],
        [2.0, r(-20)],
        [2.18, r(0)],
        [2.38, r(0)],
        [2.5, r(-20)],
        [2.68, r(0)],
        [T, r(0)],
      ], T);
      animate(el, [
        [0, r(0)],
        [LOOP * 0.66, r(0)],
        [LOOP * 0.72, r(-18)],
        [LOOP * 0.84, r(0)],
        [LOOP, r(0)],
      ], LOOP, T, Infinity);
    }

    // The bicep swells with every curl.
    for (const el of all(".fp-bicep")) {
      animate(el, [
        [0, tf("scale(0.4)")],
        [1.2, tf("scale(0.4)")],
        [1.36, tf("scale(1.25)")],
        [1.52, tf("scale(0.95)")],
        [1.68, tf("scale(1)")],
        [1.88, tf("scale(1)")],
        [2.0, tf("scale(1.32)")],
        [2.18, tf("scale(1)")],
        [2.38, tf("scale(1)")],
        [2.5, tf("scale(1.32)")],
        [2.68, tf("scale(1)")],
        [T, tf("scale(1)")],
      ], T);
      animate(el, [
        [0, tf("scale(1)")],
        [LOOP * 0.66, tf("scale(1)")],
        [LOOP * 0.72, tf("scale(1.3)")],
        [LOOP * 0.84, tf("scale(1)")],
        [LOOP, tf("scale(1)")],
      ], LOOP, T, Infinity);
    }

    // "Ting!" next to each fist at the top of each pump.
    for (const el of all(".fp-ting")) {
      const pop = (t) => [
        [t - 0.04, { transform: "scale(0) rotate(0)", opacity: 1 }],
        [t + 0.08, { transform: "scale(1.2) rotate(45deg)", opacity: 1 }],
        [t + 0.3, { transform: "scale(0) rotate(90deg)", opacity: 0 }],
      ];
      animate(el, [[0, { transform: "scale(0)", opacity: 0 }], ...pop(1.38), ...pop(2.02), ...pop(2.52), [T, { transform: "scale(0)", opacity: 0 }]], T);
      animate(el, [[0, { transform: "scale(0)", opacity: 0 }], ...pop(LOOP * 0.73), [LOOP, { transform: "scale(0)", opacity: 0 }]], LOOP, T, Infinity);
    }

    // Faces: surprised -> gritting its teeth (crouch and jump) -> angry
    // (the flex and its pumps) -> a wink -> proud smile.
    const WOW = [0, 0.86];
    const GRIT = [0.86, 1.4];
    const ANGRY = [1.4, 2.78];
    const WINK = [2.78, 3.15];
    const SMILE = [3.15, T];
    show(q(".fp-eye-l"), [WOW, GRIT, WINK, SMILE]);
    show(q(".fp-eye-r"), [WOW, GRIT, SMILE]);
    show(q(".fp-happy-r"), [WINK]);
    show(q(".fp-brows"), [GRIT]);
    show(q(".fp-mouth-o"), [WOW]);
    show(q(".fp-mouth-grit"), [GRIT]);
    show(q(".fp-mouth-smile"), [WINK, SMILE]);
    const angry = [".fp-angry-eyes", ".fp-brows-angry", ".fp-mouth-angry", ".fp-vein"];
    for (const sel of angry) show(q(sel), [ANGRY]);
    // In the idle loop it gets angry again for each flex.
    const FLEX = [LOOP * 0.62, LOOP * 0.9];
    for (const sel of [".fp-eye-l", ".fp-eye-r", ".fp-mouth-smile", ...angry]) {
      const during = angry.includes(sel) ? 1 : 0;
      animate(q(sel), [
        [0, { opacity: 1 - during }, "steps(1, end)"],
        [FLEX[0], { opacity: during }, "steps(1, end)"],
        [FLEX[1], { opacity: 1 - during }],
        [LOOP, { opacity: 1 - during }],
      ], LOOP, T, Infinity);
    }
    // The anger mark pops in with the flex and throbs with every pump.
    const throb = (t) => [[t - 0.1, tf("scale(1)")], [t, tf("scale(1.35)")], [t + 0.16, tf("scale(1)")]];
    animate(q(".fp-vein"), [
      [0, tf("scale(0)")],
      [1.4, tf("scale(0)")],
      [1.52, tf("scale(1.3)")],
      [1.64, tf("scale(1)")],
      ...throb(2.0),
      ...throb(2.5),
      [T, tf("scale(1)")],
    ], T);
    animate(q(".fp-vein"), [
      [0, tf("scale(0)")],
      [FLEX[0], tf("scale(0)")],
      [LOOP * 0.66, tf("scale(1.3)")],
      ...throb(LOOP * 0.74),
      [LOOP, tf("scale(1)")],
    ], LOOP, T, Infinity);
    // Squinting while it strains; blinking now and then afterwards.
    for (const eye of all(".fp-eye-l, .fp-eye-r")) {
      animate(eye, [
        [0, tf("scaleY(1)")],
        [0.38, tf("scaleY(1)")],
        [0.44, tf("scaleY(0.75)")],
        [0.56, tf("scaleY(1)")],
        [0.86, tf("scaleY(1)"), "steps(1, end)"],
        [0.9, tf("scaleY(0.5)")],
        [1.4, tf("scaleY(0.5)"), "steps(1, end)"],
        [1.42, tf("scaleY(1)")],
        [T, tf("scaleY(1)")],
      ], T);
      animate(eye, [
        [0, tf("scaleY(1)")],
        [LOOP * 0.3, tf("scaleY(1)")],
        [LOOP * 0.33, tf("scaleY(0.1)")],
        [LOOP * 0.36, tf("scaleY(1)")],
        [LOOP, tf("scaleY(1)")],
      ], LOOP, T, Infinity);
    }
  }

  return { svg, play, duration: T };
})();

// Loaded after script.js and onboarding.js, and uses their helpers (data,
// todayString, serverPlan, formatDuration, streakCountEl, statusMessageEl,
// ForjaRules, Onboarding.mascot).
const Celebrations = (function () {
  const $ = (id) => document.getElementById(id);
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reduced() ? 0 : ms));
  const KEY_OF = { pushup: "pushups", plank: "planks", squat: "squats" };
  const COLOR = { pushups: "var(--ring-pushups)", planks: "var(--ring-planks)", squats: "var(--ring-squats)", walkRun: "var(--ring-walkrun)" };
  const TAGS = { pushups: "pushups-min-tag", planks: "planks-min-tag", squats: "squats-min-tag" };
  const LEVEL_UP_KEY = "forja-level-up-day";
  const MILESTONE_KEY = "forja-milestone-day";

  const queue = [];
  let playing = false;
  // While the day-complete moment is waiting to play, the ring stays open.
  let dayPending = false;
  // Which targets were met the last time Today was drawn (null = not yet drawn).
  let metBefore = null;

  const todayVisible = () => !$("app-screen").classList.contains("hidden") && !$("tab-today").classList.contains("hidden");
  const inSignUp = () => typeof Onboarding !== "undefined" && Onboarding.isActive();
  const remember = (key) => {
    try {
      localStorage.setItem(key, todayString());
    } catch (e) {
      // storage blocked - it just might show again
    }
  };
  const isToday = (key) => {
    try {
      return localStorage.getItem(key) === todayString();
    } catch (e) {
      return false;
    }
  };

  // Moments play one after another, each once Today is on screen.
  function enqueue(step) {
    queue.push(step);
    if (!playing) run();
  }
  async function run() {
    playing = true;
    while (queue.length) {
      while (!todayVisible()) await new Promise((resolve) => setTimeout(resolve, 200));
      const step = queue.shift();
      try {
        await step();
      } catch (e) {
        console.error("celebration failed", e);
      }
    }
    playing = false;
  }

  function countUp(input, from, to, ms) {
    const start = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - start) / ms);
      input.value = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ---------- a saved set ----------
  function setSaved(exercise, before, after) {
    const key = KEY_OF[exercise];
    if (!key || !(after > before) || inSignUp()) return;
    enqueue(async () => {
      await wait(250); // let Today settle after the camera closes
      const input = $(key);
      const tile = input.closest(".exercise-tile");
      if (!reduced()) countUp(input, before, after, 600);
      const plus = document.createElement("span");
      plus.className = "celebrate-plus";
      plus.style.color = COLOR[key];
      plus.textContent = key === "planks" ? `+${after - before}s` : `+${after - before}`;
      tile.appendChild(plus);
      setTimeout(() => plus.remove(), 1300);
      await wait(650);
    });
  }

  // ---------- the ring, closed ----------
  // A gapless copy of the ring (one arc per exercise, same order and colors)
  // drawn over the segments, plus the pet's face in the middle. Only
  // opacity and scale animate, which iPhones draw reliably.
  function closedRing() {
    let layer = $("ring-complete");
    if (!layer) {
      layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
      layer.id = "ring-complete";
      document.querySelector(".rings-svg").appendChild(layer);
      const face = document.createElement("div");
      face.id = "ring-face";
      face.className = "ring-face";
      document.querySelector(".rings-container").appendChild(face);
    }
    const keys = data.minimums.walkRun !== null ? ["pushups", "planks", "squats", "walkRun"] : ["pushups", "planks", "squats"];
    const circumference = 2 * Math.PI * 50;
    const span = circumference / keys.length;
    const shape = keys.join(",");
    if (layer.dataset.shape !== shape) {
      layer.dataset.shape = shape;
      layer.innerHTML = keys
        .map((key, i) => `<circle class="ring-complete-arc" cx="60" cy="60" r="50" stroke="${COLOR[key]}" stroke-dasharray="${span + 0.5} ${circumference}" stroke-dashoffset="${-i * span}"/>`)
        .join("");
    }
    return { layer, face: $("ring-face") };
  }

  function showClosed(closed, animate) {
    const { layer, face } = closedRing();
    const container = document.querySelector(".rings-container");
    container.classList.toggle("is-complete", closed);
    if (closed && !face.hasChildNodes()) face.innerHTML = Onboarding.mascot("wow", true);
    if (!closed) face.innerHTML = "";
    layer.classList.remove("snap");
    face.classList.remove("snap");
    if (closed && animate) {
      void layer.getBoundingClientRect();
      layer.classList.add("snap");
      face.classList.add("snap");
    }
  }

  // ---------- the day ----------
  function dayComplete({ streak, levelUp }) {
    if (levelUp) remember(LEVEL_UP_KEY);
    // Sign-up has its own Day 1 screens; Today just shows the finished state.
    if (inSignUp()) return;
    dayPending = true;
    enqueue(async () => {
      await wait(300);
      dayPending = false;
      showClosed(true, true);
      streakCountEl.classList.add("pulse");
      setTimeout(() => streakCountEl.classList.remove("pulse"), 250);
      drawStatus();
      if (streak > 0 && streak % 7 === 0 && !isToday(MILESTONE_KEY)) {
        await wait(1300);
        await milestone(streak);
      }
    });
  }

  // "Day complete!" - plus, on a level-up day, the tag and tomorrow's targets.
  function drawStatus() {
    if (!data || data.lastLoggedDate !== todayString() || !isToday(LEVEL_UP_KEY) || typeof serverPlan === "undefined" || !serverPlan) return;
    const tomorrow = ForjaRules.planOn(serverPlan, ForjaRules.addDays(todayString(), 1)).plan.targets;
    const tag = document.createElement("span");
    tag.className = "level-up-tag";
    tag.textContent = "Level up ▲";
    const line = document.createElement("span");
    line.className = "level-up-line";
    line.textContent = `Tomorrow: ${tomorrow.pushups} push-ups · ${formatDuration(tomorrow.planks * 1000)} plank · ${tomorrow.squats} squats`;
    statusMessageEl.textContent = "Day complete! ";
    statusMessageEl.append(tag, line);
  }

  // ---------- every 7th day ----------
  function confetti(host) {
    const colors = [COLOR.pushups, COLOR.planks, COLOR.squats, "var(--accent)"];
    for (let i = 0; i < 48; i++) {
      const piece = document.createElement("i");
      piece.className = "celebrate-confetti";
      const angle = Math.random() * Math.PI * 2;
      const distance = 110 + Math.random() * 170;
      piece.style.cssText = `--c:${colors[i % 4]};--x:${Math.round(Math.cos(angle) * distance)}px;--y:${Math.round(Math.sin(angle) * distance * 0.8 + 90)}px;--r:${Math.round(Math.random() * 720 - 360)}deg;--d:${(1.35 + Math.random() * 0.25).toFixed(2)}s`;
      host.appendChild(piece);
    }
  }

  function milestone(streak) {
    remember(MILESTONE_KEY);
    const weeks = streak / 7;
    // The last seven days, ending today.
    const letters = ["S", "M", "T", "W", "T", "F", "S"];
    const days = Array.from({ length: 7 }, (_, i) => letters[new Date(Date.now() - (6 - i) * 86400000).getDay()]);
    return new Promise((resolve) => {
      const screen = document.createElement("div");
      screen.className = "celebrate-screen";
      screen.setAttribute("role", "dialog");
      screen.setAttribute("aria-modal", "true");
      screen.setAttribute("aria-labelledby", "celebrate-title");
      screen.innerHTML = `
        ${FlexPet.svg()}
        <span class="celebrate-number">${streak - 1}</span>
        <h2 id="celebrate-title">${streak}-day streak!</h2>
        <p>${weeks === 1 ? "A full week in a row." : `${weeks} weeks in a row.`}</p>
        <div class="celebrate-week">${days.map((d, i) => `<span class="${i === 6 ? "is-today" : ""}">${d}</span>`).join("")}</div>
        <button class="auth-submit-button celebrate-close">Continue</button>`;
      document.body.appendChild(screen);
      // The number and confetti go off as the pet lands in its flex.
      const pet = screen.querySelector(".flex-pet");
      if (reduced()) pet.classList.add("still");
      else {
        FlexPet.play(pet);
        confetti(screen);
      }
      const number = screen.querySelector(".celebrate-number");
      const bump = setTimeout(() => {
        number.textContent = streak;
        number.classList.add("bump");
      }, reduced() ? 0 : 1420);
      const button = screen.querySelector(".celebrate-close");
      const close = () => {
        document.removeEventListener("keydown", onKey);
        clearTimeout(bump);
        // The pet's idle loop runs forever; stop it with the screen.
        if (pet.getAnimations) pet.getAnimations({ subtree: true }).forEach((a) => a.cancel());
        screen.remove();
        resolve();
      };
      const onKey = (event) => {
        if (event.key === "Escape") close();
      };
      button.addEventListener("click", close);
      document.addEventListener("keydown", onKey);
      button.focus();
    });
  }

  // ---------- called by render() every time Today is drawn ----------
  function renderToday(loggedToday, progress) {
    // Targets met: a green check on the tag, popping in when it's new.
    const met = {};
    for (const key of Object.keys(TAGS)) {
      met[key] = loggedToday || progress[key] >= data.minimums[key];
      $(TAGS[key]).classList.toggle("is-met", met[key]);
      if (metBefore && met[key] && !metBefore[key] && !inSignUp()) {
        enqueue(async () => {
          const tag = $(TAGS[key]);
          tag.classList.remove("pop");
          void tag.offsetWidth;
          tag.classList.add("pop");
          await wait(350);
        });
      }
    }
    metBefore = met;

    if (!dayPending) showClosed(loggedToday, false);
    if (loggedToday && !dayPending) drawStatus();
  }

  return { setSaved, dayComplete, renderToday };
})();

// script.js may already have drawn Today before this file loaded (the app
// starts as soon as the log-in check answers); draw it again so a finished
// day shows its closed ring.
if (typeof data !== "undefined" && data) render();
