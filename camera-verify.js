// The in-app camera screen: records one verified set of an exercise and
// hands the result back. All the "is this a real rep" logic lives in
// supabase/functions/_shared/exercise-counter.js (the same file the server
// runs to recount every set); this file is just the camera, the pose model
// and the on-screen feedback around it. Nothing here ever uploads video -
// the pose model runs on the device, and all that's sent is the recorded
// joint movement, which the server replays and counts for itself.
//
// Usage: ForjaCamera.open("pushup", async ({ exercise, value, trace }) => {
//   ...save it...; return { ok: true, value } or { ok: false, error: "text" }
// }, { onClose })   <- optional: runs instead of returning to the app
const ForjaCamera = (function () {
  const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs";
  const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

  // MediaPipe pose landmark indexes for each side of the body.
  const JOINTS = {
    left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
    right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
  };

  // Frames are processed at most this often. It keeps the recorded set
  // small and gives the server a fixed rate to replay, instead of whatever
  // frame rate a given phone's camera happens to run at.
  const MIN_FRAME_GAP_MS = 33;
  // Stop a set before the server's length limit would reject it.
  const AUTO_FINISH_MS = ForjaCounter.MAX_SET_MS - 10000;

  const $ = (id) => document.getElementById(id);
  const pct = (x) => Math.round((x ?? 0) * 100) + "%";

  // Debug mode shows the numbers behind every decision (angles, percentages)
  // - essential for tuning, noise for everyone else. It's off for users and
  // switched by tapping the exercise title five times quickly, so there is
  // no visible control to find by accident.
  const Debug = (function () {
    const STORAGE_KEY = "forja-debug";
    let on = false;
    try {
      on = localStorage.getItem(STORAGE_KEY) === "on";
    } catch (e) {
      // storage blocked - stays off
    }
    return {
      isOn: () => on,
      set(value) {
        on = value;
        try {
          localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
        } catch (e) {
          // not remembered
        }
      },
    };
  })();

  // Audio cues, so someone six feet away can tell a rep counted (or didn't)
  // without looking. The tones are tiny WAV files built in code and played
  // through ordinary <audio> elements rather than the Web Audio API,
  // because iPhones mute Web Audio when the silent switch is on but still
  // play <audio> - and that's exactly the situation people are in.
  const Sound = (function () {
    const RATE = 22050;
    const STORAGE_KEY = "forja-sound";
    const TONES = {
      rep: [{ freq: 880, ms: 120 }], // short and bright: counted
      ready: [{ freq: 660, ms: 90, gapMs: 40 }, { freq: 880, ms: 110 }], // rising chirp: in position
      reject: [{ freq: 170, ms: 280, square: true, volume: 0.3 }], // low buzz: didn't count
      end: [{ freq: 660, ms: 120, gapMs: 30 }, { freq: 440, ms: 200 }], // falling: hold ended
    };

    function buildWav(notes) {
      const samples = [];
      for (const { freq, ms, square, volume = 0.6, gapMs = 0 } of notes) {
        const n = Math.round((RATE * ms) / 1000);
        // A few ms of fade in and out stops the click of an abrupt start/stop.
        const fade = Math.max(1, Math.min(Math.round(RATE * 0.008), Math.floor(n / 2)));
        for (let i = 0; i < n; i++) {
          let s = Math.sin((2 * Math.PI * freq * i) / RATE);
          if (square) s = s >= 0 ? 1 : -1;
          const envelope = Math.min(1, i / fade, (n - 1 - i) / fade);
          samples.push(s * envelope * volume);
        }
        for (let i = 0; i < Math.round((RATE * gapMs) / 1000); i++) samples.push(0);
      }
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
      text(0, "RIFF");
      view.setUint32(4, 36 + samples.length * 2, true);
      text(8, "WAVE");
      text(12, "fmt ");
      view.setUint32(16, 16, true); // PCM header size
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // mono
      view.setUint32(24, RATE, true);
      view.setUint32(28, RATE * 2, true); // bytes per second
      view.setUint16(32, 2, true); // bytes per sample
      view.setUint16(34, 16, true); // bits per sample
      text(36, "data");
      view.setUint32(40, samples.length * 2, true);
      samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true));
      return new Blob([buffer], { type: "audio/wav" });
    }

    const elements = {};
    let enabled = true;
    try {
      enabled = localStorage.getItem(STORAGE_KEY) !== "off";
    } catch (e) {
      // storage blocked - sound just defaults to on
    }

    return {
      isEnabled: () => enabled,
      setEnabled(value) {
        enabled = value;
        try {
          localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
        } catch (e) {
          // not remembered, still applies this session
        }
      },
      // Browsers only allow sound to start from a tap. Playing each clip
      // once, muted, inside the Start tap "unlocks" it for later.
      prime() {
        if (Object.keys(elements).length > 0) return;
        for (const [name, notes] of Object.entries(TONES)) {
          const audio = new Audio(URL.createObjectURL(buildWav(notes)));
          audio.preload = "auto";
          elements[name] = audio;
          audio.muted = true;
          const started = audio.play();
          const unmute = () => {
            audio.pause();
            audio.currentTime = 0;
            audio.muted = false;
          };
          if (started && started.then) started.then(unmute).catch(() => (audio.muted = false));
          else unmute();
        }
      },
      play(name) {
        const audio = elements[name];
        if (!enabled || !audio) return;
        audio.currentTime = 0;
        const started = audio.play();
        if (started && started.catch) started.catch(() => {});
      },
    };
  })();

  let poseLandmarker = null;
  let modelLoading = null;
  let stream = null;
  let running = false;
  let facing = "user";
  let lastVideoTime = -1;
  let exerciseKey = null;
  let exercise = null;
  let session = null;
  let sessionSize = { w: 0, h: 0 }; // the video's shape the recording is measured in
  let lastResult = null; // the counter's latest result this set (what's counted so far)
  let pendingBuzzAt = null; // a rejection buzz waiting to see if the person stays (see settleBuzz)
  let setStartMs = 0;
  let lastProcessedMs = -Infinity;
  let onSave = null;
  // Where closing goes: back to the app, unless the opener said otherwise
  // (the sign-up flow returns to itself).
  let onClose = null;
  let currentSideName = null;
  let prevState = "waiting";
  let lastBuzzAt = -Infinity;
  let attempts = [];
  let result = 0;
  let resultUnit = "";
  let rewardFor = null; // options.reward: what a finished set earned (see renderReward)
  let progressFor = null; // options.progress: {before, target, hold} for the live ring
  let saved = false; // verified and waiting for "Done"
  let rewardRun = 0; // bumped to stop a reward animation that's no longer on screen

  // A set in progress is copied to this phone as it goes, so an app that
  // closes mid-set (a crash, iOS reclaiming memory, a reload) can't take
  // the reps with it: the next time the app opens, the set is offered back
  // to save (see recover). The copy is the same recording the server
  // recounts, so nothing about it can be claimed that wasn't done. It's
  // removed once the set is saved, redone or closed.
  const BACKUP_KEY = "forja-unsaved-set";
  const BACKUP_EVERY_MS = 3000;
  let backupTag = null; // options.backup ({ user, day }): whose set this is, and for which day
  let lastBackupAt = -Infinity;
  let backupDue = false; // a rep just counted - copy it now, not in 3 s

  function writeBackup(extra) {
    if (!backupTag || !session) return;
    lastBackupAt = performance.now();
    backupDue = false;
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ tag: backupTag, trace: session.trace(), ...extra }));
    } catch (e) {
      // storage full or blocked - this set just isn't backed up
    }
  }
  function clearBackup() {
    if (!backupTag) return;
    try {
      localStorage.removeItem(BACKUP_KEY);
    } catch (e) {
      // storage blocked - nothing was kept
    }
  }
  // The kept set, recounted the way the server will, or null when there's
  // none (or nothing in it would count).
  function readBackup() {
    try {
      const kept = JSON.parse(localStorage.getItem(BACKUP_KEY) || "null");
      if (!kept || !kept.tag || !kept.trace) return null;
      const recount = ForjaCounter.recountTrace(kept.trace);
      if (!recount.plausible || recount.value <= 0) return null;
      return { ...kept, exercise: kept.trace.exercise, value: recount.value };
    } catch (e) {
      return null; // unreadable or a recording the server would refuse
    }
  }

  // The pose model is ~6 MB, so it only downloads the first time someone
  // actually opens the camera - not on every app load.
  async function loadModel() {
    if (poseLandmarker) return;
    if (!modelLoading) {
      modelLoading = (async () => {
        const { PoseLandmarker, FilesetResolver } = await import(VISION_URL);
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        const create = (delegate) =>
          PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate },
            runningMode: "VIDEO",
            numPoses: 1,
          });
        try {
          poseLandmarker = await create("GPU");
        } catch (err) {
          poseLandmarker = await create("CPU");
        }
      })();
    }
    try {
      await modelLoading;
    } catch (err) {
      modelLoading = null; // allow a retry instead of failing forever
      throw err;
    }
  }

  async function startStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("no-camera-api");
    }
    const constraints = {
      // 16:9 (720x1280 on a phone held upright): close to the screen's own
      // shape, so the full-screen picture shows nearly all the counter sees.
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Right after the last set let go of it, the camera can still be busy
      // for a moment: one more try. A "no" from the person is final.
      if (err && err.name === "NotAllowedError") throw err;
      await new Promise((resolve) => setTimeout(resolve, 600));
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }
    const video = $("camera-video");
    $("camera-stage").classList.add("is-starting");
    video.srcObject = stream;
    await video.play();
    await settledSize(video);
    $("camera-stage").classList.remove("is-starting");
    $("camera-overlay").width = video.videoWidth;
    $("camera-overlay").height = video.videoHeight;
    $("camera-stage").classList.toggle("mirrored", facing === "user");
  }

  // iPhones can hand over the first frames in another shape (sideways)
  // before the real one, and with the picture filling the screen that
  // looks like a sudden zoom as the camera opens (2026-10-19). So the
  // picture stays hidden (.is-starting) until its size has held still for
  // a moment, then fades in.
  function settledSize(video) {
    return new Promise((resolve) => {
      let quiet = null;
      const done = () => {
        clearTimeout(quiet);
        clearTimeout(cap);
        video.removeEventListener("resize", restart);
        resolve();
      };
      const restart = () => {
        clearTimeout(quiet);
        quiet = setTimeout(done, 350);
      };
      const cap = setTimeout(done, 1500); // never wait longer than this
      video.addEventListener("resize", restart);
      restart();
    });
  }

  function stopStream() {
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    $("camera-video").srcObject = null;
    const overlay = $("camera-overlay");
    overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
  }

  // Sticks with whichever side of the body it's already tracking unless
  // the other is clearly better - flipping between left and right every
  // few frames would swap which joints are measured and look like a
  // sudden jump.
  function pickSide(landmarks) {
    const scores = {};
    for (const [name, idx] of Object.entries(JOINTS)) {
      scores[name] = Math.min(...exercise.needs.map((joint) => landmarks[idx[joint]].visibility ?? 0));
    }
    let name = currentSideName;
    const other = name === "left" ? "right" : "left";
    if (!name || scores[name] < exercise.minVisibility || scores[other] > scores[name] + 0.2) {
      name = scores.left >= scores.right ? "left" : "right";
    }
    if (scores[name] < exercise.minVisibility) {
      currentSideName = null;
      return null;
    }
    currentSideName = name;
    return { name, idx: JOINTS[name] };
  }

  // Not every joint the exercise needs is visible: which ones are missing,
  // on whichever side the camera sees best (null = no body at all).
  const PART_NAMES = { shoulder: "shoulders", elbow: "elbows", wrist: "hands", hip: "hips", knee: "knees", ankle: "feet" };
  function missingParts(landmarks) {
    let best = null;
    for (const idx of Object.values(JOINTS)) {
      const vis = (joint) => landmarks[idx[joint]].visibility ?? 0;
      const missing = exercise.needs.filter((joint) => vis(joint) < exercise.minVisibility);
      const score = Math.min(...exercise.needs.map(vis));
      if (!best || score > best.score) best = { idx, missing, score };
    }
    return best;
  }

  // What to fix, in words: the missing body parts, and how. A body lying
  // flat (push-ups, plank) rarely fits a phone standing upright - the feet
  // are what usually falls off the edge.
  function lyingInUprightFrame() {
    const video = $("camera-video");
    return (exerciseKey === "pushup" || exerciseKey === "plank") && video.videoHeight > video.videoWidth;
  }
  function missingHint(missing) {
    const parts = [...new Set(missing.map((joint) => tr(PART_NAMES[joint])))];
    const list = parts.length < 3 ? parts.join(tr(" and ")) : tr("whole body");
    const far = missing.includes("ankle") || missing.includes("knee") || parts.length >= 3;
    const how = far && lyingInUprightFrame() ? tr("turn the phone sideways or move it back") : far ? tr("move the phone back") : tr("turn side-on to the camera");
    return tr("Can't see your {parts} - {how}", { parts: list, how });
  }

  // The joints it can see, drawn in gray, so it's clear the camera has you
  // and what's cut off.
  function drawPartial(landmarks, idx) {
    const overlay = $("camera-overlay");
    const ctx = overlay.getContext("2d");
    const w = overlay.width;
    const h = overlay.height;
    const seen = (joint) => (landmarks[idx[joint]].visibility ?? 0) >= exercise.minVisibility;
    const at = (joint) => ({ x: landmarks[idx[joint]].x * w, y: landmarks[idx[joint]].y * h });
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#a1a1aa";
    exercise.draw.forEach((joint, i) => {
      const next = exercise.draw[i + 1];
      if (!next || !seen(joint) || !seen(next)) return;
      const a = at(joint);
      const b = at(next);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
    ctx.fillStyle = "#fff";
    exercise.draw.filter(seen).forEach((joint) => {
      const p = at(joint);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawBody(landmarks, side, good) {
    const overlay = $("camera-overlay");
    const ctx = overlay.getContext("2d");
    const w = overlay.width;
    const h = overlay.height;
    const points = exercise.draw.map((j) => ({ x: landmarks[side.idx[j]].x * w, y: landmarks[side.idx[j]].y * h }));
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.strokeStyle = good ? "#22c55e" : "#ffc233";
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.fillStyle = "#fff";
    points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function setFeedback(text, kind) {
    const el = $("camera-feedback");
    el.textContent = text;
    el.className = "camera-feedback" + (kind ? " " + kind : "");
  }

  // Plays whatever sound this frame calls for (counted, rejected, ready...).
  // The rejection buzz waits a moment first (see settleBuzz): getting up to
  // grab the phone after the last rep looks like a bad rep or two and then
  // a lost one, and that shouldn't buzz at anyone (2026-10-17).
  const BUZZ_HOLD_MS = 800;
  function cue(result) {
    const name = ForjaCounter.soundCue(prevState, result, exercise.kind);
    prevState = result.state;
    if (!name) return;
    if (name === "reject") {
      // Lost sight mid-rep: nearly always someone leaving. The words say it.
      if (result.event !== "abandoned") pendingBuzzAt = performance.now();
      return;
    }
    Sound.play(name);
  }

  // A held buzz plays once BUZZ_HOLD_MS pass with the person still in
  // place (in view, and for push-ups still roughly flat); leaving or
  // standing up meanwhile cancels it. Still at most one buzz per 1.5 s - a
  // flurry of fidgeting should never turn into a flurry of buzzing.
  function settleBuzz(stillInPlace) {
    if (pendingBuzzAt === null) return;
    if (!stillInPlace) {
      pendingBuzzAt = null;
      return;
    }
    const now = performance.now();
    if (now - pendingBuzzAt < BUZZ_HOLD_MS) return;
    pendingBuzzAt = null;
    if (now - lastBuzzAt < 1500) return;
    lastBuzzAt = now;
    Sound.play("reject");
  }

  // What a rep event means in words - used for the live feedback line AND
  // the per-attempt list on the review screen, so a rep that did not count
  // always comes with its reason.
  function describeEvent(r) {
    let kind = "bad", plain = null, detail = null;
    if (r.event === "rep") {
      kind = "good";
      plain = tr("Counted");
      detail = exercise.jointName + " " + Math.round(r.lastRep.depth) + "\u00b0, " + exercise.dropName + " down " + pct(r.lastRep.drop);
    } else if (r.event === "shallow") {
      plain = tr("Go lower");
      detail = exercise.jointName + " only reached " + Math.round(r.depth) + "\u00b0";
    } else if (r.event === "too_fast") {
      plain = tr("Slow down - control the movement");
      detail = "faster than a real rep can be";
    } else if (r.event === "abandoned") {
      plain = tr("Lost sight of you - that rep didn't count. Reset and go again.");
      detail = "tracking was lost mid-rep";
    } else if (r.event && exercise.events[r.event]) {
      plain = tr(exercise.events[r.event].plain);
      detail = exercise.events[r.event].detail(r);
    }
    if (!plain) return null;
    return { kind, text: Debug.isOn() && detail ? plain + " (" + detail + ")" : plain };
  }
  function noteEvent(r) {
    const described = describeEvent(r);
    if (!described) return;
    setFeedback(described.text, described.kind);
    attempts.push({ ok: described.kind === "good", text: described.text });
    if (described.kind === "good") backupDue = true;
  }

  // t is milliseconds since the set started - the same clock the server
  // replays the recording with.
  function handleFrame(output, t) {
    const landmarks = output.landmarks && output.landmarks[0];
    const side = landmarks ? pickSide(landmarks) : null;

    if (!side) {
      const lost = session.push(t, null).r;
      lastResult = lost;
      cue(lost);
      settleBuzz(false);
      noteEvent(lost);
      // Part of a body: show it and name what's cut off. None at all: the
      // general line.
      const partial = landmarks ? missingParts(landmarks) : null;
      if (partial && partial.missing.length < exercise.needs.length) {
        drawPartial(landmarks, partial.idx);
        coach(missingHint(partial.missing), true);
      } else {
        const overlay = $("camera-overlay");
        overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
        coach(lyingInUprightFrame() ? tr("Can't see you - turn the phone sideways, whole body in frame") : tr(exercise.lost), true);
      }
      $("camera-live").textContent = "";
      return;
    }

    const joints = exercise.needs.map((joint) => [landmarks[side.idx[joint]].x, landmarks[side.idx[joint]].y]);
    const { r, m } = session.push(t, joints);
    lastResult = r;
    cue(r);
    // Push-ups happen flat on the floor; a body tilting up is someone
    // getting up.
    settleBuzz(exerciseKey !== "pushup" || !(m && m.tilt > 35));

    if (exercise.kind === "plank") {
      drawBody(landmarks, side, r.state === "holding");
      $("camera-count").textContent = (r.holdMs / 1000).toFixed(1);
      liveRing(Math.max(r.bestMs, r.holdMs) / 1000);
      // A wobble pauses the clock (it doesn't reset): say so, and what to fix.
      const fix =
        r.reason === "not_supported"
          ? tr("Up on your forearms or hands")
          : r.reason === "not_horizontal"
            ? tr("Get flat - body should be horizontal")
            : r.reason === "hips_sagging_or_piking"
              ? tr("Straighten your body - hips level with shoulders and ankles")
              : tr("Get into plank position");
      if (r.state === "holding") {
        coach(r.paused ? tr("Paused - {fix}", { fix: fix.charAt(0).toLowerCase() + fix.slice(1) }) : tr("Holding - keep it straight"), r.paused);
      } else {
        coach(fix, true);
      }
      setFeedback(r.bestMs > 0 ? tr("Best hold: {s}s", { s: (r.bestMs / 1000).toFixed(1) }) : "", r.bestMs > 0 ? "good" : "");
      return;
    }

    drawBody(landmarks, side, r.state !== "down");
    $("camera-count").textContent = r.count;
    liveRing(r.count);
    // Before counting starts, say exactly what's missing instead of just
    // "get in position" - the start position has several conditions and
    // any one failing looks the same from outside.
    const hint = r.state === "waiting" && exercise.waitingHint ? exercise.waitingHint(m) : null;
    coach(tr(hint || exercise.states[r.state] || ""), !!hint);
    $("camera-live").textContent =
      Debug.isOn() && r.drop !== null ? exercise.dropName + " down " + pct(r.drop) + "  ·  " + exercise.anchorName + " moved " + pct(r.anchorMove) : "";

    noteEvent(r);
  }

  function loop() {
    if (!running) return;
    const video = $("camera-video");
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime && video.videoWidth > 0) {
      lastVideoTime = video.currentTime;
      if ((video.videoWidth !== sessionSize.w || video.videoHeight !== sessionSize.h) && videoChangedShape(video)) return;
      const now = performance.now();
      if (now - lastProcessedMs >= MIN_FRAME_GAP_MS) {
        lastProcessedMs = now;
        const t = Math.round(now - setStartMs);
        handleFrame(poseLandmarker.detectForVideo(video, now), t);
        if (backupDue || now - lastBackupAt >= BACKUP_EVERY_MS) writeBackup();
        if (t >= AUTO_FINISH_MS) {
          finishSet();
          return;
        }
      }
    }
    requestAnimationFrame(loop);
  }

  // Which of the screen's three modes is showing: "idle" (before the set),
  // "running" (counting) or "review" (set finished, decide whether to keep).
  function setMode(mode) {
    $("camera-screen").classList.toggle("is-running", mode === "running");
    $("camera-screen").classList.toggle("is-review", mode === "review");
    $("camera-start-button").classList.toggle("hidden", mode !== "idle");
    $("camera-finish-button").classList.toggle("hidden", mode !== "running");
    $("camera-flip-button").classList.toggle("hidden", mode === "review");
    $("camera-sound-button").classList.toggle("hidden", mode !== "idle");
    $("camera-review").classList.toggle("hidden", mode !== "review");
    // After a counted set the choice is just Save or Redo; Close is only
    // offered when there's nothing to save.
    $("camera-close-button").classList.toggle("hidden", mode === "running" || (mode === "review" && result > 0));
    $("camera-stage").classList.toggle("hidden", mode === "review");
    if (mode !== "review") $("camera-title").textContent = tr(exercise.title);
  }

  async function startSet() {
    // Must run in the tap itself, before anything is awaited, or the browser
    // won't let the beeps play later.
    Sound.prime();
    $("camera-start-button").disabled = true;
    setFeedback("", "");
    say(tr("Loading pose model (first time only)..."));
    try {
      await loadModel();
    } catch (err) {
      say(tr("Couldn't load the camera model - check your connection and try again."), true);
      $("camera-start-button").disabled = false;
      return;
    }

    say(tr("Starting camera..."));
    try {
      await startStream();
    } catch (err) {
      say(
        err && err.name === "NotAllowedError"
          ? tr("Camera access was denied. Allow it in your browser settings to log workouts.")
          : tr("Couldn't start the camera on this device."),
        true
      );
      $("camera-start-button").disabled = false;
      return;
    }

    clearBackup(); // a new set: whatever was kept is done with
    newSession();
    say(tr("Get in position"));
    running = true;
    setMode("running");
    $("camera-start-button").disabled = false;
    loop();
  }

  // A fresh recording, measured in the video's current shape.
  function newSession() {
    const video = $("camera-video");
    session = ForjaCounter.createSetSession(exerciseKey, video.videoWidth, video.videoHeight);
    sessionSize = { w: video.videoWidth, h: video.videoHeight };
    lastResult = null;
    pendingBuzzAt = null;
    lastBackupAt = -Infinity;
    backupDue = false;
    currentSideName = null;
    prevState = "waiting";
    lastBuzzAt = -Infinity;
    attempts = [];
    setStartMs = performance.now();
    lastProcessedMs = -Infinity;
    $("camera-count").textContent = exercise.kind === "plank" ? "0.0" : "0";
    liveRing(0);
  }

  // The status pill. hint = something to fix (white), else it's going
  // right (green).
  function say(text, hint = false) {
    const el = $("camera-state");
    el.textContent = text;
    el.classList.toggle("is-hint", hint);
    shownLine = { text, hint, at: performance.now() };
    otherSince = null;
  }

  // The pill during a set, held steady. The pose model's guess wobbles
  // from frame to frame, and words changing several times a second make
  // the app look like it's glitching (2026-10-19). So a new line has to be
  // asked for COACH_SETTLE_MS in a row before it shows, and a hint stays up
  // at least COACH_MIN_SHOW_MS. Except the rep going right ("Ready - lower
  // yourself" -> "Down - now push all the way up"): that follows the
  // person's movement, so it switches at once.
  const COACH_SETTLE_MS = 500;
  const COACH_MIN_SHOW_MS = 1500;
  let shownLine = { text: "", hint: false, at: -Infinity };
  let otherSince = null; // since when the frames have wanted something else on the pill
  function coach(text, hint) {
    if (text === shownLine.text && hint === shownLine.hint) {
      otherSince = null;
      return;
    }
    const now = performance.now();
    if (otherSince === null) otherSince = now;
    if (hint || shownLine.hint) {
      if (now - otherSince < COACH_SETTLE_MS) return;
      if (shownLine.hint && now - shownLine.at < COACH_MIN_SHOW_MS) return;
    }
    say(text, hint);
  }

  // Today's ring for this exercise, as this set adds to it: reps add up
  // across sets, a plank counts its best single hold (same rule as the
  // reward, script.js setReward). Hidden when there's no day to fill
  // (sign-up, challenges).
  function liveRing(setValue) {
    const ring = $("camera-ring");
    ring.classList.toggle("hidden", !progressFor);
    if (!progressFor) return;
    const { before, target, hold } = progressFor;
    const total = hold ? Math.max(before, Math.floor(setValue)) : before + setValue;
    $("camera-ring-fill").setAttribute("stroke-dasharray", `${(213.6 * Math.min(total, target)) / target} 213.6`);
    $("camera-ring-fill").style.opacity = total > 0 ? 1 : 0; // a zero-length round cap still draws a dot
    $("camera-ring-text").textContent = `${total}/${target}${hold ? "s" : ""}`;
  }

  // The phone turned (upright <-> sideways) mid-set, so the video changed
  // shape. A recording keeps one shape - every angle is measured in it - so
  // nothing counted yet: start the set over in the new shape, quietly.
  // Something counted: end the set here so those reps go to Save, and the
  // next set starts in the new shape. Returns true when the set ended.
  function videoChangedShape(video) {
    const overlay = $("camera-overlay");
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    const counted = lastResult && (exercise.kind === "plank" ? lastResult.bestMs > 0 || lastResult.state === "holding" : lastResult.count > 0);
    if (counted) {
      finishSet();
      return true;
    }
    clearBackup();
    newSession();
    return false;
  }

  function finishSet() {
    result = session.value();
    stopStream();
    // Kept until it's saved: the review screen can be lost too.
    if (result > 0) writeBackup();
    else clearBackup();
    showReview();
  }

  function showReview() {
    // The finished set gets its number and what it earned - none of the
    // live coaching text. (The rep-by-rep list is for debug mode only.)
    const counted = result > 0;
    resultUnit = exercise.kind === "plank" ? "s" : "";
    saved = false;
    // Without a reward there's no pet to say why nothing counted.
    $("camera-result-note").textContent = !counted && !rewardFor ? tr("Make sure your whole body is in frame, side-on, and try again.") : "";
    const save = $("camera-save-button");
    save.classList.toggle("hidden", !counted);
    save.classList.remove("is-verified");
    save.disabled = false;
    save.textContent = tr("Save set");
    $("camera-redo-button").classList.remove("hidden");
    $("camera-redo-button").textContent = counted ? tr("Redo set") : tr("Try again");
    $("camera-attempts").classList.toggle("hidden", !Debug.isOn());
    renderAttempts();
    setMode("review");
    renderReward(rewardFor ? rewardFor(exerciseKey, result) : null);
  }

  // ---------- what the set earned ----------
  // reward (from whoever opened the camera, or null when there's no day
  // to measure against, like the sign-up "find my level" test):
  //   { from, to }       today's progress for this exercise, 0-1, before and after
  //   { total, target }  for "12 of 8 today"
  //   badges             [{ kind: "best" | "done" | "day", text }]
  //   line, face         the pet's line (HTML, numbers and fixed words only) and face
  //   day                [{ key, name, done }] today's exercises
  // The number counts up while the ring fills (frame by frame - iPhones
  // animate a ring's dash length unreliably); then the badges pop in with
  // a little confetti and the pet says its line.
  const SET_COLORS = { pushup: "var(--ring-pushups)", plank: "var(--ring-planks)", squat: "var(--ring-squats)" };
  const DAY_COLORS = { pushups: "var(--ring-pushups)", planks: "var(--ring-planks)", squats: "var(--ring-squats)" };
  const RING_LENGTH = 2 * Math.PI * 50;
  const TROPHY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v6a4 4 0 0 1-8 0V4z"/><path d="M8 5H5a2 2 0 0 0 0 4h3"/><path d="M16 5h3a2 2 0 0 1 0 4h-3"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="9" y1="21" x2="15" y2="21"/></svg>';
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 0 : ms));
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  function frames(ms, onFrame) {
    return new Promise((resolve) => {
      if (reducedMotion()) {
        onFrame(1);
        resolve();
        return;
      }
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms);
        onFrame(t);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  const drawRing = (fraction) => {
    const length = Math.max(0, Math.min(1, fraction)) * RING_LENGTH;
    $("reward-ring-fill").setAttribute("stroke-dasharray", `${length} ${RING_LENGTH}`);
    $("reward-ring-fill").style.opacity = length > 0 ? 1 : 0; // a zero-length round cap still draws a dot
  };

  function popIn(el) {
    el.classList.remove("reward-pop");
    void el.offsetWidth;
    el.classList.add("reward-pop");
  }

  function confetti(amount) {
    if (reducedMotion() || !Element.prototype.animate) return;
    const host = $("reward-ring");
    const colors = ["var(--ring-pushups)", "var(--ring-planks)", "var(--ring-squats)", "var(--accent)"];
    for (let i = 0; i < amount; i++) {
      const bit = document.createElement("i");
      bit.className = "reward-bit";
      bit.style.background = colors[i % colors.length];
      host.appendChild(bit);
      const angle = Math.random() * Math.PI * 2;
      const distance = 110 + Math.random() * 90;
      bit.animate(
        [
          { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 1 },
          { transform: `translate(${Math.round(Math.cos(angle) * distance)}px, ${Math.round(Math.sin(angle) * distance * 0.85 + 40)}px) rotate(${Math.round(Math.random() * 540 - 270)}deg)`, opacity: 0 },
        ],
        { duration: 1100 + Math.random() * 300, easing: "cubic-bezier(0.2, 0.7, 0.4, 1)", fill: "forwards" }
      ).onfinish = () => bit.remove();
    }
  }

  async function renderReward(reward) {
    const run = ++rewardRun;
    const still = () => run === rewardRun;
    const fmt = (n) => n + resultUnit;
    $("camera-screen").style.setProperty("--set-color", SET_COLORS[exerciseKey]);
    $("reward-name").textContent = tr(exercise.title);
    $("camera-result-label").textContent = exercise.kind === "plank" ? tr("plank hold") : tr(exercise.title).toLowerCase();
    $("camera-result").classList.toggle("is-zero", result === 0);
    // Sized by the final number so it doesn't shrink mid count-up.
    $("camera-result").classList.toggle("is-long", fmt(result).length >= 4);
    $("camera-result").textContent = fmt(0);
    $("reward-today").innerHTML = "";
    $("reward-badges").innerHTML = "";
    document.querySelectorAll(".reward-bit").forEach((bit) => bit.remove());
    const coach = $("reward-coach");
    coach.classList.add("is-quiet");
    $("reward-pet").classList.remove("hop", "shake");
    $("reward-line").innerHTML = "";
    // This exercise's marker turns done only once the ring has filled.
    const finishedNow = reward && reward.from < 1 && reward.to >= 1;
    $("reward-day").innerHTML = reward
      ? reward.day
          .map((d) => `<span id="reward-day-${d.key}" class="${d.done && !(finishedNow && d.key === reward.key) ? "is-done" : ""}" style="--c:${DAY_COLORS[d.key]}"><i></i>${d.name}</span>`)
          .join("")
      : "";

    const from = reward ? Math.min(1, reward.from) : 0;
    const to = reward ? Math.min(1, reward.to) : result > 0 ? 1 : 0;
    drawRing(from);
    await pause(150);
    if (!still()) return;
    await frames(800, (t) => {
      if (!still()) return;
      const e = easeOut(t);
      drawRing(from + (to - from) * e);
      $("camera-result").textContent = fmt(Math.round(result * e));
    });
    if (!still()) return;
    $("camera-result").textContent = fmt(result);
    if (reward && result > 0) $("reward-today").innerHTML = tr("<b>{total}</b> of {target} today", { total: fmt(reward.total), target: fmt(reward.target) });

    if (finishedNow && !reducedMotion()) {
      const fill = $("reward-ring-fill");
      await frames(320, (t) => {
        fill.style.strokeWidth = 12 + 6 * Math.sin(Math.PI * t);
      });
      fill.style.strokeWidth = "";
      if (!still()) return;
    }
    if (finishedNow) {
      const marker = $("reward-day-" + reward.key);
      if (marker) {
        marker.classList.add("is-done");
        popIn(marker);
      }
    }

    const badges = reward ? reward.badges : [];
    for (const badge of badges) {
      const el = document.createElement("span");
      el.className = "reward-badge is-" + badge.kind;
      el.innerHTML = (badge.kind === "best" ? TROPHY_ICON : badge.kind === "done" ? "✓ " : "") + badge.text;
      $("reward-badges").appendChild(el);
      popIn(el);
      await pause(160);
      if (!still()) return;
    }
    if (badges.length) confetti(badges.some((b) => b.kind === "day") ? 46 : badges.some((b) => b.kind === "best") ? 32 : 18);

    if (reward && reward.line && typeof Onboarding !== "undefined") {
      $("reward-pet").innerHTML = Onboarding.mascot(reward.face || "happy");
      $("reward-line").innerHTML = reward.line;
      coach.classList.remove("is-quiet");
      if (!reducedMotion()) {
        void $("reward-pet").offsetWidth;
        $("reward-pet").classList.add(reward.face === "worried" ? "shake" : "hop");
      }
    }
  }

  function renderAttempts() {
    const list = $("camera-attempts");
    list.innerHTML = "";
    attempts.slice(-12).forEach((attempt) => {
      const li = document.createElement("li");
      li.className = attempt.ok ? "ok" : "no";
      li.textContent = (attempt.ok ? "\u2713 " : "\u2717 ") + attempt.text;
      list.appendChild(li);
    });
  }

  function close() {
    rewardRun++;
    saved = false;
    stopStream();
    clearBackup();
    if (onClose) onClose();
    else showScreen("app-screen");
  }

  async function saveSet() {
    const button = $("camera-save-button");
    // Already verified: this is the "Done" tap.
    if (saved) {
      close();
      return;
    }
    button.disabled = true;
    button.textContent = tr("Verifying...");

    // When it went out: if the app closes before the reply, the next start
    // can tell whether the server already has it (see the app's recovery).
    writeBackup({ sentAt: Date.now() });
    const outcome = await onSave({ exercise: exerciseKey, value: result, trace: session.trace() });
    if (outcome && outcome.ok) clearBackup();

    if (!outcome || !outcome.ok) {
      $("camera-result-note").textContent = (outcome && outcome.error) || tr("Couldn't verify this set. Check your connection and try again.");
      // A recording the server refused will be refused again - sending it a
      // second time can't help, so point to Redo instead of "Try again".
      // Anything else (no signal, server busy) is worth retrying as-is.
      if (outcome && (outcome.code === "bad_trace" || outcome.code === "implausible")) {
        clearBackup();
        button.classList.add("hidden");
        $("camera-close-button").classList.remove("hidden");
        return;
      }
      button.disabled = false;
      button.textContent = tr("Try again");
      return;
    }

    if (outcome.value !== result) {
      // The server's recount is the one that counts. Show it instead of
      // quietly saving a different number than the one on screen.
      $("camera-result").textContent = outcome.value + resultUnit;
      $("camera-result-note").textContent = tr("Saved. The server's recount is the official number.");
      button.classList.add("hidden");
      $("camera-close-button").classList.remove("hidden");
      return;
    }
    // Verified: the button stamps, then waits for a tap to go back - there's
    // nothing left to redo.
    saved = true;
    $("camera-redo-button").classList.add("hidden");
    button.disabled = false;
    button.textContent = tr("✓ Verified");
    button.classList.remove("is-verified");
    void button.offsetWidth;
    button.classList.add("is-verified");
    setTimeout(() => {
      if (saved) button.textContent = tr("Done");
    }, 900);
  }

  function renderSoundButton() {
    const on = Sound.isEnabled();
    $("camera-sound-button").setAttribute("aria-pressed", String(on));
    $("camera-sound-button").setAttribute("aria-label", on ? tr("Sound on") : tr("Sound off"));
  }

  function wireButtonsOnce() {
    if (wireButtonsOnce.done) return;
    wireButtonsOnce.done = true;
    $("camera-start-button").addEventListener("click", startSet);
    $("camera-finish-button").addEventListener("click", finishSet);
    $("camera-redo-button").addEventListener("click", () => {
      rewardRun++; // stop the last set's reward animation
      setMode("idle");
      startSet();
    });
    $("camera-save-button").addEventListener("click", saveSet);
    $("camera-close-button").addEventListener("click", close);
    // Leaving the app mid-set is when iOS is most likely to close it.
    const keepNow = () => {
      if (running && document.visibilityState === "hidden") writeBackup();
    };
    document.addEventListener("visibilitychange", keepNow);
    window.addEventListener("pagehide", () => running && writeBackup());
    let titleTaps = [];
    $("camera-title").addEventListener("click", () => {
      const now = Date.now();
      titleTaps = titleTaps.filter((tap) => now - tap < 3000).concat(now);
      if (titleTaps.length >= 5) {
        titleTaps = [];
        Debug.set(!Debug.isOn());
        setFeedback("Debug details " + (Debug.isOn() ? "on" : "off"), "");
      }
    });
    $("camera-sound-button").addEventListener("click", () => {
      Sound.setEnabled(!Sound.isEnabled());
      renderSoundButton();
    });
    $("camera-flip-button").addEventListener("click", async () => {
      facing = facing === "user" ? "environment" : "user";
      if (!running) return;
      stopStream();
      try {
        await startStream();
        running = true;
        loop();
      } catch (err) {
        say(tr("Couldn't switch cameras."), true);
      }
    });
  }

  return {
    // options: { onClose, reward, progress: { before, target, hold },
    // backup: { user, day } } - progress fills the live ring; backup keeps
    // the set on this phone until it's saved (see BACKUP_KEY).
    open(key, saveCallback, options = {}) {
      wireButtonsOnce();
      exerciseKey = key;
      exercise = ForjaCounter.EXERCISES[key];
      onSave = saveCallback;
      onClose = options.onClose || null;
      rewardFor = options.reward || null;
      progressFor = options.progress || null;
      backupTag = options.backup || null;
      saved = false;
      rewardRun++;
      result = 0;
      $("camera-title").textContent = tr(exercise.title);
      $("camera-screen").style.setProperty("--set-color", SET_COLORS[exerciseKey]);
      $("camera-tip").innerHTML = tr(exercise.tip);
      $("camera-count-label").textContent = tr(exercise.countLabel);
      $("camera-count").textContent = exercise.kind === "plank" ? "0.0" : "0";
      say("");
      $("camera-live").textContent = "";
      setFeedback("", "");
      renderSoundButton();
      setMode("idle");
      showScreen("camera-screen");
    },

    // The set kept from an app that closed before it was saved:
    // { tag, exercise, value, sentAt? }, or null.
    unsavedSet() {
      const kept = readBackup();
      return kept && { tag: kept.tag, exercise: kept.exercise, value: kept.value, sentAt: kept.sentAt || null };
    },
    dropUnsavedSet() {
      try {
        localStorage.removeItem(BACKUP_KEY);
      } catch (e) {
        // storage blocked
      }
    },
    // Opens the kept set straight on the review screen (Save / Redo), as if
    // it had just been finished. Same options as open().
    recover(saveCallback, options = {}) {
      const kept = readBackup();
      if (!kept) return false;
      wireButtonsOnce();
      exerciseKey = kept.exercise;
      exercise = ForjaCounter.EXERCISES[exerciseKey];
      onSave = saveCallback;
      onClose = options.onClose || null;
      rewardFor = options.reward || null;
      backupTag = kept.tag;
      saved = false;
      attempts = [];
      session = { value: () => kept.value, trace: () => kept.trace };
      result = kept.value;
      $("camera-title").textContent = tr(exercise.title);
      showScreen("camera-screen");
      showReview();
      return true;
    },
  };
})();
