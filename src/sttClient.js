// sttClient.js
// Клиент для локального STT-сервиса (python-services/stt/server.py).
// Модель push-to-talk: start() начинает запись с микрофона на стороне
// Python-сервиса, stop() останавливает и возвращает распознанный текст.

export class STTClient {
  constructor({ baseUrl }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
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

  async start() {
    const res = await fetch(`${this.baseUrl}/start`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
  }

  /** Останавливает запись, возвращает { text, duration } */
  async stop() {
    const res = await fetch(`${this.baseUrl}/stop`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }
}
