// llmClient.js
// Модуль общения с локальным KoboldCPP через его OpenAI-совместимый API
// (/v1/chat/completions). Отвечает за:
//  - системный промпт (персону)
//  - формат ответа (JSON: reply + emotion)
//  - устойчивый парсинг ответа модели (локальные модели иногда
//    оборачивают JSON в markdown, добавляют лишний текст и т.п.)

const EMOTIONS = [
  "neutral",
  "happy",
  "excited",
  "sad",
  "angry",
  "surprised",
  "confused",
  "embarrassed",
  "thinking",
  "confident",
  "anxious",
  "disappointed",
];

// JSON Schema, которую KoboldCPP (начиная с v1.90.2) использует для
// grammar-constrained генерации: модель физически не может выдать ничего,
// кроме объекта такой формы — никакого текста до/после, никаких лишних полей.
// Требует поле "grammar" в теле запроса к /v1/chat/completions (см. send()).
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    emotion: { type: "string", enum: EMOTIONS },
  },
  required: ["reply", "emotion"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `Ты — виртуальный ассистент-вьюбер по имени Аи. У тебя дружелюбный,
слегка озорной характер, ты искренне интересуешься собеседником и общаешься на русском языке.

Отвечай КРАТКО — обычно 1-2 предложения, максимум 3. Это живой разговор,
а не монолог: короткие реплики звучат естественнее и быстрее озвучиваются.

Ты отвечаешь только в поле "reply", а поле "emotion" выбирай исходя из смысла
своей реплики и настроения диалога.`;

class LLMClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - адрес KoboldCPP, например http://localhost:5001
   * @param {number} [opts.temperature]
   * @param {number} [opts.maxTokens]
   */
  constructor({ baseUrl, temperature = 0.8, maxTokens = 300 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.history = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  /** Проверка доступности KoboldCPP */
  async ping() {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/model`);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return { ok: true, model: data?.result ?? "unknown" };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Отправляет реплику пользователя, возвращает { reply, emotion, raw }
   * @param {string} userText
   */
  async send(userText) {
    this.history.push({ role: "user", content: userText });

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: this.history,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        grammar: JSON.stringify(RESPONSE_SCHEMA),
      }),
    });

    if (!res.ok) {
      throw new Error(`KoboldCPP вернул ошибку: HTTP ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const rawContent = data?.choices?.[0]?.message?.content ?? "";

    const parsed = this._parseModelOutput(rawContent);

    // Сохраняем в историю уже "чистую" реплику, а не сырой JSON —
    // иначе модель со временем начнёт путаться и генерировать JSON внутри JSON
    this.history.push({ role: "assistant", content: parsed.reply });

    return { ...parsed, raw: rawContent };
  }

  /** Устойчивый парсинг: достаёт JSON даже если модель что-то добавила вокруг */
  _parseModelOutput(text) {
    const cleaned = text.trim().replace(/^```json\s*|^```\s*|```$/gim, "");

    let jsonStr = cleaned;
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
    }

    try {
      const obj = JSON.parse(jsonStr);
      const emotion = EMOTIONS.includes(obj.emotion) ? obj.emotion : "neutral";
      const reply = typeof obj.reply === "string" ? obj.reply : cleaned;
      return { reply, emotion };
    } catch {
      // Модель не выдала валидный JSON — не роняем пайплайн,
      // отдаём сырой текст с нейтральной эмоцией
      return { reply: cleaned, emotion: "neutral" };
    }
  }

  resetHistory() {
    this.history = [{ role: "system", content: SYSTEM_PROMPT }];
  }
}

module.exports = { LLMClient, EMOTIONS };