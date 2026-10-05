// Turns a stream of body measurements into verified rep counts and plank
// holds. Deliberately has no camera or DOM code in it: the camera page
// feeds it one measurement per video frame, and it can be tested with fake
// sequences in Node.
//
// Works in the browser (as the global `ForjaCounter`) and in Node
// (module.exports).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ForjaCounter = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Angle (in degrees) at point b, formed by the lines b->a and b->c.
  // Points are {x, y}. For a knee: a = hip, b = knee, c = ankle -
  // straight leg is ~180, a deep squat is well under 90.
  function jointAngle(a, b, c) {
    const abx = a.x - b.x;
    const aby = a.y - b.y;
    const cbx = c.x - b.x;
    const cby = c.y - b.y;
    const magnitude = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
    if (magnitude === 0) return null;
    const cosine = (abx * cbx + aby * cby) / magnitude;
    return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
  }

  // How far a line from a to b leans away from horizontal, in degrees
  // (0 = flat on the floor, 90 = standing upright).
  function tiltFromHorizontal(a, b) {
    return (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
  }

  // The shared engine behind squats and push-ups: a two-phase rep (joint
  // angle goes below `downBelow`, then back above `upAbove`) that only
  // counts when the surrounding evidence also looks like the real exercise.
  //
  // update(angle, timeMs, extra) - `extra` is what makes it verification
  // rather than just angle counting:
  //   dropY    vertical position (any unit) of the body part that must
  //            lower during a rep - hips for squats, shoulders for push-ups
  //   anchorX/Y where the part that must stay planted is - ankle for
  //            squats, wrist for push-ups
  //   scale    a body length in the same unit, so every check is relative
  //            (works at any camera distance)
  //   posture  optional boolean: is the body in the right overall position
  //            this frame (e.g. horizontal and straight for push-ups)
  // Without `extra`, only the angle and timing checks apply.
  //
  // A rep counts only if: the angle crosses both thresholds (the gap
  // between them stops jitter counting as extra reps), the body part
  // really dropped, the anchor stayed planted, posture held, and it wasn't
  // impossibly fast.
  function createRepCounter(options) {
    const cfg = Object.assign(
      {
        downBelow: 100,
        upAbove: 160,
        smoothing: 0.4, // 0-1, higher reacts faster but jitters more
        minRepMs: 500, // a real rep can't be faster than this
        readyHoldMs: 500, // must hold the start position this long before counting
        minDrop: 0.2, // dropY must lower by >= this fraction of scale
        maxAnchorMove: 0.25, // anchor may wander <= this fraction of scale
        maxBadPostureMs: 400, // bad posture longer than this during a rep voids it
        maxDegPerSec: 900, // faster angle change than this is a tracking glitch
        maxLostMs: 700, // lose tracking this long mid-rep and the rep is dropped
        attemptBelow: null, // see below
      },
      options
    );
    // A dip only counts as an ATTEMPT at a rep - worth a 'not deep enough'
    // message or a buzz - if the joint bent at least this far. Shifting your
    // weight or a slight knee bend shouldn't set anything off.
    if (cfg.attemptBelow === null) cfg.attemptBelow = cfg.downBelow + 30;

    let state = "waiting"; // waiting -> up <-> down
    let smoothed = null;
    let readySince = null;
    let descentStart = null;
    let deepest = 180;
    let shallowDeepest = 180;
    let count = 0;
    let prevRaw = null;
    let prevTime = null;
    let lostSince = null;
    let lastFrameTime = null;
    const reps = [];

    // Where the body is while in the start position, so a rep can be judged
    // against it.
    const base = { dropY: null, anchorX: null, anchorY: null, scale: null };
    let maxDropY = 0;
    let maxAnchorMove = 0;
    let badPostureMs = 0;

    const postureOk = (extra) => !extra || extra.posture !== false;
    const blend = (current, value) => (current === null ? value : 0.9 * current + 0.1 * value);

    function learnStart(extra) {
      if (!extra || !postureOk(extra)) return;
      base.dropY = blend(base.dropY, extra.dropY);
      base.anchorX = blend(base.anchorX, extra.anchorX);
      base.anchorY = blend(base.anchorY, extra.anchorY);
      base.scale = blend(base.scale, extra.scale);
    }

    function startDescent(timeMs, extra) {
      descentStart = timeMs;
      maxDropY = extra ? extra.dropY : 0;
      maxAnchorMove = 0;
      badPostureMs = 0;
    }

    function trackDescent(extra, dtMs) {
      if (!extra || base.scale === null) return;
      maxDropY = Math.max(maxDropY, extra.dropY);
      maxAnchorMove = Math.max(maxAnchorMove, Math.hypot(extra.anchorX - base.anchorX, extra.anchorY - base.anchorY));
      if (!postureOk(extra)) badPostureMs += dtMs;
    }

    function liveMeasures() {
      if (base.scale === null || descentStart === null) return { drop: null, anchorMove: null };
      return { drop: (maxDropY - base.dropY) / base.scale, anchorMove: maxAnchorMove / base.scale };
    }

    function result(event, lost) {
      return Object.assign(
        { state, angle: smoothed, count, event, lost: !!lost, lastRep: reps[reps.length - 1] || null },
        liveMeasures()
      );
    }

    function endDescent() {
      descentStart = null;
      deepest = 180;
    }

    return {
      reps,

      // angle: joint angle in degrees, or null if it isn't visible enough
      // this frame. timeMs: any steadily increasing clock (ms).
      update(angle, timeMs, extra) {
        const dtMs = lastFrameTime === null ? 0 : timeMs - lastFrameTime;
        lastFrameTime = timeMs;

        if (angle === null || angle === undefined) {
          if (lostSince === null) lostSince = timeMs;
          if (state === "down" && timeMs - lostSince > cfg.maxLostMs) {
            // Can't vouch for a rep we couldn't see. Back to "get in
            // position" rather than "up", otherwise someone still at the
            // bottom when tracking returns would get their return stroke
            // counted as a brand new rep.
            state = "waiting";
            readySince = null;
            endDescent();
            return result("abandoned", true);
          }
          return result(null, true);
        }
        lostSince = null;

        // One-frame landmark glitches (the model briefly snapping a joint
        // somewhere absurd) move the angle far faster than a body can.
        if (prevRaw !== null) {
          const seconds = Math.max(timeMs - prevTime, 1) / 1000;
          const glitch = Math.abs(angle - prevRaw) / seconds > cfg.maxDegPerSec;
          prevRaw = angle;
          prevTime = timeMs;
          if (glitch) return result(null);
        } else {
          prevRaw = angle;
          prevTime = timeMs;
        }

        smoothed = smoothed === null ? angle : cfg.smoothing * angle + (1 - cfg.smoothing) * smoothed;

        if (state === "waiting") {
          if (smoothed > cfg.upAbove && postureOk(extra)) {
            learnStart(extra);
            if (readySince === null) readySince = timeMs;
            if (timeMs - readySince >= cfg.readyHoldMs) state = "up";
          } else {
            readySince = null;
          }
          return result(null);
        }

        if (state === "up") {
          if (smoothed >= cfg.upAbove && descentStart === null) learnStart(extra);

          if (smoothed < cfg.upAbove) {
            if (descentStart === null) {
              startDescent(timeMs, extra);
              shallowDeepest = smoothed;
            }
            shallowDeepest = Math.min(shallowDeepest, smoothed);
            trackDescent(extra, dtMs);
          }
          if (smoothed < cfg.downBelow) {
            state = "down";
            deepest = smoothed;
            return result(null);
          }
          if (smoothed >= cfg.upAbove && descentStart !== null) {
            // Went down some, came back up without reaching depth.
            const depth = shallowDeepest;
            endDescent();
            if (depth >= cfg.attemptBelow) return result(null); // too small a movement to call an attempt
            return Object.assign(result("shallow"), { depth });
          }
          return result(null);
        }

        // state === "down"
        deepest = Math.min(deepest, smoothed);
        trackDescent(extra, dtMs);
        if (smoothed > cfg.upAbove) {
          const durationMs = timeMs - descentStart;
          const depth = deepest;
          const measures = liveMeasures();
          const postureMs = badPostureMs;
          state = "up";
          endDescent();

          if (durationMs < cfg.minRepMs) return Object.assign(result("too_fast"), { depth });
          if (extra && measures.drop !== null) {
            if (postureMs > cfg.maxBadPostureMs) return Object.assign(result("bad_posture"), { depth, ...measures, badPostureMs: postureMs });
            if (measures.drop < cfg.minDrop) return Object.assign(result("no_drop"), { depth, ...measures });
            if (measures.anchorMove > cfg.maxAnchorMove) return Object.assign(result("anchor_moved"), { depth, ...measures });
          }
          count += 1;
          reps.push({ depth, durationMs, at: timeMs, drop: measures.drop, anchorMove: measures.anchorMove });
          return result("rep");
        }
        return result(null);
      },

      reset() {
        state = "waiting";
        smoothed = null;
        readySince = null;
        descentStart = null;
        deepest = 180;
        count = 0;
        prevRaw = null;
        prevTime = null;
        lostSince = null;
        lastFrameTime = null;
        base.dropY = base.anchorX = base.anchorY = base.scale = null;
        reps.length = 0;
      },
    };
  }

  // Squat: the knee angle is the rep; hips must drop and ankles stay put.
  function createSquatCounter(options) {
    return createRepCounter(Object.assign({ downBelow: 100, upAbove: 155, minRepMs: 500, minDrop: 0.2, maxAnchorMove: 0.25, maxBadPostureMs: 800 }, options));
  }

  // Push-up: the elbow angle is the rep; shoulders must lower, hands stay
  // put, and the body must be horizontal and straight (the `posture` flag)
  // - which is what stops standing arm curls or kneeling "worm" reps.
  // Push-ups are faster than squats, so the minimum rep time is lower.
  function createPushupCounter(options) {
    return createRepCounter(
      Object.assign({ downBelow: 95, upAbove: 155, minRepMs: 400, minDrop: 0.06, maxAnchorMove: 0.15 }, options)
    );
  }

  // Plank: a timer that only runs while the body is flat and straight.
  // update(sample, timeMs), where sample is {bodyAngle, tilt} - the
  // shoulder-hip-ankle angle (180 = perfectly straight) and how far the
  // shoulder-to-ankle line leans from horizontal - or null if not visible.
  // A hold only ends after the form has been broken for `graceMs`, so a
  // flicker of bad tracking doesn't reset someone's time; `bestMs` is the
  // longest unbroken hold, which is what counts for competition.
  function createPlankTimer(options) {
    const cfg = Object.assign(
      {
        minBodyAngle: 160, // straighter than this counts as a plank
        maxTilt: 30, // must be roughly horizontal
        startHoldMs: 1000, // form must be good this long before the clock starts
        graceMs: 1000, // form can be broken this long before the hold ends
        minRecordedMs: 3000, // holds shorter than this aren't recorded
        smoothing: 0.3,
      },
      options
    );

    let state = "waiting"; // waiting -> holding -> waiting
    let smoothedAngle = null;
    let goodSince = null;
    let holdStart = null;
    let lastGoodAt = null;
    let bestMs = 0;
    const holds = [];

    function snapshot(now, reason) {
      const current = state === "holding" ? lastGoodAt - holdStart : 0;
      return { state, holdMs: current, bestMs: Math.max(bestMs, current >= cfg.minRecordedMs ? current : 0), reason: reason || null, bodyAngle: smoothedAngle, holds };
    }

    function endHold() {
      const length = lastGoodAt - holdStart;
      if (length >= cfg.minRecordedMs) {
        holds.push(length);
        bestMs = Math.max(bestMs, length);
      }
      state = "waiting";
      holdStart = null;
      goodSince = null;
    }

    return {
      holds,

      update(sample, timeMs) {
        if (sample === null || sample === undefined) {
          if (state === "holding" && timeMs - lastGoodAt > cfg.graceMs) {
            endHold();
            return snapshot(timeMs, "lost");
          }
          if (state === "waiting") goodSince = null;
          return snapshot(timeMs, "lost");
        }

        smoothedAngle = smoothedAngle === null ? sample.bodyAngle : cfg.smoothing * sample.bodyAngle + (1 - cfg.smoothing) * smoothedAngle;
        const flat = sample.tilt <= cfg.maxTilt;
        const straight = smoothedAngle >= cfg.minBodyAngle;
        const good = flat && straight;
        const reason = good ? null : !flat ? "not_horizontal" : "hips_sagging_or_piking";

        if (state === "waiting") {
          if (good) {
            if (goodSince === null) goodSince = timeMs;
            if (timeMs - goodSince >= cfg.startHoldMs) {
              state = "holding";
              holdStart = goodSince;
              lastGoodAt = timeMs;
            }
          } else {
            goodSince = null;
          }
          return snapshot(timeMs, reason);
        }

        // holding
        if (good) {
          lastGoodAt = timeMs;
        } else if (timeMs - lastGoodAt > cfg.graceMs) {
          endHold();
          return snapshot(timeMs, reason);
        }
        return snapshot(timeMs, reason);
      },

      // Call when the set is over so a hold still in progress gets recorded.
      finish(timeMs) {
        if (state === "holding") endHold();
        return snapshot(timeMs, null);
      },

      reset() {
        state = "waiting";
        smoothedAngle = null;
        goodSince = null;
        holdStart = null;
        lastGoodAt = null;
        bestMs = 0;
        holds.length = 0;
      },
    };
  }

  // ---- Per-exercise setup shared by the test page and the real app ----
  // What body joints each exercise needs, what to measure from them, and
  // how to word the feedback. Pure data and math - no DOM - so the camera
  // code in either page just reads it.
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const pct = (x) => Math.round((x ?? 0) * 100) + "%";

  const EXERCISES = {
    squat: {
      kind: "reps",
      title: "Squats",
      countLabel: "Verified squats",
      graphLabel: "Knee angle (last 8 seconds)",
      tip: "Prop the camera at about hip height, 6-8 feet away, and stand <b>side-on</b> so your whole leg (hip, knee, ankle) is in frame. Everything runs on this device - no video is sent anywhere.",
      needs: ["hip", "knee", "ankle", "shoulder"],
      minVisibility: 0.5,
      draw: ["shoulder", "hip", "knee", "ankle"],
      sliders: [
        { text: 'Counts as "down" below', min: 60, max: 130, value: 100 },
        { text: 'Counts as "standing" above', min: 140, max: 178, value: 155 },
      ],
      lost: "Can't see your leg - stand side-on and step back",
      states: { waiting: "Stand tall and hold still to start", up: "Ready - squat down", down: "Down - now stand all the way up" },
      events: {
        no_drop: (r) => "Ignored - hips didn't drop enough (" + pct(r.drop) + " of leg). Sit down and back.",
        anchor_moved: (r) => "Ignored - feet moved (" + pct(r.anchorMove) + " of leg). Keep them planted.",
        bad_posture: (r) => "Ignored - chest folded forward for " + ((r.badPostureMs ?? 0) / 1000).toFixed(1) + "s. Keep your chest up.",
      },
      jointName: "knee",
      dropName: "hips",
      anchorName: "feet",
      create: (v) => createSquatCounter({ downBelow: v[0], upAbove: v[1] }),
      measure(pt) {
        const hip = pt("hip"), knee = pt("knee"), ankle = pt("ankle"), shoulder = pt("shoulder");
        const torsoTilt = tiltFromHorizontal(hip, shoulder);
        return {
          angle: jointAngle(hip, knee, ankle),
          // A knee bend alone isn't a squat (walking and leg lifts bend it
          // too), so the hips must drop and the feet stay planted - and the
          // chest must stay up. Folding forward at the waist bends the
          // knees and drops the upper body, but the torso goes nearly
          // horizontal; a real squat keeps it well above 30 degrees.
          extra: { dropY: hip.y, anchorX: ankle.x, anchorY: ankle.y, scale: dist(hip, ankle), posture: torsoTilt >= 30 },
          torsoTilt,
        };
      },
      // What to tell someone who isn't being counted yet, so "it didn't
      // start" never looks like a bug.
      waitingHint: (m) => {
        if (m.extra.posture === false) return "Stand upright - chest up";
        if (m.angle !== null && m.angle < 160) return "Stand all the way up to start";
        return null;
      },
      graphLines: (v) => [v[0], v[1]],
    },

    pushup: {
      kind: "reps",
      title: "Push-ups",
      countLabel: "Verified push-ups",
      graphLabel: "Elbow angle (last 8 seconds)",
      tip: "Put the phone on the floor about 6 feet away and get into a plank <b>side-on</b>, with your whole body from head to feet in frame. Landscape works best. Arms straight to start, body flat and straight.",
      needs: ["shoulder", "elbow", "wrist", "hip", "ankle"],
      minVisibility: 0.4,
      draw: ["wrist", "elbow", "shoulder", "hip", "ankle"],
      sliders: [
        { text: 'Counts as "down" below', min: 60, max: 130, value: 95 },
        { text: 'Counts as "arms straight" above', min: 135, max: 178, value: 155 },
      ],
      lost: "Can't see your arm and body - turn side-on, full body in frame",
      states: { waiting: "Get into plank position - arms straight, body flat", up: "Ready - lower yourself", down: "Down - now push all the way up" },
      events: {
        no_drop: (r) => "Ignored - chest didn't lower (" + pct(r.drop) + " of body). Go lower.",
        anchor_moved: (r) => "Ignored - hands moved (" + pct(r.anchorMove) + " of body). Keep them planted.",
        bad_posture: (r) => "Ignored - body out of line for " + ((r.badPostureMs ?? 0) / 1000).toFixed(1) + "s. Keep it in one straight line.",
      },
      jointName: "elbow",
      dropName: "chest",
      anchorName: "hands",
      create: (v) => createPushupCounter({ downBelow: v[0], upAbove: v[1] }),
      measure(pt) {
        const shoulder = pt("shoulder"), elbow = pt("elbow"), wrist = pt("wrist"), hip = pt("hip"), ankle = pt("ankle");
        const bodyAngle = jointAngle(shoulder, hip, ankle);
        const tilt = tiltFromHorizontal(shoulder, ankle);
        return {
          angle: jointAngle(shoulder, elbow, wrist),
          // The body must be flat and straight the whole time - this is
          // what stops standing arm curls or sagging "worm" reps.
          extra: {
            dropY: shoulder.y,
            anchorX: wrist.x,
            anchorY: wrist.y,
            scale: dist(shoulder, ankle),
            posture: bodyAngle !== null && bodyAngle >= 150 && tilt <= 35,
          },
          tilt,
          live: "body line " + Math.round(bodyAngle ?? 0) + "°  ·  tilt " + Math.round(tilt) + "°",
        };
      },
      // Why counting hasn't started - the start position needs straight
      // arms AND a flat, straight body, and any one missing looks the same
      // from the outside.
      waitingHint: (m) => {
        if (m.extra.posture === false) {
          return m.tilt > 35 ? "Get down into a plank - your body should be roughly horizontal" : "Straighten your body - hips in line with shoulders and ankles";
        }
        if (m.angle !== null && m.angle < 155) return "Straighten your arms to start";
        return null;
      },
      graphLines: (v) => [v[0], v[1]],
    },

    plank: {
      kind: "plank",
      title: "Plank",
      countLabel: "Plank hold (seconds)",
      graphLabel: "Body line angle - 180 is perfectly straight (last 8 seconds)",
      tip: "Put the phone on the floor about 6 feet away and hold a plank <b>side-on</b>, with your whole body from head to feet in frame. The clock starts after one second of good form and keeps running while you stay flat and straight.",
      needs: ["shoulder", "hip", "ankle"],
      minVisibility: 0.4,
      draw: ["elbow", "shoulder", "hip", "ankle"],
      sliders: [
        { text: "Body must be straighter than", min: 140, max: 178, value: 160 },
        { text: "Must be flatter than (tilt)", min: 10, max: 45, value: 30 },
      ],
      lost: "Can't see your body - turn side-on, full body in frame",
      create: (v) => createPlankTimer({ minBodyAngle: v[0], maxTilt: v[1] }),
      measure(pt) {
        const shoulder = pt("shoulder"), hip = pt("hip"), ankle = pt("ankle");
        const bodyAngle = jointAngle(shoulder, hip, ankle);
        return { sample: bodyAngle === null ? null : { bodyAngle, tilt: tiltFromHorizontal(shoulder, ankle) } };
      },
      graphLines: (v) => [v[0]],
    },
  };

  // What the person should HEAR for a frame, given the state before it and
  // the counter's result - so they know from across the room, without
  // looking at the screen, whether a rep counted. Returns a cue name
  // ("rep", "reject", "ready", "end") or null for silence.
  const REJECTED_EVENTS = ["shallow", "too_fast", "no_drop", "anchor_moved", "bad_posture", "abandoned"];
  function soundCue(prevState, result, kind) {
    if (kind === "plank") {
      if (prevState === "waiting" && result.state === "holding") return "ready"; // the clock just started
      if (prevState === "holding" && result.state === "waiting") return "end"; // the hold just ended
      return null;
    }
    if (result.event === "rep") return "rep";
    if (REJECTED_EVENTS.includes(result.event)) return "reject";
    if (prevState === "waiting" && result.state === "up") return "ready"; // start position recognized
    return null;
  }

  // ---- Recording a set, and recounting it on the server ----
  // The phone records the movement as it counts; the server replays that
  // exact record through this exact code and trusts only its own count.
  // Because both sides run the same file, "recount" can't drift from
  // "count" - and a client that lies about its total has nothing to back
  // the lie up with.

  const COORD_SCALE = 10000; // positions are stored as whole numbers of 1/10000 of the frame
  const MAX_TRACE_FRAMES = 15000;
  const MAX_SET_MS = 8 * 60 * 1000;

  // The most reps per second a human can plausibly sustain. A made-up
  // record could otherwise "do" one rep every 0.4s for eight straight minutes.
  const MAX_REPS_PER_SECOND = { squat: 1.2, pushup: 1.5 };

  // One set in progress. push() takes the joints this exercise needs as
  // normalized [x, y] pairs (0-1 across the video), in EXERCISES[x].needs
  // order, or null when the body isn't visible. It quantizes them, records
  // the frame, and runs it through the counter - the same steps replay()
  // takes on the server.
  function createSetSession(exerciseKey, videoWidth, videoHeight) {
    const ex = EXERCISES[exerciseKey];
    if (!ex) throw new Error("unknown exercise");
    const engine = ex.create(ex.sliders.map((s) => s.value));
    const frames = [];
    let lastT = 0;

    function feed(t, ints) {
      lastT = t;
      if (!ints) return { r: engine.update(null, t), m: null };
      const pt = (joint) => {
        const i = ex.needs.indexOf(joint);
        return { x: (ints[2 * i] / COORD_SCALE) * videoWidth, y: (ints[2 * i + 1] / COORD_SCALE) * videoHeight };
      };
      const m = ex.measure(pt);
      return { r: ex.kind === "plank" ? engine.update(m.sample, t) : engine.update(m.angle, t, m.extra), m };
    }

    return {
      engine,
      frames,
      push(t, joints) {
        const ints = joints ? joints.flatMap(([x, y]) => [Math.round(x * COORD_SCALE), Math.round(y * COORD_SCALE)]) : null;
        frames.push(ints ? [t, 1, ...ints] : [t, 0]);
        return feed(t, ints);
      },
      replay(frame) {
        return feed(frame[0], frame[1] === 1 ? frame.slice(2) : null);
      },
      // Reps counted, or whole seconds for a plank (best unbroken hold,
      // rounded - a 29.97s hold shouldn't fail a 30s minimum over the
      // length of a single video frame).
      value() {
        return ex.kind === "plank" ? Math.round(engine.finish(lastT).bestMs / 1000) : engine.reps.length;
      },
      durationMs: () => lastT,
      trace: () => ({ v: 1, exercise: exerciseKey, w: videoWidth, h: videoHeight, frames }),
    };
  }

  // Server side: rebuild a set from its record. Throws on anything
  // malformed (the record comes from an untrusted client), otherwise
  // returns what this code - not the client - says was done.
  function recountTrace(trace) {
    const fail = (why) => {
      throw new Error("bad trace: " + why);
    };
    if (!trace || trace.v !== 1) fail("version");
    const ex = EXERCISES[trace.exercise];
    if (!ex) fail("exercise");
    if (!Number.isFinite(trace.w) || !Number.isFinite(trace.h) || trace.w < 100 || trace.h < 100 || trace.w > 4000 || trace.h > 4000) fail("size");
    if (!Array.isArray(trace.frames) || trace.frames.length === 0 || trace.frames.length > MAX_TRACE_FRAMES) fail("frame count");

    const width = 2 + 2 * ex.needs.length;
    const session = createSetSession(trace.exercise, trace.w, trace.h);
    let prevT = -1;
    for (const frame of trace.frames) {
      if (!Array.isArray(frame) || !Number.isInteger(frame[0]) || frame[0] <= prevT || frame[0] > MAX_SET_MS) fail("timestamps");
      prevT = frame[0];
      if (frame[1] === 0) {
        if (frame.length !== 2) fail("lost frame shape");
      } else if (frame[1] === 1) {
        if (frame.length !== width) fail("frame shape");
        for (let i = 2; i < width; i++) if (!Number.isInteger(frame[i]) || frame[i] < -20000 || frame[i] > 30000) fail("coordinate");
      } else {
        fail("frame flag");
      }
      session.replay(frame);
    }

    const durationMs = session.durationMs();
    const value = session.value();
    const maxRate = MAX_REPS_PER_SECOND[trace.exercise];
    const plausible = ex.kind === "plank" ? value <= Math.ceil(durationMs / 1000) : value <= Math.ceil((durationMs / 1000) * maxRate) + 2;
    return { value, exercise: trace.exercise, frames: trace.frames.length, durationMs, plausible };
  }

  return {
    jointAngle,
    tiltFromHorizontal,
    createRepCounter,
    createSquatCounter,
    createPushupCounter,
    createPlankTimer,
    EXERCISES,
    createSetSession,
    recountTrace,
    soundCue,
    MAX_SET_MS,
  };
});
