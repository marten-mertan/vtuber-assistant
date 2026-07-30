// llmClient.js
// Модуль общения с локальным KoboldCPP через его OpenAI-совместимый API
// (/v1/chat/completions). Отвечает за:
//  - системный промпт (персону)
//  - формат ответа: "emotion|текст" (GBNF-грамматика)

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

// GBNF-грамматика вместо JSON Schema. 
// Формат "emotion|текст"
const emotionAlternatives = EMOTIONS.map((e) => JSON.stringify(e)).join(" | ");
const TAG_GRAMMAR = `root ::= emotion "|" text
emotion ::= ${emotionAlternatives}
text ::= [^|<]+
`;

const SYSTEM_PROMPT = `Ты — виртуальный ассистент-вьюбер по имени Аи. У тебя дружелюбный,
слегка озорной характер, ты искренне интересуешься собеседником и общаешься на русском языке.

Отвечай КРАТКО — обычно 1-2 предложения, максимум 3. Это живой разговор,
а не монолог: короткие реплики звучат естественнее и быстрее озвучиваются.

Формат ответа СТРОГО такой, без пояснений и текста до/после:
emotion|текст ответа

Где emotion — одна из: ${EMOTIONS.join(", ")}. Сразу после "|" идёт текст
ответа, без пробела, без кавычек. Никаких дополнительных тегов, скобок
или пометок вокруг текста не добавляй.`;

/**
 * Возвращает завершённые предложения из накопленного буфера и остаток
 * без завершающей пунктуации (ещё может дополниться следующими токенами).
 * Режем ТОЛЬКО по .!? — но группой (чтобы не резать "..." или "?!" на
 * части), и только если после группы уже виден НЕ-пунктуационный символ
 * (иначе не знаем, не продолжится ли пунктуация следующим токеном).
 */
