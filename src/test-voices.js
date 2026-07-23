// test-voices.js — диагностика: полная сетка "голос Silero x питч RVC",
// чтобы разом сравнить, какой пресет-источник конвертируется чище и на
// каком питче.
//
// Не часть основного пайплайна — разовый инструмент для сравнения.
// Запуск: node src/test-voices.js
// Результат: набор .wav файлов в test-output/, с именами вида
// kseniya_pitch-8.wav — можно открыть папку и прослушать всё подряд.
//
// Сервер RVC перезапускать НЕ нужно — питч передаётся отдельным
// параметром на каждый запрос, .env сервера не трогается.

import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { TTSClient } from "./ttsClient.js";
import { RVCClient } from "./rvcClient.js";

const ttsUrl = process.env.TTS_URL || "http://localhost:5100";
const rvcUrl = process.env.RVC_URL || "http://localhost:5200";

// Фраза одна и та же для всех комбинаций — так сравнение честное
const TEST_PHRASE = "Привет! Меня зовут Аи, и сегодня отличная погода для прогулки.";

// Пресеты Silero для сравнения
const SPEAKERS = ["kseniya", "xenia", "baya", "aidar", "eugene"];

// Сетка питчей в полутонах (0 = без сдвига, ±12 = октава)
const PITCHES = [-12, -8, -4, 0, 4, 8, 12];

const OUTPUT_DIR = path.resolve("test-output");

function pitchLabel(p) {
  return p >= 0 ? `+${p}` : `${p}`;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const tts = new TTSClient({ baseUrl: ttsUrl });
  const rvc = new RVCClient({ baseUrl: rvcUrl });

  const rvcHealth = await rvc.health();
  if (!rvcHealth.ok) {
    console.error(`RVC-сервер недоступен: ${rvcHealth.error}`);
    console.error("Запусти python-services/rvc/server.py и повтори.");
    process.exit(1);
  }
  console.log(`RVC-модель: ${rvcHealth.model}`);
  console.log(`Голосов: ${SPEAKERS.length}, питчей: ${PITCHES.length} — всего ${SPEAKERS.length * PITCHES.length} комбинаций RVC + ${SPEAKERS.length} исходников Silero\n`);

  let done = 0;
  const total = SPEAKERS.length * PITCHES.length;

  for (const speaker of SPEAKERS) {
    process.stdout.write(`${speaker}: синтез Silero... `);
    let sileroBuffer;
    try {
      const result = await tts.synthesize(TEST_PHRASE, speaker);
      sileroBuffer = result.buffer;
    } catch (err) {
      console.log(`ОШИБКА синтеза: ${err.message}`);
      continue;
    }
    console.log("ок");

    const sileroPath = path.join(OUTPUT_DIR, `${speaker}_00_original.wav`);
    await writeFile(sileroPath, sileroBuffer);

    for (const pitch of PITCHES) {
      const label = pitchLabel(pitch);
      process.stdout.write(`  ${speaker} pitch=${label} ... `);
      try {
        const rvcBuffer = await rvc.convert(sileroBuffer, { pitch });
        const rvcPath = path.join(OUTPUT_DIR, `${speaker}_pitch${label}.wav`);
        await writeFile(rvcPath, rvcBuffer);
        done++;
        console.log(`ок (${done}/${total})`);
      } catch (err) {
        console.log(`ОШИБКА: ${err.message}`);
      }
    }
  }

  console.log(`\nГотово. Всё сохранено в ${OUTPUT_DIR}`);
  console.log("Для каждого голоса:");
  console.log("  *_00_original.wav — что выдал Silero ДО конверсии");
  console.log("  *_pitch<N>.wav — результат RVC на разных сдвигах питча");
  console.log("\nСовет: слушай по одному голосу за раз (все его *_pitch*.wav подряд),");
  console.log("так проще услышать, на каком питче конкретно этот источник звучит чище всего.");
}

main();
