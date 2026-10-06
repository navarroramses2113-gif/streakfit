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
// })
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
  let setStartMs = 0;
  let lastProcessedMs = -Infinity;
  let onSave = null;
  let currentSideName = null;
  let prevState = "waiting";
  let lastBuzzAt = -Infinity;
  let attempts = [];
  let result = 0;
  let resultUnit = "";

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
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    const video = $("camera-video");
    video.srcObject = stream;
    await video.play();
    $("camera-overlay").width = video.videoWidth;
    $("camera-overlay").height = video.videoHeight;
    $("camera-stage").classList.toggle("mirrored", facing === "user");
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
  // The rejection buzz is also rate-limited: a flurry of fidgeting should
  // never turn into a flurry of buzzing.
  function cue(result) {
    const name = ForjaCounter.soundCue(prevState, result, exercise.kind);
    prevState = result.state;
    if (!name) return;
    if (name === "reject") {
      const now = performance.now();
      if (now - lastBuzzAt < 1500) return;
      lastBuzzAt = now;
    }
    Sound.play(name);
  }

  // What a rep event means in words - used for the live feedback line AND
  // the per-attempt list on the review screen, so a rep that did not count
  // always comes with its reason.
  function describeEvent(r) {
    let kind = "bad", plain = null, detail = null;
    if (r.event === "rep") {
      kind = "good";
      plain = "Counted";
      detail = exercise.jointName + " " + Math.round(r.lastRep.depth) + "\u00b0, " + exercise.dropName + " down " + pct(r.lastRep.drop);
    } else if (r.event === "shallow") {
      plain = "Go lower";
      detail = exercise.jointName + " only reached " + Math.round(r.depth) + "\u00b0";
    } else if (r.event === "too_fast") {
      plain = "Slow down - control the movement";
      detail = "faster than a real rep can be";
    } else if (r.event === "abandoned") {
      plain = "Lost sight of you - that rep didn't count. Reset and go again.";
      detail = "tracking was lost mid-rep";
    } else if (r.event && exercise.events[r.event]) {
      plain = exercise.events[r.event].plain;
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
  }

  // t is milliseconds since the set started - the same clock the server
  // replays the recording with.
  function handleFrame(output, t) {
    const landmarks = output.landmarks && output.landmarks[0];
    const side = landmarks ? pickSide(landmarks) : null;

    if (!side) {
      const lost = session.push(t, null).r;
      cue(lost);
      noteEvent(lost);
      const overlay = $("camera-overlay");
      overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
      $("camera-state").textContent = exercise.lost;
      $("camera-live").textContent = "";
      return;
    }

    const joints = exercise.needs.map((joint) => [landmarks[side.idx[joint]].x, landmarks[side.idx[joint]].y]);
    const { r, m } = session.push(t, joints);
    cue(r);

    if (exercise.kind === "plank") {
      drawBody(landmarks, side, r.state === "holding");
      $("camera-count").textContent = (r.holdMs / 1000).toFixed(1);
      if (r.state === "holding") {
        $("camera-state").textContent = r.reason ? "Holding - fix your form!" : "Holding - keep it straight";
      } else {
        $("camera-state").textContent =
          r.reason === "not_horizontal"
            ? "Get flat - body should be horizontal"
            : r.reason === "hips_sagging_or_piking"
              ? "Straighten your body - hips level with shoulders and ankles"
              : "Get into plank position";
      }
      setFeedback(r.bestMs > 0 ? "Best hold: " + (r.bestMs / 1000).toFixed(1) + "s" : "", r.bestMs > 0 ? "good" : "");
      return;
    }

    drawBody(landmarks, side, r.state !== "down");
    $("camera-count").textContent = r.count;
    // Before counting starts, say exactly what's missing instead of just
    // "get in position" - the start position has several conditions and
    // any one failing looks the same from outside.
    const hint = r.state === "waiting" && exercise.waitingHint ? exercise.waitingHint(m) : null;
    $("camera-state").textContent = hint || exercise.states[r.state] || "";
    $("camera-live").textContent =
      Debug.isOn() && r.drop !== null ? exercise.dropName + " down " + pct(r.drop) + "  ·  " + exercise.anchorName + " moved " + pct(r.anchorMove) : "";

    noteEvent(r);
  }

  function loop() {
    if (!running) return;
    const video = $("camera-video");
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      if (now - lastProcessedMs >= MIN_FRAME_GAP_MS) {
        lastProcessedMs = now;
        const t = Math.round(now - setStartMs);
        handleFrame(poseLandmarker.detectForVideo(video, now), t);
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
    if (mode !== "review") $("camera-title").textContent = exercise.title;
  }

  async function startSet() {
    // Must run in the tap itself, before anything is awaited, or the browser
    // won't let the beeps play later.
    Sound.prime();
    $("camera-start-button").disabled = true;
    setFeedback("", "");
    $("camera-state").textContent = "Loading pose model (first time only)...";
    try {
      await loadModel();
    } catch (err) {
      $("camera-state").textContent = "Couldn't load the camera model - check your connection and try again.";
      $("camera-start-button").disabled = false;
      return;
    }

    $("camera-state").textContent = "Starting camera...";
    try {
      await startStream();
    } catch (err) {
      $("camera-state").textContent =
        err && err.name === "NotAllowedError"
          ? "Camera access was denied. Allow it in your browser settings to log workouts."
          : "Couldn't start the camera on this device.";
      $("camera-start-button").disabled = false;
      return;
    }

    const video = $("camera-video");
    session = ForjaCounter.createSetSession(exerciseKey, video.videoWidth, video.videoHeight);
    currentSideName = null;
    prevState = "waiting";
    lastBuzzAt = -Infinity;
    attempts = [];
    setStartMs = performance.now();
    lastProcessedMs = -Infinity;
    $("camera-count").textContent = exercise.kind === "plank" ? "0.0" : "0";
    $("camera-state").textContent = "Get in position";
    running = true;
    setMode("running");
    $("camera-start-button").disabled = false;
    loop();
  }

  function finishSet() {
    result = session.value();
    stopStream();

    // The finished set gets one message and one number - none of the live
    // coaching text. (The rep-by-rep list is for debug mode only.)
    const counted = result > 0;
    resultUnit = exercise.kind === "plank" ? "s" : "";
    $("camera-title").textContent = counted ? "Nice work!" : "Nothing counted";
    $("camera-result").textContent = result + resultUnit;
    $("camera-result").classList.toggle("hidden", !counted);
    $("camera-result-label").textContent = counted ? (exercise.kind === "plank" ? "plank hold" : "verified " + exercise.title.toLowerCase()) : "";
    $("camera-result-note").textContent = counted ? "" : "Make sure your whole body is in frame, side-on, and try again.";
    $("camera-save-button").classList.toggle("hidden", !counted);
    $("camera-save-button").disabled = false;
    $("camera-save-button").textContent = "Save set";
    $("camera-attempts").classList.toggle("hidden", !Debug.isOn());
    renderAttempts();
    setMode("review");
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
    stopStream();
    showScreen("app-screen");
  }

  async function saveSet() {
    const button = $("camera-save-button");
    button.disabled = true;
    button.textContent = "Verifying...";

    const outcome = await onSave({ exercise: exerciseKey, value: result, trace: session.trace() });

    if (!outcome || !outcome.ok) {
      $("camera-result-note").textContent = (outcome && outcome.error) || "Couldn't verify this set. Check your connection and try again.";
      // A recording the server refused will be refused again - sending it a
      // second time can't help, so point to Redo instead of "Try again".
      // Anything else (no signal, server busy) is worth retrying as-is.
      if (outcome && (outcome.code === "bad_trace" || outcome.code === "implausible")) {
        button.classList.add("hidden");
        $("camera-close-button").classList.remove("hidden");
        return;
      }
      button.disabled = false;
      button.textContent = "Try again";
      return;
    }

    if (outcome.value !== result) {
      // The server's recount is the one that counts. Show it instead of
      // quietly saving a different number than the one on screen.
      $("camera-result").textContent = outcome.value + resultUnit;
      $("camera-result-note").textContent = "Saved. The server's recount is the official number.";
      button.classList.add("hidden");
      $("camera-close-button").classList.remove("hidden");
      return;
    }
    close();
  }

  function renderSoundButton() {
    $("camera-sound-button").textContent = "Sound: " + (Sound.isEnabled() ? "On" : "Off");
  }

  function wireButtonsOnce() {
    if (wireButtonsOnce.done) return;
    wireButtonsOnce.done = true;
    $("camera-start-button").addEventListener("click", startSet);
    $("camera-finish-button").addEventListener("click", finishSet);
    $("camera-redo-button").addEventListener("click", () => {
      setMode("idle");
      startSet();
    });
    $("camera-save-button").addEventListener("click", saveSet);
    $("camera-close-button").addEventListener("click", close);
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
        $("camera-state").textContent = "Couldn't switch cameras.";
      }
    });
  }

  return {
    open(key, saveCallback) {
      wireButtonsOnce();
      exerciseKey = key;
      exercise = ForjaCounter.EXERCISES[key];
      onSave = saveCallback;
      result = 0;
      $("camera-title").textContent = exercise.title;
      $("camera-tip").innerHTML = exercise.tip;
      $("camera-count-label").textContent = exercise.countLabel;
      $("camera-count").textContent = exercise.kind === "plank" ? "0.0" : "0";
      $("camera-state").textContent = "Camera is off";
      $("camera-live").textContent = "";
      setFeedback("", "");
      renderSoundButton();
      setMode("idle");
      showScreen("camera-screen");
    },
  };
})();