function splitCompleteSentences(buffer) {
  const re = /[.!?]+(?![.!?])/g;
  let match;
  let lastCut = -1;
  while ((match = re.exec(buffer)) !== null) {
    const endIdx = match.index + match[0].length;
    if (endIdx === buffer.length) break; // конец группы совпал с концом буфера — не уверены, что она завершена
    lastCut = endIdx;
  }
  if (lastCut === -1) return { complete: [], rest: buffer };

  const completeText = buffer.slice(0, lastCut);
  const rest = buffer.slice(lastCut);

  const sentences = [];
  let start = 0;
  const re2 = /[.!?]+(?![.!?])/g;
  let m2;
  while ((m2 = re2.exec(completeText)) !== null) {
    const end = m2.index + m2[0].length;
    const s = completeText.slice(start, end).trim();
    if (s) sentences.push(s);
    start = end;
  }
  return { complete: sentences, rest };
}

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

  /** Разбирает "emotion|текст" -> { reply, emotion } */
  _parseTagFormat(text) {
    const trimmed = text.trim();
    const match = trimmed.match(/^([a-z]+)\|([\s\S]*)$/);
    if (!match) {
      // Модель не выдала разделитель (не должно происходить при
      // grammar-constraint, но не роняем пайплайн, если вдруг) — отдаём
      // как есть, нейтрально.
      return { reply: trimmed, emotion: "neutral" };
    }
    const [, tag, body] = match;
    const emotion = EMOTIONS.includes(tag) ? tag : "neutral";
    return { reply: body.trim(), emotion };
  }

  /**
   * Формирует content для сообщения — обычная строка, либо (если передан
   * imageBase64) multipart-массив в формате OpenAI Vision API:
   * [{type: "text", ...}, {type: "image_url", image_url: {url: "data:..."}}]
   */
  _buildContent(userText, imageBase64) {
    if (!imageBase64) return userText;
    return [
      { type: "text", text: userText },
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
    ];
  }

  /**
   * Обычная (не потоковая) генерация — используется консольным
   * fallback (chat.js). Возвращает { reply, emotion, raw }.
   * imageBase64 — опционально, PNG-скриншот без префикса data URI.
   */
  async send(userText, { imageBase64 } = {}) {
    const userMessage = { role: "user", content: this._buildContent(userText, imageBase64) };
    this.history.push(userMessage);

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: this.history,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        grammar: TAG_GRAMMAR,
      }),
    });

    if (!res.ok) {
      throw new Error(`KoboldCPP вернул ошибку: HTTP ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const rawContent = data?.choices?.[0]?.message?.content ?? "";
    const parsed = this._parseTagFormat(rawContent);

    this.history.push({ role: "assistant", content: parsed.reply });

    if (imageBase64) {
      this._scheduleImageMemory(userMessage, imageBase64, userText);
    }

    return { ...parsed, raw: rawContent };
  }

  /**
   * Потоковая генерация через SSE. Коллбэки вызываются по мере готовности:
   *   onEmotion(emotion) — один раз, как только распознан тег в начале ответа
   *   onSentence(sentenceText) — на каждое завершённое предложение
   *   imageBase64 — опционально, PNG-скриншот без префикса data URI.
   * Возвращает { reply, emotion } с полным текстом после завершения потока.
   */
  async sendStream(userText, { onEmotion, onSentence, imageBase64 } = {}) {
    const userMessage = { role: "user", content: this._buildContent(userText, imageBase64) };
    this.history.push(userMessage);

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: this.history,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        grammar: TAG_GRAMMAR,
        stream: true,
      }),
    });

    if (!res.ok) {
      throw new Error(`KoboldCPP вернул ошибку: HTTP ${res.status} ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let sseBuffer = "";
    let rawText = "";
    let emotion = null;
    let awaitingEmotion = true;
    let sentenceBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop(); // неполная последняя строка — ждём продолжения

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // неполный/битый JSON-чанк — пропускаем
        }
        const delta = json?.choices?.[0]?.delta?.content;
        if (!delta) continue;

        rawText += delta;

        if (awaitingEmotion) {
          const sepIdx = rawText.indexOf("|");
          if (sepIdx === -1) continue; // emotion ещё не набрался полностью
          const tag = rawText.slice(0, sepIdx);
          emotion = EMOTIONS.includes(tag) ? tag : "neutral";
          onEmotion?.(emotion);
          sentenceBuffer = rawText.slice(sepIdx + 1);
          awaitingEmotion = false;
          continue;
        }

        sentenceBuffer += delta;
        const { complete, rest } = splitCompleteSentences(sentenceBuffer);
        for (const s of complete) onSentence?.(s);
        sentenceBuffer = rest;
      }
    }

    // Хвост без завершающей пунктуации — модель могла упереться в
    // max_tokens или просто не закончить знаком препинания.
    const tail = sentenceBuffer.trim();
    if (tail) onSentence?.(tail);

    const sepIdx = rawText.indexOf("|");
    const fullReply = (sepIdx === -1 ? rawText : rawText.slice(sepIdx + 1)).trim();
    const finalEmotion = emotion || "neutral";

    this.history.push({ role: "assistant", content: fullReply });

    if (imageBase64) {
      this._scheduleImageMemory(userMessage, imageBase64, userText);
    }

    return { reply: fullReply, emotion: finalEmotion };
  }

  /**
   * Фоново (НЕ блокируя основной ответ — не await'им это в send/sendStream)
   * просит модель детально описать картинку отдельным изолированным
   * запросом (не через this.history, чтобы не засорять основной диалог),
   * затем заменяет content уже отправленного сообщения в истории на это
   * текстовое описание.
   *
   * Зачем: если оставить картинку в истории как есть, KoboldCPP будет
   * заново ПЕРЕКОДИРОВАТЬ её на каждый следующий запрос (даже никак не
   * связанный со скриншотом) — на практике это добавляет секунды на
   * каждое сообщение, и они множатся с числом сделанных скриншотов за
   * сессию. Текстовое описание почти ничего не стоит на последующих
   * запросах, а содержание картинки в памяти диалога остаётся.
   */
  _scheduleImageMemory(userMessage, imageBase64, originalUserText) {
    this._summarizeImage(imageBase64, originalUserText)
      .then((summary) => {
        userMessage.content = `[Скриншот] ${originalUserText}\n(На картинке: ${summary})`;
      })
      .catch((err) => {
        console.warn(`[llmClient] Не удалось сделать vision-память для скриншота: ${err.message}`);
        // Content НЕ трогаем при ошибке — картинка остаётся в истории как
        // есть (будет перекодирована ещё раз, но хотя бы не потеряется).
      });
  }

  /** Изолированный запрос на подробное описание картинки — без grammar, без стрима, не трогает this.history. */
  async _summarizeImage(imageBase64, originalUserText) {
    const prompt =
      `Подробно опиши, что изображено на этом скриншоте — это будет использовано ` +
      `как память на будущее в разговоре. Контекст, зачем его показали: "${originalUserText}". ` +
      `Пиши сплошным текстом без форматирования, 3-5 предложений, только суть увиденного.`;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: this._buildContent(prompt, imageBase64) }],
        temperature: 0.3,
        max_tokens: 300,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return text.trim();
  }

  resetHistory() {
    this.history = [{ role: "system", content: SYSTEM_PROMPT }];
  }
}

module.exports = { LLMClient, EMOTIONS };