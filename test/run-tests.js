import fs from 'node:fs';
import path from 'node:path';
import { analyzeAudioFile, printTerminalReport } from '../src/index.js';

const sampleRate = 44100;

/**
 * Sintetiza una bateria realista:
 * - Downbeat (Tiempo 1 del compas): Kick profundo (60Hz->180Hz sweep) + Crash/Chord
 * - Otros tiempos del compas: Snare / Hi-hat con acento secundario en mitad de compas
 * - Subdivision de corcheas suaves (hi-hat cerrado)
 */
function synthesizeRhythmTrack(sections, totalSeconds) {
  const numSamples = Math.ceil(totalSeconds * sampleRate);
  const samples = new Float32Array(numSamples);

  for (const sec of sections) {
    const periodSec = 60.0 / sec.bpm;
    const meter = sec.meter || 4;
    let beatIdx = 0;

    for (let t = sec.offsetMs / 1000.0; t < sec.endSec - 0.05; t += periodSec) {
      const posInBar = beatIdx % meter;
      const startSample = Math.round(t * sampleRate);

      if (posInBar === 0) {
        addKick(samples, startSample, 1.0);
        addBassNote(samples, startSample, 110.0, periodSec * 0.85, 0.45);
        addHiHat(samples, startSample, 0.35);
      } else if ((meter === 4 && posInBar === 2) || (meter === 6 && posInBar === 3)) {
        addSnare(samples, startSample, 0.65);
        addHiHat(samples, startSample, 0.25);
      } else {
        addSnare(samples, startSample, 0.38);
        addHiHat(samples, startSample, 0.2);
      }

      const halfBeatSample = Math.round((t + periodSec * 0.5) * sampleRate);
      if (halfBeatSample < numSamples) {
        addHiHat(samples, halfBeatSample, 0.12);
      }

      beatIdx++;
    }
  }

  return samples;
}

function addKick(buf, startIdx, amp) {
  const dur = Math.floor(0.14 * sampleRate);
  let phase = 0;
  for (let i = 0; i < dur && startIdx + i < buf.length; i++) {
    const t = i / sampleRate;
    const freq = 52 + 135 * Math.exp(-t * 45);
    phase += (2 * Math.PI * freq) / sampleRate;
    const env = Math.exp(-t * 22);
    buf[startIdx + i] += amp * env * Math.sin(phase);
  }
}

function addBassNote(buf, startIdx, freq, durSec, amp) {
  const dur = Math.floor(durSec * sampleRate);
  for (let i = 0; i < dur && startIdx + i < buf.length; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1.0, t / 0.004);
    const decay = Math.exp(-t * 6.5);
    buf[startIdx + i] += amp * attack * decay * (Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(4 * Math.PI * freq * t));
  }
}

function addSnare(buf, startIdx, amp) {
  const dur = Math.floor(0.1 * sampleRate);
  for (let i = 0; i < dur && startIdx + i < buf.length; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 32);
    const noise = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    const fracNoise = (noise - Math.floor(noise)) * 2 - 1;
    const body = Math.sin(2 * Math.PI * 210 * t);
    buf[startIdx + i] += amp * env * (0.55 * body + 0.45 * fracNoise);
  }
}

function addHiHat(buf, startIdx, amp) {
  const dur = Math.floor(0.045 * sampleRate);
  for (let i = 0; i < dur && startIdx + i < buf.length; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 65);
    const carrier = Math.sin(2 * Math.PI * 6200 * t) + Math.sin(2 * Math.PI * 8700 * t);
    buf[startIdx + i] += amp * env * carrier * 0.5;
  }
}

function writeWavFile(filePath, samples, sr = 44100) {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sr, 24);
  buffer.writeUInt32LE(sr * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  fs.writeFileSync(filePath, buffer);
}

