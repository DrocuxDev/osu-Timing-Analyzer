import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { formatMsToTimestamp } from './analyzer.js';
import { createZipArchive } from './zip.js';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  pink: '\x1b[38;5;213m',
  cyan: '\x1b[38;5;87m',
  green: '\x1b[38;5;120m',
  yellow: '\x1b[38;5;221m',
  red: '\x1b[38;5;203m',
  purple: '\x1b[38;5;141m',
  white: '\x1b[38;5;255m',
  gray: '\x1b[38;5;245m'
};

export function printTerminalReport(audioPath, analysis) {
  const fileName = path.basename(audioPath);
  const c = COLORS;

  console.log('');
  console.log(`${c.pink}${c.bold}╭──────────────────────────────────────────────────────────────────────────────╮${c.reset}`);
  console.log(`${c.pink}${c.bold}│  osu! TIMING & METER ANALYZER (BPM · Offset · Compas · Multi-BPM / vBPM)     │${c.reset}`);
  console.log(`${c.pink}${c.bold}╰──────────────────────────────────────────────────────────────────────────────╯${c.reset}`);
  console.log('');

  console.log(`  ${c.bold}Archivo:${c.reset}          ${c.cyan}${fileName}${c.reset}`);
  console.log(`  ${c.bold}Duracion:${c.reset}         ${formatMsToTimestamp(analysis.durationSec * 1000)} (${analysis.durationSec.toFixed(2)}s)`);
  console.log(`  ${c.bold}Clasificacion:${c.reset}    ${c.purple}${c.bold}${analysis.tempoCharacter || 'LINEAL'}${c.reset}`);
  console.log(
    `  ${c.bold}Tipo de Tempo:${c.reset}    ${
      analysis.isVariableBpm
        ? `${c.yellow}${c.bold}[!] BPM VARIABLE (${analysis.timingPoints.length} secciones detectadas)${c.reset}`
        : `${c.green}${c.bold}[OK] BPM CONSTANTE (Lineal)${c.reset}`
    }`
  );
  console.log(
    `  ${c.bold}Tipo de Compas:${c.reset}   ${
      analysis.isVariableMeter
        ? `${c.yellow}${c.bold}[!] COMPAS VARIABLE (Cambios de metrica detectados)${c.reset}`
        : `${c.green}[OK] Compas Estable (${analysis.primaryMeter})${c.reset}`
    }`
  );
  if (analysis.hasPhaseResets) {
    console.log(
      `  ${c.bold}Sincronia Barra:${c.reset}  ${c.yellow}[!] Se detectaron cortes o compases incompletos (Phase Resets)${c.reset}`
    );
  }
  console.log('');

  // Resumen rapido para pegar en el editor de osu! (F6)
  console.log(`${c.purple}${c.bold}  ═══ RESUMEN PRINCIPAL PARA OSU! (F6 TIMING SETUP) ════════════════════════════${c.reset}`);
  console.log(`  ${c.bold}• BPM Principal:${c.reset}  ${c.green}${c.bold}${analysis.primaryBpm} BPM${c.reset}`);
  console.log(`  ${c.bold}• Offset Inicial:${c.reset} ${c.cyan}${c.bold}${analysis.initialOffsetMs} ms${c.reset} ${c.gray}(${formatMsToTimestamp(analysis.initialOffsetMs)})${c.reset}`);
  console.log(`  ${c.bold}• Compas Base:${c.reset}    ${c.yellow}${c.bold}${analysis.primaryMeter}${c.reset}`);
  if (analysis.diagnostics) {
    console.log(
      `  ${c.bold}• Drift / Error:${c.reset}  ${c.white}±${analysis.diagnostics.avgDriftRmseMs} ms RMSE${c.reset} ${c.gray}(${analysis.diagnostics.syncQuality})${c.reset}`
    );
    if (analysis.diagnostics.recommendedAudioLeadInMs > 0) {
      console.log(
        `  ${c.bold}• AudioLeadIn:${c.reset}    ${c.yellow}${analysis.diagnostics.recommendedAudioLeadInMs} ms recomendados${c.reset} ${c.gray}(la pista inicia muy pronto en ${analysis.diagnostics.firstAudibleOnsetMs} ms)${c.reset}`
      );
    }
  }
  console.log('');

  // Candidatos de tempo alternativos
  if (analysis.candidates && analysis.candidates.length > 1) {
    console.log(`${c.purple}${c.bold}  ═══ CANDIDATOS DE TEMPO DETECTADOS ════════════════════════════════════════════${c.reset}`);
    for (let i = 0; i < analysis.candidates.length; i++) {
      const cand = analysis.candidates[i];
      const isSelected = Math.abs(cand.bpm - analysis.primaryBpm) <= 0.25;
      const marker = isSelected ? `${c.green}${c.bold}[ACTUAL]${c.reset}` : `${c.cyan}[${i + 1}]${c.reset}`;
      const bpmStr = `${cand.bpm.toFixed(2).replace(/\.00$/, '')} BPM`.padEnd(12);
      const confStr = `${(cand.confidence * 100).toFixed(0)}% conf`.padEnd(10);
      const relStr = cand.relation ? `${c.yellow}(${cand.relation})${c.reset}` : '';
      console.log(`  ${marker} ${c.bold}${bpmStr}${c.reset} ${c.gray}${confStr}${c.reset} ${relStr}`);
    }
    console.log('');
  }

  // Mapa visual de linea de tiempo (Timeline bar)
  printAsciiTimeline(analysis);

  // Tabla de Timing Points (Secciones / Cambios de BPM, Compas y Resets de Fase)
  console.log(`${c.purple}${c.bold}  ═══ TABLA DE TIMING POINTS (LINEAS ROJAS DE OSU!) ════════════════════════════${c.reset}`);
  console.log(
    `  ${c.gray}#   │ Offset (ms) │ Inicio       │ Fin          │ BPM       │ Compas │ Drift (ms) │ Cambio${c.reset}`
  );
  console.log(
    `  ${c.gray}────┼─────────────┼──────────────┼──────────────┼───────────┼────────┼────────────┼────────────────────${c.reset}`
  );

  for (let i = 0; i < analysis.timingPoints.length; i++) {
    const tp = analysis.timingPoints[i];
    const prev = i > 0 ? analysis.timingPoints[i - 1] : null;

    let changeDesc = 'Inicio (Downbeat)';
    if (prev) {
      const changes = [];
      if (Math.abs(tp.bpm - prev.bpm) > 0.01) {
        const diff = tp.bpm - prev.bpm;
        const sign = diff > 0 ? '+' : '';
        changes.push(`BPM ${sign}${diff.toFixed(2)}`);
      }
      if (tp.meter !== prev.meter) {
        changes.push(`Compas ${prev.meter}/4 -> ${tp.meter}/4`);
      }
      if (changes.length === 0 || tp.changeType === 'phase_reset') {
        changes.push('Reset de Compas (Fase)');
      } else if (tp.changeType === 'rubato_drift') {
        changes.push('Ajuste vBPM/Drift');
      }
      changeDesc = changes.join(', ');
    }

    const idxStr = String(tp.index).padEnd(3, ' ');
    const offStr = `${tp.offsetMs} ms`.padEnd(11, ' ');
    const startStr = tp.startTimeFormatted.padEnd(12, ' ');
    const endStr = tp.endTimeFormatted.padEnd(12, ' ');
    const bpmStr = `${tp.bpm}`.padEnd(9, ' ');
    const meterStr = tp.timeSignature.padEnd(6, ' ');
    const driftStr = `±${(tp.driftRmseMs ?? 0).toFixed(1)} ms`.padEnd(10, ' ');

    console.log(
      `  ${c.bold}${idxStr}${c.reset} │ ${c.cyan}${offStr}${c.reset} │ ${startStr} │ ${endStr} │ ${c.green}${c.bold}${bpmStr}${c.reset} │ ${c.yellow}${meterStr}${c.reset} │ ${driftStr} │ ${c.pink}${changeDesc}${c.reset}`
    );
  }
  console.log('');

  // Bloque listo para copiar y pegar directamente en el archivo .osu
  console.log(`${c.purple}${c.bold}  ═══ CODIGO PARA ARCHIVO .osu (Pegar bajo [TimingPoints]) ═════════════════════${c.reset}`);
  console.log(`  ${c.gray}[TimingPoints]${c.reset}`);
  for (const tp of analysis.timingPoints) {
    console.log(`  ${c.white}${tp.osuTimingPointLine}${c.reset}`);
  }
  console.log('');
}

