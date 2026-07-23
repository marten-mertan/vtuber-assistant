// chat.js — консольный REPL для проверки Этапа 1.
// Запуск: npm run chat  (KoboldCPP должен быть уже запущен)

import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { LLMClient } from "./llmClient.js";
import { TTSClient, playWavBuffer } from "./ttsClient.js";
import { RVCClient } from "./rvcClient.js";
import { STTClient } from "./sttClient.js";

const baseUrl = process.env.KOBOLD_URL || "http://localhost:5001";
const temperature = Number(process.env.LLM_TEMPERATURE ?? 0.8);
const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 300);

const ttsUrl = process.env.TTS_URL || "http://localhost:5100";
const ttsSpeaker = process.env.TTS_SPEAKER || "kseniya";
const voiceEnabled = (process.env.VOICE_ENABLED ?? "true") !== "false";

const rvcEnabled = (process.env.RVC_ENABLED ?? "false") === "true";
const rvcUrl = process.env.RVC_URL || "http://localhost:5200";

const sttUrl = process.env.STT_URL || "http://localhost:5300";

const client = new LLMClient({ baseUrl, temperature, maxTokens });
const tts = new TTSClient({ baseUrl: ttsUrl, speaker: ttsSpeaker });
const rvc = new RVCClient({ baseUrl: rvcUrl });
const stt = new STTClient({ baseUrl: sttUrl });

async function main() {
  console.log(`Подключаюсь к KoboldCPP на ${baseUrl} ...`);
  const status = await client.ping();
  if (!status.ok) {
    console.error(`Не удалось подключиться: ${status.error}`);
    console.error("Проверь, что KoboldCPP запущен и модель загружена.");
    process.exit(1);
  }
  console.log(`Подключено. Модель: ${status.model}`);

  if (voiceEnabled) {
    console.log(`Подключаюсь к TTS-серверу на ${ttsUrl} (голос: ${ttsSpeaker}) ...`);
    const ttsStatus = await tts.health();
    if (!ttsStatus.ok) {
      console.warn(`TTS недоступен (${ttsStatus.error}). Продолжаю без голоса.`);
      console.warn("Запусти: python python-services/tts/server.py\n");
    } else {
      console.log(`TTS подключен.\n`);
    }
  }

  if (rvcEnabled) {
    console.log(`Подключаюсь к RVC-серверу на ${rvcUrl} ...`);
    const rvcStatus = await rvc.health();
    if (!rvcStatus.ok) {
      console.warn(`RVC недоступен (${rvcStatus.error}). Голос останется от Silero.`);
      console.warn("Запусти: python python-services/rvc/server.py (см. README)\n");
    } else {
      console.log(`RVC подключен. Модель: ${rvcStatus.model}\n`);
    }
  }

  let sttAvailable = false;
  console.log(`Подключаюсь к STT-серверу на ${sttUrl} ...`);
  const sttStatus = await stt.health();
  if (!sttStatus.ok) {
    console.warn(`STT недоступен (${sttStatus.error}). Голосовой ввод не будет работать.`);
    console.warn("Запусти: python python-services/stt/server.py\n");
  } else {
    sttAvailable = true;
    console.log(`STT подключен. Модель: ${sttStatus.model}\n`);
  }

  console.log(
    'Пиши сообщения, "выход" — завершить, "сброс" — очистить историю, "голос" — сказать вместо печати.\n'
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    const userText = await rl.question("Ты: ");
    if (!userText.trim()) continue;
    if (userText.trim().toLowerCase() === "выход") break;
    if (userText.trim().toLowerCase() === "сброс") {
      client.resetHistory();
      console.log("(история очищена)\n");
      continue;
    }

    let finalUserText = userText;

    if (userText.trim().toLowerCase() === "голос") {
      if (!sttAvailable) {
        console.warn("STT недоступен, голосовой ввод не работает. Проверь STT-сервер.\n");
        continue;
      }
      try {
        await stt.start();
        console.log("🎤 Говори... (нажми Enter, чтобы остановить запись)");
        await rl.question("");
        const { text, warning, duration, process_time } = await stt.stop();
        if (warning) {
          console.warn(`(${warning}${duration !== undefined ? `, запись ${duration.toFixed(1)}с` : ""})\n`);
          continue;
        }
        if (!text) {
          console.warn("(ничего не распознано)\n");
          continue;
        }
        console.log(
          `Распознано (запись ${duration.toFixed(1)}с, обработка ${process_time.toFixed(1)}с): ${text}\n`
        );
        finalUserText = text;
      } catch (err) {
        console.error(`Ошибка записи/распознавания: ${err.message}\n`);
        continue;
      }
    }

    try {
      const t0 = Date.now();
      const { reply, emotion } = await client.send(finalUserText);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`Аи [${emotion}, ${dt}с]: ${reply}`);

      if (voiceEnabled) {
        try {
          const { buffer: sileroBuffer, genTime, speakerUsed } = await tts.synthesize(reply);
          const genLabel = genTime !== null ? `${genTime.toFixed(1)}с` : "?";
          console.log(`  (озвучено голосом "${speakerUsed}" за ${genLabel})`);

          let finalBuffer = sileroBuffer;
          if (rvcEnabled) {
            try {
              const t0 = Date.now();
              finalBuffer = await rvc.convert(sileroBuffer);
              const rvcDt = ((Date.now() - t0) / 1000).toFixed(1);
              console.log(`  (тембр перекрашен RVC за ${rvcDt}с)`);
            } catch (rvcErr) {
              console.warn(`  (RVC-конверсия не удалась, играю оригинал Silero: ${rvcErr.message})`);
            }
          }

          await playWavBuffer(finalBuffer);
        } catch (ttsErr) {
          console.warn(`  (не удалось озвучить: ${ttsErr.message})`);
        }
      }
      console.log("");
    } catch (err) {
      console.error(`Ошибка генерации: ${err.message}\n`);
    }
  }

  rl.close();
  console.log("Пока!");
}

main();
