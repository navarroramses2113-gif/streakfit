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

  // Plank: a timer that only runs while you're really holding a plank.
  // update(sample, timeMs), where sample is {bodyAngle, tilt, armTilt} -
  // the shoulder-hip-ankle angle (180 = perfectly straight), how far the
  // shoulder-to-ankle line leans from horizontal, and how steeply the upper
  // arm points down from the shoulder (null when not measured) - or null if
  // the body isn't visible.
  //
  // - Strict to start, forgiving to stay: the clock starts only on good
  //   form, but once holding, a little more sag or tilt is allowed.
  // - Arms must hold you up: in a plank (forearms or hands) the upper arm
  //   points down from the shoulder; lying flat on the floor, it's level.
  // - A wobble PAUSES the clock instead of resetting it: time with broken
  //   form doesn't count, and the hold only ends after `graceMs` of it.
  // `bestMs` is the longest hold, which is what counts for competition.
  function createPlankTimer(options) {
    const cfg = Object.assign(
      {
        minBodyAngle: 160, // straighter than this starts the clock
        maxTilt: 30, // must be roughly horizontal to start
        keepSlack: 10, // once holding, angle and tilt may each be this much worse
        minArmTilt: 40, // upper arm at least this steep (degrees) to start
        keepArmTilt: 30, // ...and to keep going
        startHoldMs: 1000, // form must be good this long before the clock starts
        graceMs: 3000, // broken form this long ends the hold (shorter = a pause)
        maxFrameGapMs: 500, // never credit more than this between two frames
        minRecordedMs: 3000, // holds shorter than this aren't recorded
        smoothing: 0.3,
      },
      options
    );

    let state = "waiting"; // waiting -> holding -> waiting
    let smoothedAngle = null;
    let goodSince = null;
    let heldMs = 0; // good-form time in the current hold
    let lastGoodAt = null;
    let lastFrameAt = null;
    let lastFrameGood = false;
    let bestMs = 0;
    const holds = [];

    function snapshot(reason) {
      const current = state === "holding" ? heldMs : 0;
      return {
        state,
        holdMs: current,
        bestMs: Math.max(bestMs, current >= cfg.minRecordedMs ? current : 0),
        paused: state === "holding" && !lastFrameGood,
        reason: reason || null,
        bodyAngle: smoothedAngle,
        holds,
      };
    }

    function endHold() {
      if (heldMs >= cfg.minRecordedMs) {
        holds.push(heldMs);
        bestMs = Math.max(bestMs, heldMs);
      }
      state = "waiting";
      heldMs = 0;
      goodSince = null;
      lastFrameGood = false;
    }

    // One frame while holding: good form adds the time since the last good
    // frame; broken form adds nothing, and ends the hold after graceMs.
    function holdFrame(good, timeMs) {
      if (good) {
        if (lastFrameGood) heldMs += Math.min(timeMs - lastFrameAt, cfg.maxFrameGapMs);
        lastGoodAt = timeMs;
      }
      lastFrameGood = good;
      lastFrameAt = timeMs;
      if (!good && timeMs - lastGoodAt > cfg.graceMs) endHold();
    }

    return {
      holds,

      update(sample, timeMs) {
        if (sample === null || sample === undefined) {
          if (state === "holding") holdFrame(false, timeMs);
          else goodSince = null;
          return snapshot("lost");
        }

        smoothedAngle = smoothedAngle === null ? sample.bodyAngle : cfg.smoothing * sample.bodyAngle + (1 - cfg.smoothing) * smoothedAngle;
        const holding = state === "holding";
        const slack = holding ? cfg.keepSlack : 0;
        const flat = sample.tilt <= cfg.maxTilt + slack;
        const straight = smoothedAngle >= cfg.minBodyAngle - slack;
        const armTilt = sample.armTilt ?? null;
        const supported = armTilt === null || armTilt >= (holding ? cfg.keepArmTilt : cfg.minArmTilt);
        const good = flat && straight && supported;
        const reason = good ? null : !supported ? "not_supported" : !flat ? "not_horizontal" : "hips_sagging_or_piking";

        if (state === "waiting") {
          if (good) {
            if (goodSince === null) goodSince = timeMs;
            if (timeMs - goodSince >= cfg.startHoldMs) {
              state = "holding";
              heldMs = timeMs - goodSince;
              lastGoodAt = timeMs;
              lastFrameAt = timeMs;
              lastFrameGood = true;
            }
          } else {
            goodSince = null;
          }
          return snapshot(reason);
        }

        holdFrame(good, timeMs);
        return snapshot(reason);
      },

      // Call when the set is over so a hold still in progress gets recorded.
      finish() {
        if (state === "holding") endHold();
        return snapshot(null);
      },

      reset() {
        state = "waiting";
        smoothedAngle = null;
        goodSince = null;
        heldMs = 0;
        lastGoodAt = null;
        lastFrameAt = null;
        lastFrameGood = false;
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
        // `plain` is what a person sees; `detail` is the numbers behind it,
        // shown only in debug mode.
        no_drop: { plain: "Sit lower - drop your hips", detail: (r) => "hips dropped " + pct(r.drop) + " of leg length" },
        anchor_moved: { plain: "Keep your feet planted", detail: (r) => "feet moved " + pct(r.anchorMove) + " of leg length" },
        bad_posture: { plain: "Keep your chest up", detail: (r) => "chest folded for " + ((r.badPostureMs ?? 0) / 1000).toFixed(1) + "s" },
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
        no_drop: { plain: "Go lower - chest toward the floor", detail: (r) => "chest dropped " + pct(r.drop) + " of body length" },
        anchor_moved: { plain: "Keep your hands planted", detail: (r) => "hands moved " + pct(r.anchorMove) + " of body length" },
        bad_posture: { plain: "Keep your body in a straight line", detail: (r) => "body out of line for " + ((r.badPostureMs ?? 0) / 1000).toFixed(1) + "s" },
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
      tip: "Put the phone on the floor about 6 feet away and hold a plank <b>side-on</b>, on your forearms or hands, with your whole body from head to feet in frame. The clock starts after one second of good form. A wobble just pauses it.",
      needs: ["shoulder", "hip", "ankle", "elbow"],
      // Recordings from before 2026-10-14 (trace v1) had no elbow; the
      // server still replays them, just without the arm check.
      needsV1: ["shoulder", "hip", "ankle"],
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
        // How steeply the upper arm points DOWN from the shoulder (the
        // picture's y grows downward): ~70-90 holding a plank, ~0 lying
        // flat. An elbow above the shoulder isn't holding anything up.
        let armTilt = null;
        if (pt.has("elbow")) {
          const elbow = pt("elbow");
          armTilt = elbow.y > shoulder.y ? tiltFromHorizontal(shoulder, elbow) : 0;
        }
        return { sample: bodyAngle === null ? null : { bodyAngle, tilt: tiltFromHorizontal(shoulder, ankle), armTilt } };
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
  const TRACE_VERSION = 2; // 2 (2026-10-14): planks also record the elbow
  // How far outside the picture (in frame widths/heights) a joint may be
  // and still be treated as seen. Well inside what recountTrace accepts.
  const OFF_FRAME_LIMIT = 0.5;
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
  // `version` is the trace format: 2 (current) records every joint in
  // `needs`; the server also replays version 1, recorded with `needsV1`.
  function createSetSession(exerciseKey, videoWidth, videoHeight, version = TRACE_VERSION) {
    const ex = EXERCISES[exerciseKey];
    if (!ex) throw new Error("unknown exercise");
    const needs = version === 1 && ex.needsV1 ? ex.needsV1 : ex.needs;
    const engine = ex.create(ex.sliders.map((s) => s.value));
    const frames = [];
    let lastT = 0;

    function feed(t, ints) {
      lastT = t;
      if (!ints) return { r: engine.update(null, t), m: null };
      const pt = (joint) => {
        const i = needs.indexOf(joint);
        return { x: (ints[2 * i] / COORD_SCALE) * videoWidth, y: (ints[2 * i + 1] / COORD_SCALE) * videoHeight };
      };
      pt.has = (joint) => needs.includes(joint);
      const m = ex.measure(pt);
      return { r: ex.kind === "plank" ? engine.update(m.sample, t) : engine.update(m.angle, t, m.extra), m };
    }

    return {
      engine,
      frames,
      push(t, joints) {
        // A joint more than half a frame outside the picture is the pose
        // model guessing, not seeing - e.g. standing up after push-ups next
        // to a phone on the floor puts the shoulders far above the top edge.
        // Record that frame as "body not visible" (it can't count toward a
        // rep) instead of storing positions the server would reject - which
        // used to throw out the whole set, good reps included.
        if (joints && joints.some(([x, y]) => !(x >= -OFF_FRAME_LIMIT && x <= 1 + OFF_FRAME_LIMIT && y >= -OFF_FRAME_LIMIT && y <= 1 + OFF_FRAME_LIMIT))) {
          joints = null;
        }
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
      trace: () => ({ v: version, exercise: exerciseKey, w: videoWidth, h: videoHeight, frames }),
    };
  }

  // Server side: rebuild a set from its record. Throws on anything
  // malformed (the record comes from an untrusted client), otherwise
  // returns what this code - not the client - says was done.
  function recountTrace(trace) {
    const fail = (why) => {
      throw new Error("bad trace: " + why);
    };
    if (!trace || (trace.v !== 1 && trace.v !== 2)) fail("version");
    const ex = EXERCISES[trace.exercise];
    if (!ex) fail("exercise");
    if (!Number.isFinite(trace.w) || !Number.isFinite(trace.h) || trace.w < 100 || trace.h < 100 || trace.w > 4000 || trace.h > 4000) fail("size");
    if (!Array.isArray(trace.frames) || trace.frames.length === 0 || trace.frames.length > MAX_TRACE_FRAMES) fail("frame count");

    const needs = trace.v === 1 && ex.needsV1 ? ex.needsV1 : ex.needs;
    const width = 2 + 2 * needs.length;
    const session = createSetSession(trace.exercise, trace.w, trace.h, trace.v);
    // Why a set came out lower than the person expected, as plain counts -
    // never positions: how many dips each check turned down, how much of
    // the set the body was out of sight, and whether the start position
    // (arms straight / standing tall / flat plank) was ever recognized.
    const rejected = {};
    let lostFrames = 0;
    let readyMs = null;
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
      const { r } = session.replay(frame);
      if (frame[1] === 0) lostFrames++;
      if (REJECTED_EVENTS.includes(r.event)) rejected[r.event] = (rejected[r.event] || 0) + 1;
      if (readyMs === null && r.state !== "waiting") readyMs = frame[0];
    }

    const durationMs = session.durationMs();
    const value = session.value();
    const maxRate = MAX_REPS_PER_SECOND[trace.exercise];
    const plausible = ex.kind === "plank" ? value <= Math.ceil(durationMs / 1000) : value <= Math.ceil((durationMs / 1000) * maxRate) + 2;
    return {
      value,
      exercise: trace.exercise,
      frames: trace.frames.length,
      durationMs,
      plausible,
      checks: { rejected, lostShare: Math.round((lostFrames / trace.frames.length) * 100) / 100, readyMs },
    };
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
