const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const cors = require("cors");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const OpenAI = require("openai");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const UP = path.join(__dirname, "..", "uploads");
const OUT = path.join(__dirname, "..", "outputs");
[UP, OUT].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const upload = multer({ dest: UP, limits: { fileSize: 500 * 1024 * 1024 } });

// in-memory job store (prototype only — swap for a real DB/queue in production)
const jobs = {};

function client(apiKey) {
  return new OpenAI({ apiKey });
}

function fmtSrtTime(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(sec % 60)).padStart(2, "0");
  const ms = String(Math.round((sec % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

function segmentsToSrt(segments) {
  return segments
    .map(
      (s, i) =>
        `${i + 1}\n${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}\n${s.text.trim()}\n`
    )
    .join("\n");
}

// 1) Upload video, extract audio, transcribe with Whisper (word/segment timestamps)
app.post("/api/transcribe", upload.single("video"), async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(400).json({ error: "Thiếu OpenAI API key" });
    if (!req.file) return res.status(400).json({ error: "Thiếu file video" });

    const jobId = uuid();
    const videoPath = req.file.path;
    const audioPath = path.join(UP, `${jobId}.mp3`);

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .save(audioPath)
        .on("end", resolve)
        .on("error", reject);
    });

    const openai = client(apiKey);
    const transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });

    jobs[jobId] = {
      videoPath,
      audioPath,
      segments: transcript.segments.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })),
      sourceLang: transcript.language,
    };

    res.json({ jobId, sourceLang: transcript.language, segments: jobs[jobId].segments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2) Translate segments to target language
app.post("/api/translate", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    const { jobId, targetLang } = req.body;
    const job = jobs[jobId];
    if (!job) return res.status(404).json({ error: "Không tìm thấy job" });

    const openai = client(apiKey);
    const numbered = job.segments.map((s, i) => `${i}: ${s.text}`).join("\n");
    const prompt = `Dịch các câu phụ đề sau sang ${targetLang}. Giữ nguyên số thứ tự, mỗi dòng một câu, không thêm giải thích:\n${numbered}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const lines = completion.choices[0].message.content.trim().split("\n");
    const translated = job.segments.map((s, i) => {
      const line = lines.find((l) => l.startsWith(`${i}:`));
      const text = line ? line.slice(line.indexOf(":") + 1).trim() : s.text;
      return { ...s, text };
    });

    job.translated = translated;
    const srt = segmentsToSrt(translated);
    const srtPath = path.join(OUT, `${jobId}.srt`);
    fs.writeFileSync(srtPath, srt);

    res.json({ jobId, segments: translated, srtUrl: `/api/download/${jobId}/srt` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Clone the original speaker's voice from the extracted audio via ElevenLabs.
// Returns a voice_id that the ElevenLabs TTS endpoint below can speak with.
async function cloneVoice(elKey, audioPath, jobId) {
  const FormData = require("form-data");
  const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
  const form = new FormData();
  form.append("name", `gensub_${jobId}`);
  form.append("files", fs.createReadStream(audioPath));
  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": elKey },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail?.message || "Clone giọng thất bại");
  return data.voice_id;
}

async function elevenSpeech(elKey, voiceId, text) {
  const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": elKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: text || ".",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.85 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || "ElevenLabs TTS lỗi");
  }
  return Buffer.from(await res.arrayBuffer());
}

// 3) Dub: clone the original voice (ElevenLabs) or use a stock OpenAI voice,
// generate per-segment audio, concatenate on the segment timeline, mux with muted video
app.post("/api/dub", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    const elKey = req.headers["x-el-key"];
    const { jobId, voice, engine } = req.body; // engine: "clone" | "openai"
    const job = jobs[jobId];
    if (!job || !job.translated) return res.status(404).json({ error: "Chưa có bản dịch" });

    const useClone = engine === "clone";
    if (useClone && !elKey) return res.status(400).json({ error: "Thiếu ElevenLabs API key" });

    const openai = client(apiKey);
    const clipDir = path.join(UP, `${jobId}_clips`);
    fs.mkdirSync(clipDir, { recursive: true });

    let clonedVoiceId = null;
    if (useClone) {
      clonedVoiceId = await cloneVoice(elKey, job.audioPath, jobId);
    }

    // generate one mp3 per segment
    const clipPaths = [];
    for (let i = 0; i < job.translated.length; i++) {
      const seg = job.translated[i];
      const p = path.join(clipDir, `${i}.mp3`);
      if (useClone) {
        const buf = await elevenSpeech(elKey, clonedVoiceId, seg.text);
        fs.writeFileSync(p, buf);
      } else {
        const speech = await openai.audio.speech.create({
          model: "tts-1",
          voice: voice || "alloy",
          input: seg.text || ".",
        });
        const buf = Buffer.from(await speech.arrayBuffer());
        fs.writeFileSync(p, buf);
      }
      clipPaths.push({ path: p, start: seg.start });
    }

    // build a single audio track, padding silence between clips to respect original timing
    const listFile = path.join(clipDir, "concat.txt");
    let cursor = 0;
    const parts = [];
    for (const c of clipPaths) {
      const gap = Math.max(0, c.start - cursor);
      if (gap > 0.05) {
        const silence = path.join(clipDir, `silence_${parts.length}.mp3`);
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input("anullsrc")
            .inputFormat("lavfi")
            .audioCodec("libmp3lame")
            .duration(gap)
            .save(silence)
            .on("end", resolve)
            .on("error", reject);
        });
        parts.push(silence);
      }
      parts.push(c.path);
      // approximate: advance cursor by clip duration via ffprobe
      const dur = await new Promise((resolve) => {
        ffmpeg.ffprobe(c.path, (err, data) => resolve(err ? 1 : data.format.duration));
      });
      cursor = c.start + dur;
    }
    fs.writeFileSync(listFile, parts.map((p) => `file '${p}'`).join("\n"));

    const mergedAudio = path.join(OUT, `${jobId}_dub.mp3`);
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(["-f concat", "-safe 0"])
        .audioCodec("libmp3lame")
        .save(mergedAudio)
        .on("end", resolve)
        .on("error", reject);
    });

    const dubbedVideo = path.join(OUT, `${jobId}_dubbed.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(job.videoPath)
        .input(mergedAudio)
        .outputOptions(["-map 0:v:0", "-map 1:a:0", "-c:v copy", "-shortest"])
        .save(dubbedVideo)
        .on("end", resolve)
        .on("error", reject);
    });

    res.json({ jobId, videoUrl: `/api/download/${jobId}/video` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download/:jobId/:type", (req, res) => {
  const { jobId, type } = req.params;
  const file =
    type === "srt"
      ? path.join(OUT, `${jobId}.srt`)
      : path.join(OUT, `${jobId}_dubbed.mp4`);
  if (!fs.existsSync(file)) return res.status(404).send("Không tìm thấy file");
  res.download(file);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GenSub app chạy tại http://localhost:${PORT}`));
