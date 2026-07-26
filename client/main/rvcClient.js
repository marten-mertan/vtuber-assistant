// rvcClient.js
// Клиент для RVC-части объединённого voice-сервиса
// (python-services/voice/server.py) — опциональный шаг перекраски тембра
// голоса поверх результата Silero TTS.

class RVCClient {
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

  /**
   * Принимает Buffer с WAV (от Silero), возвращает Buffer с перекрашенным WAV.
   * options позволяет переопределить настройки RVC-сервера ТОЛЬКО для этого
   * запроса (не меняя .env сервера) — удобно для сравнения комбинаций:
   *   { pitch: -8, f0method: "rmvpe", indexRate: 1.0, protect: 0.33 }
   */
  async convert(wavBuffer, options = {}) {
    const params = new URLSearchParams();
    if (options.pitch !== undefined) params.set("pitch", options.pitch);
    if (options.f0method !== undefined) params.set("f0method", options.f0method);
    if (options.indexRate !== undefined) params.set("index_rate", options.indexRate);
    if (options.protect !== undefined) params.set("protect", options.protect);

    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${this.baseUrl}/rvc/convert${query}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wavBuffer,
    });
    if (!res.ok) {
      throw new Error(`RVC сервер вернул ошибку: HTTP ${res.status} ${await res.text()}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

module.exports = { RVCClient };
