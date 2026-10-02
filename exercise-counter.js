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
      },
      options
    );

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
            if (postureMs > cfg.maxBadPostureMs) return Object.assign(result("bad_posture"), { depth, ...measures });
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
    return createRepCounter(Object.assign({ downBelow: 100, upAbove: 160, minRepMs: 500, minDrop: 0.2, maxAnchorMove: 0.25 }, options));
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

  return { jointAngle, tiltFromHorizontal, createRepCounter, createSquatCounter, createPushupCounter, createPlankTimer };
});
