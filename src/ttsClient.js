// ttsClient.js
// Клиент для локального Silero TTS-сервиса (python-services/tts/server.py)
// и проигрывание полученного WAV средствами Windows (PowerShell SoundPlayer) —
// без сторонних npm-пакетов, которые могут не собраться на Windows.

import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export class TTSClient {
  constructor({ baseUrl, speaker }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.speaker = speaker;
  }

  async health() {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Синтезирует речь, возвращает { buffer, genTime } */
  async synthesize(text, speaker = this.speaker) {
    const res = await fetch(`${this.baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, speaker }),
    });
    if (!res.ok) {
      throw new Error(`TTS сервер вернул ошибку: HTTP ${res.status} ${await res.text()}`);
    }
    const genTime = res.headers.get("X-Gen-Time");
    const speakerUsed = res.headers.get("X-Speaker-Used");
    const arrayBuffer = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      genTime: genTime ? Number(genTime) : null,
      speakerUsed,
    };
  }
}

/** Проигрывает WAV-буфер синхронно (ждёт окончания воспроизведения) */
export async function playWavBuffer(buffer) {
  const dir = await mkdtemp(path.join(tmpdir(), "vtuber-tts-"));
  const filePath = path.join(dir, "reply.wav");
  await writeFile(filePath, buffer);

  try {
    await new Promise((resolve, reject) => {
      const ps = spawn("powershell", [
        "-NoProfile",
        "-Command",
        `(New-Object Media.SoundPlayer '${filePath}').PlaySync();`,
      ]);
      ps.on("error", reject);
      ps.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`PowerShell завершился с кодом ${code}`))
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