function printAsciiTimeline(analysis) {
  const c = COLORS;
  const barWidth = 68;
  const totalMs = Math.max(1, analysis.durationSec * 1000);
  const palette = [c.green, c.cyan, c.yellow, c.pink, c.purple];

  let bar = '';
  let legend = [];

  for (let i = 0; i < analysis.timingPoints.length; i++) {
    const tp = analysis.timingPoints[i];
    const durMs = Math.max(0, tp.endMs - tp.offsetMs);
    const chars = Math.max(2, Math.round((durMs / totalMs) * barWidth));
    const color = palette[i % palette.length];
    bar += `${color}${'█'.repeat(chars)}${c.reset}`;
    legend.push(`${color}■${c.reset} #${tp.index}: ${tp.bpm} BPM (${tp.timeSignature})`);
  }

  console.log(`  ${c.bold}Mapa de Estructura Temporal:${c.reset}`);
  console.log(`  [${bar}]`);
  console.log(`  ${legend.join('   ')}`);
  console.log('');
}

/**
 * Obtiene el buffer de audio compatible con osu! (.mp3 o .ogg).
 * Si el archivo es WAV, FLAC, M4A, etc., lo convierte a MP3 de alta calidad (320kbps) mediante FFmpeg.
 */
export async function getOsuCompatibleAudio(audioFilePath) {
  const ext = path.extname(audioFilePath).toLowerCase();
  if (ext === '.mp3') {
    return {
      filename: 'audio.mp3',
      data: fs.readFileSync(audioFilePath)
    };
  }
  if (ext === '.ogg') {
    return {
      filename: 'audio.ogg',
      data: fs.readFileSync(audioFilePath)
    };
  }

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-i', audioFilePath,
      '-f', 'mp3',
      '-c:a', 'libmp3lame',
      '-b:a', '320k',
      'pipe:1'
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];

    proc.stdout.on('data', (c) => chunks.push(c));

    proc.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        resolve({
          filename: path.basename(audioFilePath),
          data: fs.readFileSync(audioFilePath)
        });
        return;
      }
      resolve({
        filename: 'audio.mp3',
        data: Buffer.concat(chunks)
      });
    });

    proc.on('error', () => {
      resolve({
        filename: path.basename(audioFilePath),
        data: fs.readFileSync(audioFilePath)
      });
    });
  });
}