async function runTests() {
  const tmpDir = path.resolve('test/fixtures');
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log('Generando pistas de prueba para osu! (Lineal, Vals 3/4, Multi-BPM y Reset de Fase/Compas)...\n');

  // Test 1: Cancion lineal a 174 BPM, Offset 420 ms, Compas 4/4
  const track1Path = path.join(tmpDir, 'test1_linear_174bpm_4_4.wav');
  const samples1 = synthesizeRhythmTrack(
    [{ offsetMs: 420, endSec: 20.0, bpm: 174, meter: 4 }],
    20.5
  );
  writeWavFile(track1Path, samples1);
  const res1 = await analyzeAudioFile(track1Path);
  printTerminalReport(track1Path, res1);

  // Test 2: Cancion de vals/anime en 3/4 a 150 BPM, Offset 350 ms
  const track2Path = path.join(tmpDir, 'test2_waltz_150bpm_3_4.wav');
  const samples2 = synthesizeRhythmTrack(
    [{ offsetMs: 350, endSec: 20.0, bpm: 150, meter: 3 }],
    20.5
  );
  writeWavFile(track2Path, samples2);
  const res2 = await analyzeAudioFile(track2Path);
  printTerminalReport(track2Path, res2);

  // Test 3: Cancion NO LINEAL con cambio de BPM y cambio de Compas (130 BPM 4/4 -> 180 BPM 3/4)
  const transitionMs = Math.round(300 + 32 * (60000 / 130)); // 15069 ms
  const track3Path = path.join(tmpDir, 'test3_nonlinear_130_to_180bpm.wav');
  const samples3 = synthesizeRhythmTrack(
    [
      { offsetMs: 300, endSec: transitionMs / 1000.0, bpm: 130, meter: 4 },
      { offsetMs: transitionMs, endSec: 32.0, bpm: 180, meter: 3 }
    ],
    32.5
  );
  writeWavFile(track3Path, samples3);
  const res3 = await analyzeAudioFile(track3Path);
  printTerminalReport(track3Path, res3);

  // Test 4: Cancion con MISMO BPM (160 BPM) pero un corte/compas incompleto que desfasa medio beat (+187.5ms) en t=12.25s
  const beat160Ms = 60000 / 160; // 375 ms
  const sec1EndMs = 250 + 32 * beat160Ms; // 12250 ms
  const sec2StartMs = Math.round(sec1EndMs + beat160Ms * 0.5); // 12438 ms (desfase de medio beat)
  const track4Path = path.join(tmpDir, 'test4_phase_reset_160bpm.wav');
  const samples4 = synthesizeRhythmTrack(
    [
      { offsetMs: 250, endSec: sec1EndMs / 1000.0, bpm: 160, meter: 4 },
      { offsetMs: sec2StartMs, endSec: 26.0, bpm: 160, meter: 4 }
    ],
    26.5
  );
  writeWavFile(track4Path, samples4);
  const res4 = await analyzeAudioFile(track4Path);
  printTerminalReport(track4Path, res4);

  // Test 5: Cancion constante a 231 BPM que tiene un puente corto con acentos en tresillo de blanca (154 BPM = 2/3 de 231)
  // Todos los golpes caen sobre la misma rejilla maestra de 231 BPM (272ms + N * 60000/231)
  const beat231Ms = 60000 / 231;
  const bridgeStartMs = 272 + 72 * beat231Ms; // compas 19 exacto
  const bridgeEndMs = bridgeStartMs + 24 * beat231Ms; // 6 compases de 231 BPM (= 4 compases de 3/4 a 154 BPM)
  const track5Path = path.join(tmpDir, 'test5_231bpm_with_154_polyrhythm_bridge.wav');
  const samples5 = synthesizeRhythmTrack(
    [
      { offsetMs: 272, endSec: bridgeStartMs / 1000.0, bpm: 231, meter: 4 },
      { offsetMs: bridgeStartMs, endSec: bridgeEndMs / 1000.0, bpm: 154, meter: 3 },
      { offsetMs: bridgeEndMs, endSec: 42.0, bpm: 231, meter: 4 }
    ],
    42.5
  );
  writeWavFile(track5Path, samples5);
  const res5 = await analyzeAudioFile(track5Path);
  printTerminalReport(track5Path, res5);

  // Test 6: Forzar BPM manualmente (--bpm 154) y comprobar que recalcula el offset perfecto para ese BPM
  const res6 = await analyzeAudioFile(track5Path, { targetBpm: 154 });
  printTerminalReport(track5Path, res6);

  // Test 7: Doblar BPM (--double)
  const res7 = await analyzeAudioFile(track1Path, { doubleBpm: true });
  printTerminalReport(track1Path, res7);

  // Test 8: Cancion con intro larga sin ritmo (12 segundos ambiental) y drop real a 170 BPM en t=12.0s
  // Debe retro-proyectar el compas hacia atras para que la linea roja inicie cerca de 0s y calce exacto con el drop
  const beat170Ms = 60000 / 170; // 352.94 ms
  const dropMs = 12000;
  const track8Path = path.join(tmpDir, 'test8_ambient_intro_12s_drop_170bpm.wav');
  const samples8 = synthesizeRhythmTrack(
    [
      { offsetMs: dropMs, endSec: 32.0, bpm: 170, meter: 4 }
    ],
    32.5
  );
  writeWavFile(track8Path, samples8);
  const res8 = await analyzeAudioFile(track8Path, { startAt: 12.0 });
  printTerminalReport(track8Path, res8);

  // Verificaciones
  let allPassed = true;
  const assert = (cond, msg) => {
    if (cond) {
      console.log(`[PASS] ${msg}`);
    } else {
      console.error(`[FAIL] ${msg}`);
      allPassed = false;
    }
  };

  console.log('\n═══ RESULTADOS DE VALIDACION ═══');
  assert(Math.abs(res1.primaryBpm - 174) <= 0.5, `Test 1 BPM detectado: ${res1.primaryBpm} (esperado: 174)`);
  assert(Math.abs(res1.initialOffsetMs - 420) <= 10, `Test 1 Offset detectado: ${res1.initialOffsetMs}ms (esperado: ~420ms)`);
  assert(res1.primaryMeter === '4/4', `Test 1 Compas detectado: ${res1.primaryMeter} (esperado: 4/4)`);

  assert(Math.abs(res2.primaryBpm - 150) <= 0.5, `Test 2 BPM detectado: ${res2.primaryBpm} (esperado: 150)`);
  assert(Math.abs(res2.initialOffsetMs - 350) <= 10, `Test 2 Offset detectado: ${res2.initialOffsetMs}ms (esperado: ~350ms)`);
  assert(res2.primaryMeter === '3/4', `Test 2 Compas detectado: ${res2.primaryMeter} (esperado: 3/4)`);

  assert(res3.isVariableBpm === true && res3.timingPoints.length >= 2, `Test 3 Detecto BPM variable (${res3.timingPoints.length} secciones)`);
  if (res3.timingPoints.length >= 2) {
    const tp1 = res3.timingPoints[0];
    const tp2 = res3.timingPoints[1];
    assert(Math.abs(tp1.bpm - 130) <= 1.0, `Test 3 Seccion 1 BPM: ${tp1.bpm} (esperado: 130)`);
    assert(Math.abs(tp2.bpm - 180) <= 1.0, `Test 3 Seccion 2 BPM: ${tp2.bpm} (esperado: 180)`);
    assert(tp1.meter === 4 && tp2.meter === 3, `Test 3 Cambio de compas: ${tp1.timeSignature} -> ${tp2.timeSignature} (esperado: 4/4 -> 3/4)`);
  }

  assert(res4.timingPoints.length === 2, `Test 4 Detecto Reset de Fase en mismo BPM (${res4.timingPoints.length} secciones)`);
  if (res4.timingPoints.length === 2) {
    const p1 = res4.timingPoints[0];
    const p2 = res4.timingPoints[1];
    assert(Math.abs(p1.bpm - 160) <= 0.5 && Math.abs(p2.bpm - 160) <= 0.5, `Test 4 Ambos segmentos mantienen 160 BPM (${p1.bpm}, ${p2.bpm})`);
    assert(Math.abs(p2.offsetMs - sec2StartMs) <= 15, `Test 4 Offset de re-sincronizacion detectado: ${p2.offsetMs}ms (esperado: ~${sec2StartMs}ms)`);
  }

  assert(
    res5.isVariableBpm === false && res5.primaryBpm === 231,
    `Test 5 Consolido 231 BPM ignorando el falso 154 BPM polirritmico (BPM: ${res5.primaryBpm}, Variable: ${res5.isVariableBpm})`
  );

  assert(
    res6.primaryBpm === 154,
    `Test 6 Forzado manual de BPM a 154: ${res6.primaryBpm} (esperado: 154)`
  );

  assert(
    Math.abs(res7.primaryBpm - 348) <= 1.0,
    `Test 7 Doblado de BPM (174 x 2 = 348): ${res7.primaryBpm} (esperado: ~348)`
  );

  assert(
    Math.abs(res8.primaryBpm - 170) <= 0.5 && res8.timingPoints[0].offsetMs < 1420,
    `Test 8 Analisis desde drop (segundo 12) y retro-proyeccion de compas a inicio: ${res8.primaryBpm} BPM, Offset: ${res8.timingPoints[0].offsetMs}ms`
  );

  if (!allPassed) {
    process.exit(1);
  }
}

runTests();
