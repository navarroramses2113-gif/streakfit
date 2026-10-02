// The in-app camera screen: records one verified set of an exercise and
// hands the result back. All the "is this a real rep" logic lives in
// exercise-counter.js; this file is just the camera, the pose model and
// the on-screen feedback around it. Nothing here ever uploads video - the
// pose model runs on the device and only the resulting count is kept.
//
// Usage: ForjaCamera.open("pushup", (result) => { ...save it... })
//   result is a whole number: reps counted, or seconds for a plank.
const ForjaCamera = (function () {
  const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs";
  const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

  // MediaPipe pose landmark indexes for each side of the body.
  const JOINTS = {
    left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
    right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
  };

  const $ = (id) => document.getElementById(id);

  let poseLandmarker = null;
  let modelLoading = null;
  let stream = null;
  let running = false;
  let facing = "user";
  let lastVideoTime = -1;
  let exercise = null;
  let engine = null;
  let onSave = null;
  let currentSideName = null;
  let result = 0;

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

  function handleFrame(output, nowMs) {
    const landmarks = output.landmarks && output.landmarks[0];
    const side = landmarks ? pickSide(landmarks) : null;

    if (!side) {
      engine.update(null, nowMs);
      const overlay = $("camera-overlay");
      overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
      $("camera-state").textContent = exercise.lost;
      return;
    }

    const w = $("camera-overlay").width;
    const h = $("camera-overlay").height;
    const pt = (joint) => ({ x: landmarks[side.idx[joint]].x * w, y: landmarks[side.idx[joint]].y * h });
    const m = exercise.measure(pt);

    if (exercise.kind === "plank") {
      const r = engine.update(m.sample, nowMs);
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

    const r = engine.update(m.angle, nowMs, m.extra);
    drawBody(landmarks, side, r.state !== "down");
    $("camera-count").textContent = r.count;
    $("camera-state").textContent = exercise.states[r.state] || "";

    if (r.event === "rep") {
      setFeedback("Counted - depth " + Math.round(r.lastRep.depth) + "°", "good");
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
      handleFrame(poseLandmarker.detectForVideo(video, now), now);
    }
    requestAnimationFrame(loop);
  }

  // Which of the screen's three modes is showing: "idle" (before the set),
  // "running" (counting) or "review" (set finished, decide whether to keep).
  function setMode(mode) {
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

    engine = exercise.create(exercise.sliders.map((s) => s.value));
    currentSideName = null;
    $("camera-count").textContent = exercise.kind === "plank" ? "0.0" : "0";
    $("camera-state").textContent = "Get in position";
    running = true;
    setMode("running");
    $("camera-start-button").disabled = false;
    loop();
  }

  function finishSet() {
    const now = performance.now();
    if (exercise.kind === "plank") {
      result = Math.floor(engine.finish(now).bestMs / 1000);
    } else {
      result = engine.reps.length;
    }
    stopStream();

    const unit = exercise.kind === "plank" ? "s hold" : " verified " + exercise.title.toLowerCase();
    $("camera-result").textContent = result + unit;
    $("camera-save-button").classList.toggle("hidden", result === 0);
    $("camera-result-note").textContent =
      result === 0
        ? "Nothing was counted. Make sure your whole body is in frame, side-on, and try again."
        : "Only reps with full depth and good form are counted. Not what you expected? Redo the set - results can't be edited.";
    setMode("review");
  }

  function close() {
    stopStream();
    showScreen("app-screen");
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
    $("camera-save-button").addEventListener("click", () => {
      const value = result;
      const callback = onSave;
      close();
      if (callback) callback(value);
    });
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
    open(exerciseKey, saveCallback) {
      wireButtonsOnce();
      exercise = ForjaCounter.EXERCISES[exerciseKey];
      onSave = saveCallback;
      result = 0;
      $("camera-title").textContent = exercise.title;
      $("camera-tip").innerHTML = exercise.tip;
      $("camera-count-label").textContent = exercise.countLabel;
      $("camera-count").textContent = exercise.kind === "plank" ? "0.0" : "0";
      $("camera-state").textContent = "Camera is off";
      setFeedback("", "");
      setMode("idle");
      showScreen("camera-screen");
    },
  };
})();