/**
 * Genera el contenido oficial de un archivo .osu (v14) listo para osu!.
 */
export function generateOsuFileContent(title, audioFilename, analysis) {
  const timingLines = analysis.timingPoints.map((tp) => tp.osuTimingPointLine).join('\r\n');
  const leadIn = analysis.diagnostics?.recommendedAudioLeadInMs || 0;

  return `osu file format v14

[General]
AudioFilename: ${audioFilename}
AudioLeadIn: ${leadIn}
PreviewTime: -1
Countdown: 0
SampleSet: Soft
StackLeniency: 0.7
Mode: 0
LetterboxInBreaks: 0
WidescreenStoryboard: 1

[Editor]
DistanceSpacing: 1.0
BeatDivisor: 4
GridSize: 4
TimelineZoom: 1

[Metadata]
Title:${title}
TitleUnicode:${title}
Artist:Unknown
ArtistUnicode:Unknown
Creator:osu-timing
Version:Timing
Source:
Tags:osu-timing
BeatmapID:0
BeatmapSetID:-1

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[Events]
//Background and Video events
//Break Periods
//Storyboard Layer 0 (Fail)
//Storyboard Layer 1 (Pass)
//Storyboard Layer 2 (Foreground)
//Storyboard Layer 3 (Background)
//Storyboard Sound Samples

[TimingPoints]
${timingLines}

[HitObjects]
`;
}

/**
 * Empaqueta un beatmap completo en formato .osz (ZIP que contiene audio + archivo .osu).
 * Este archivo .osz es el formato nativo de osu!: al arrastrarlo o hacer doble clic,
 * osu! lo importa de inmediato sin errores.
 */
export async function exportToOszPackage(targetOszPath, audioFilePath, analysis) {
  const resolvedOsz = path.resolve(targetOszPath);
  const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
  const audio = await getOsuCompatibleAudio(audioFilePath);
  const osuContent = generateOsuFileContent(baseName, audio.filename, analysis);

  // Nombre de archivo .osu con la convencion estandar de osu!
  const osuFileNameInZip = `Unknown - ${baseName} (osu-timing) [Timing].osu`;

  const zipBuffer = createZipArchive([
    { name: audio.filename, data: audio.data },
    { name: osuFileNameInZip, data: Buffer.from(osuContent, 'utf8') }
  ]);

  fs.writeFileSync(resolvedOsz, zipBuffer);

  // Tambien generamos el archivo .osu en la misma carpeta para quien quiera inspeccionarlo o copiarlo
  const standaloneOsuPath = path.join(path.dirname(resolvedOsz), `${baseName}.osu`);
  fs.writeFileSync(standaloneOsuPath, Buffer.from(osuContent, 'utf8'));

  return {
    oszPath: resolvedOsz,
    osuPath: standaloneOsuPath,
    audioFilename: audio.filename
  };
}

/**
 * Inyecta o reemplaza la seccion [TimingPoints] dentro de un archivo .osu existente,
 * o crea una plantilla .osu lista para abrir en el editor de osu!
 */
export function exportToOsuFile(targetOsuPath, audioFilePath, analysis) {
  const resolvedOsu = path.resolve(targetOsuPath);
  const timingLines = analysis.timingPoints.map((tp) => tp.osuTimingPointLine).join('\n');

  if (fs.existsSync(resolvedOsu)) {
    const content = fs.readFileSync(resolvedOsu, 'utf8');
    if (content.includes('[TimingPoints]')) {
      const updated = content.replace(
        /\[TimingPoints\][\s\S]*?(?=\r?\n\[|$)/,
        `[TimingPoints]\n${timingLines}\n`
      );
      fs.writeFileSync(resolvedOsu, updated, 'utf8');
      return { mode: 'updated', path: resolvedOsu };
    } else {
      const updated = `${content.trimEnd()}\n\n[TimingPoints]\n${timingLines}\n`;
      fs.writeFileSync(resolvedOsu, updated, 'utf8');
      return { mode: 'appended', path: resolvedOsu };
    }
  } else {
    const audioFileName = path.basename(audioFilePath);
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const content = generateOsuFileContent(baseName, audioFileName, analysis);
    fs.writeFileSync(resolvedOsu, content, 'utf8');
    return { mode: 'created', path: resolvedOsu };
  }
}
