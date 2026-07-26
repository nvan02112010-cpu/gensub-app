if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

const $ = (id) => document.getElementById(id);

let selectedFile = null;
let currentJobId = null;

function apiKey() {
  return $("apiKey").value.trim();
}
function elKey() {
  return $("elKey").value.trim();
}

$("engine").addEventListener("change", () => {
  const cloning = $("engine").value === "clone";
  $("voice").style.display = cloning ? "none" : "";
  $("engineHint").textContent = cloning
    ? "Nhân bản giọng gốc cần ElevenLabs API key ở trên — kết quả nghe giống người nói thật trong video, đúng hướng GenSubAI làm."
    : "Đọc bằng giọng AI có sẵn, không giữ đặc điểm giọng gốc.";
});
$("engine").dispatchEvent(new Event("change"));

function setStep(n) {
  document.querySelectorAll(".step").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) === n);
  });
}

function renderSegments(container, segments) {
  container.innerHTML = "";
  segments.forEach((s) => {
    const div = document.createElement("div");
    div.className = "segment";
    const mm = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    div.innerHTML = `<time>${mm(s.start)}–${mm(s.end)}</time><span>${s.text}</span>`;
    container.appendChild(div);
  });
}

// --- upload / dropzone ---
const dropzone = $("dropzone");
const videoInput = $("videoInput");

dropzone.addEventListener("click", () => videoInput.click());
["dragover", "dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.toggle("drag", evt === "dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
videoInput.addEventListener("change", (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

function handleFile(f) {
  selectedFile = f;
  $("dropLabel").textContent = f.name;
  $("btnTranscribe").disabled = !apiKey();
}

$("apiKey").addEventListener("input", () => {
  $("btnTranscribe").disabled = !(apiKey() && selectedFile);
});

// --- step 1: transcribe ---
$("btnTranscribe").addEventListener("click", async () => {
  if (!selectedFile || !apiKey()) return;
  $("statusTranscribe").textContent = "Đang trích âm thanh và tạo phụ đề…";
  $("btnTranscribe").disabled = true;

  const form = new FormData();
  form.append("video", selectedFile);

  try {
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "x-api-key": apiKey() },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentJobId = data.jobId;
    $("srcLang").textContent = data.sourceLang;
    renderSegments($("segmentsOriginal"), data.segments);

    $("panel-subs").classList.remove("hidden");
    $("panel-translate").classList.remove("hidden");
    $("statusTranscribe").textContent = `Xong — ${data.segments.length} câu.`;
    setStep(2);
  } catch (err) {
    $("statusTranscribe").textContent = "Lỗi: " + err.message;
  } finally {
    $("btnTranscribe").disabled = false;
  }
});

// --- step 2: translate ---
$("btnTranslate").addEventListener("click", async () => {
  if (!currentJobId) return;
  $("statusTranslate").textContent = "Đang dịch…";
  $("btnTranslate").disabled = true;

  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey() },
      body: JSON.stringify({ jobId: currentJobId, targetLang: $("targetLang").value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    renderSegments($("segmentsTranslated"), data.segments);
    $("downloadSrt").href = data.srtUrl;
    $("downloadSrt").classList.remove("hidden");
    $("panel-dub").classList.remove("hidden");
    $("statusTranslate").textContent = "Đã dịch xong.";
    setStep(3);
  } catch (err) {
    $("statusTranslate").textContent = "Lỗi: " + err.message;
  } finally {
    $("btnTranslate").disabled = false;
  }
});

// --- step 3: dub ---
$("btnDub").addEventListener("click", async () => {
  if (!currentJobId) return;
  const engine = $("engine").value;
  if (engine === "clone" && !elKey()) {
    $("statusDub").textContent = "Cần nhập ElevenLabs API key để nhân bản giọng gốc.";
    return;
  }
  $("statusDub").textContent =
    engine === "clone"
      ? "Đang nhân bản giọng gốc và tạo lời đọc (có thể mất vài phút)…"
      : "Đang tạo giọng đọc và ghép video (có thể mất vài phút)…";
  $("btnDub").disabled = true;

  try {
    const res = await fetch("/api/dub", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey(),
        "x-el-key": elKey(),
      },
      body: JSON.stringify({ jobId: currentJobId, voice: $("voice").value, engine }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    $("resultVideo").src = data.videoUrl;
    $("resultVideo").classList.remove("hidden");
    $("downloadVideo").href = data.videoUrl;
    $("downloadVideo").classList.remove("hidden");
    $("statusDub").textContent = "Xong!";
    setStep(4);
  } catch (err) {
    $("statusDub").textContent = "Lỗi: " + err.message;
  } finally {
    $("btnDub").disabled = false;
  }
});
