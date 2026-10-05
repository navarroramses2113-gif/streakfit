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

  // t is milliseconds since the set started - the same clock the server
  // replays the recording with.
  function handleFrame(output, t) {
    const landmarks = output.landmarks && output.landmarks[0];
    const side = landmarks ? pickSide(landmarks) : null;

    if (!side) {
      session.push(t, null);
      const overlay = $("camera-overlay");
      overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
      $("camera-state").textContent = exercise.lost;
      $("camera-live").textContent = "";
      return;
    }

    const joints = exercise.needs.map((joint) => [landmarks[side.idx[joint]].x, landmarks[side.idx[joint]].y]);
    const { r, m } = session.push(t, joints);

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
      r.drop === null ? "" : exercise.dropName + " down " + pct(r.drop) + "  ·  " + exercise.anchorName + " moved " + pct(r.anchorMove);

    if (r.event === "rep") {
      setFeedback("Counted - " + exercise.jointName + " " + Math.round(r.lastRep.depth) + "°, " + exercise.dropName + " down " + pct(r.lastRep.drop), "good");
    } else if (r.event === "shallow") {
      setFeedback("Not deep enough (" + Math.round(r.depth) + "°) - go lower", "bad");
    } else if (r.event === "too_fast") {
      setFeedback("Too fast - control the movement", "bad");
    } else if (r.event === "abandoned") {
      setFeedback("Lost tracking mid-rep - not counted. Reset your position.", "bad");
    } else if (r.event && exercise.events[r.event]) {
      setFeedback(exercise.events[r.event](r), "bad");
    }
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
    $("camera-start-button").classList.toggle("hidden", mode !== "idle");
    $("camera-finish-button").classList.toggle("hidden", mode !== "running");
    $("camera-flip-button").classList.toggle("hidden", mode === "review");
    $("camera-review").classList.toggle("hidden", mode !== "review");
    $("camera-close-button").classList.toggle("hidden", mode === "running");
    $("camera-stage").classList.toggle("hidden", mode === "review");
  }

  async function startSet() {
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

    resultUnit = exercise.kind === "plank" ? "s hold" : " verified " + exercise.title.toLowerCase();
    $("camera-result").textContent = result + resultUnit;
    $("camera-save-button").classList.toggle("hidden", result === 0);
    $("camera-save-button").disabled = false;
    $("camera-save-button").textContent = "Save set";
    $("camera-result-note").textContent =
      result === 0
        ? "Nothing was counted. Make sure your whole body is in frame, side-on, and try again."
        : "Only reps with full depth and good form are counted, and the server double-checks every set. Not what you expected? Redo the set - results can't be edited.";
    setMode("review");
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
      button.disabled = false;
      button.textContent = "Try again";
      $("camera-result-note").textContent = (outcome && outcome.error) || "Couldn't verify this set. Check your connection and try again.";
      return;
    }

    if (outcome.value !== result) {
      // The server's recount is the one that counts. Show it instead of
      // quietly saving a different number than the one on screen.
      $("camera-result").textContent = outcome.value + resultUnit;
      $("camera-result-note").textContent = "Saved as " + outcome.value + " - the server's recount of this set is the official number.";
      button.classList.add("hidden");
      return;
    }
    close();
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
      setMode("idle");
      showScreen("camera-screen");
    },
  };
})();
