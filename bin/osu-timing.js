#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import {
  analyzeAudioFile,
  printTerminalReport,
  exportToOsuFile,
  exportToOszPackage
} from '../src/index.js';

function printHelp() {
  console.log(`
osu-timing - Analizador de BPM, Offset, Compás y Cambios Dinámicos para osu!

Uso:
  osu-timing                     (Abre directamente la ventana para elegir tu archivo de audio)
  osu-timing <archivo-audio> [opciones]

Ejemplos:
  osu-timing
  osu-timing cancion.mp3
  osu-timing cancion.mp3 --osz mapa.osz
  osu-timing cancion.mp3 --osu mapa.osu
  osu-timing cancion.wav --json > resultado.json

Opciones:
  --bpm <num>, -b       Fija o fuerza un BPM objetivo específico (recalcula offset y compás)
  --double, -d          Dobla el BPM detectado (2x)
  --half, -m            Divide a la mitad el BPM detectado (0.5x)
  --start-at <seg>, -i  Inicia el análisis a partir de un segundo específico (ignora intro lenta/ambiental)
  --min-bpm <num>       BPM mínimo a buscar (por defecto: 60)
  --max-bpm <num>       BPM máximo a buscar (por defecto: 260)
  --sensitivity <0-1>   Sensibilidad a cambios de BPM/compás (0.0 a 1.0, defecto: 0.5)
  --rubato              Activa sub-segmentación fina para canciones en vivo sin metrónomo o con rubato continuo
  --no-snap             No redondear BPMs muy cercanos a enteros (.0 / .5)
  --osz <archivo.osz>   Exporta un paquete .osz completo (audio + .osu) listo para arrastrar/abrir en osu!
  --osu <archivo.osu>   Exporta o actualiza directamente la sección [TimingPoints] de un archivo .osu
  --json                Imprime el resultado en formato JSON puro
  -h, --help            Muestra esta ayuda
`);
}

/**
 * Abre el selector de archivos nativo del sistema operativo (Windows Explorer / macOS Finder / Linux).
 */
function openNativeFileDialog() {
  try {
    if (process.platform === 'win32') {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.Application]::EnableVisualStyles()
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Title = 'Selecciona el archivo de audio para osu! (BPM, Offset y Compas)'
        $dlg.Filter = 'Archivos de Audio (*.mp3;*.ogg;*.wav;*.flac;*.m4a;*.aac;*.opus)|*.mp3;*.ogg;*.wav;*.flac;*.m4a;*.aac;*.opus|Todos los archivos (*.*)|*.*'
        $dlg.Multiselect = $false
        $form = New-Object System.Windows.Forms.Form
        $form.TopMost = $true
        $form.Opacity = 0
        $form.ShowInTaskbar = $false
        if ($dlg.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
          [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
          Write-Output $dlg.FileName
        }
        $form.Dispose()
      `;
      const result = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      return result || null;
    } else if (process.platform === 'darwin') {
      const appleScript =
        'POSIX path of (choose file with prompt "Selecciona el archivo de audio para osu!:" of type {"mp3", "ogg", "wav", "flac", "m4a", "public.audio"})';
      const result = execFileSync('osascript', ['-e', appleScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return result || null;
    } else {
      try {
        return execFileSync(
          'zenity',
          ['--file-selection', '--title=Selecciona el archivo de audio para osu!'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
      } catch {
        return execFileSync(
          'kdialog',
          ['--getopenfilename', '.', '*.mp3 *.ogg *.wav *.flac *.m4a'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
      }
    }
  } catch {
    return null;
  }
}

/**
 * Copia texto al portapapeles del sistema (Windows / macOS / Linux)
 */
function copyToClipboard(text) {
  try {
    if (process.platform === 'win32') {
      execFileSync('clip', [], { input: text, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } else if (process.platform === 'darwin') {
      execFileSync('pbcopy', [], { input: text, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    }
  } catch {
    // Ignorar si no esta disponible
  }
  return false;
}

function askQuestion(rl, query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function analyzeAndShow(audioPath, options) {
  const resolvedAudio = path.resolve(audioPath);
  if (!fs.existsSync(resolvedAudio)) {
    console.error(`\n[ERROR] No se encontró el archivo "${resolvedAudio}"`);
    return false;
  }

  if (!options.json) {
    process.stdout.write(`\n[...] Analizando audio "${path.basename(resolvedAudio)}" (DSP + Tempograma + Compás)...\r`);
  }

  const startTime = performance.now();
  const analysis = await analyzeAudioFile(resolvedAudio, options);
  const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);

  if (options.json) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    process.stdout.write(' '.repeat(90) + '\r');
    printTerminalReport(resolvedAudio, analysis);
    console.log(`  [INFO] Análisis completado en ${elapsedSec}s`);

    // Copiar automáticamente las líneas de [TimingPoints] al portapapeles para pegar directo en osu!
    const timingLines = analysis.timingPoints.map((tp) => tp.osuTimingPointLine).join('\r\n');
    if (copyToClipboard(timingLines)) {
      console.log(`  [INFO] Las líneas de [TimingPoints] se han copiado automáticamente al portapapeles.`);
    }
  }

  if (options.oszOut || (options.osuOut && options.osuOut.toLowerCase().endsWith('.osz'))) {
    const outPath = options.oszOut || options.osuOut;
    const res = await exportToOszPackage(outPath, resolvedAudio, analysis);
    if (!options.json) {
      console.log(`  [OK] Paquete .osz generado: ${res.oszPath}`);
      console.log(`  [OK] Archivo .osu generado: ${res.osuPath}\n`);
    }
  } else if (options.osuOut) {
    const res = exportToOsuFile(options.osuOut, resolvedAudio, analysis);
    if (!options.json) {
      console.log(`  [OK] Archivo .osu (${res.mode}): ${res.path}\n`);
    }
  }

  return { analysis, resolvedAudio };
}

async function runInteractiveMode(options) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.clear();
  console.log('\x1b[38;5;213m\x1b[1m╭──────────────────────────────────────────────────────────────────────────────╮\x1b[0m');
  console.log('\x1b[38;5;213m\x1b[1m│  osu! TIMING ANALYZER — Selector Directo de Audio                            │\x1b[0m');
  console.log('\x1b[38;5;213m\x1b[1m╰──────────────────────────────────────────────────────────────────────────────╯\x1b[0m');

  let keepRunning = true;
  while (keepRunning) {
    console.log('\nAbriendo ventana para seleccionar tu canción (.mp3, .ogg, .wav, .flac, .m4a)...');
    let selectedFile = openNativeFileDialog();

    if (!selectedFile) {
      const manualInput = (
        await askQuestion(
          rl,
          '\nNo seleccionaste archivo en la ventana. Puedes arrastrar un archivo aquí (o presionar Enter para salir): '
        )
      ).trim();

      if (!manualInput) {
        break;
      }
      selectedFile = manualInput.replace(/^["']|["']$/g, '');
    }

    try {
      const result = await analyzeAndShow(selectedFile, options);
      if (result) {
        let currentAnalysis = result.analysis;
        let currentAudio = result.resolvedAudio;
        let stayInSongMenu = true;

        while (stayInSongMenu) {
          console.log('\n────────────────────────────────────────────────────────────────────────────────');
          console.log('¿Qué deseas hacer ahora?');
          if (currentAnalysis.candidates && currentAnalysis.candidates.length > 1) {
            for (let i = 0; i < Math.min(3, currentAnalysis.candidates.length); i++) {
              const c = currentAnalysis.candidates[i];
              const isCur = Math.abs(c.bpm - currentAnalysis.primaryBpm) <= 0.25;
              const curTag = isCur ? ' [SELECCIONADO]' : '';
              console.log(`  [${i + 1}]     Elegir candidato #${i + 1}: ${c.bpm} BPM ${c.relation ? `(${c.relation})` : ''}${curTag}`);
            }
          }
          console.log('  [D]     Doblar BPM (x2)');
          console.log('  [M]     Mitad de BPM (/2)');
          console.log('  [B]     Escribir o corregir BPM manualmente (recalcula offset y compás)');
          console.log('  [I]     Indicar inicio del ritmo o drop (ignorar intro lenta/ambiental)');
          console.log('  [G]     Exportar paquete .osz para osu! (listo para arrastrar o hacer doble clic)');
          console.log('  [Enter] Analizar otra canción');
          console.log('  [S]     Salir');

          const action = (await askQuestion(rl, '\nOpción: ')).trim().toLowerCase();

          if (!action) {
            stayInSongMenu = false;
          } else if (action === 's' || action === 'salir' || action === 'q') {
            stayInSongMenu = false;
            keepRunning = false;
          } else if (action === '1' || action === '2' || action === '3') {
            const idx = parseInt(action, 10) - 1;
            if (currentAnalysis.candidates && currentAnalysis.candidates[idx]) {
              const newBpm = currentAnalysis.candidates[idx].bpm;
              console.log(`\n[...] Recalculando Timing Points y Offset para ${newBpm} BPM...`);
              const reRes = await analyzeAndShow(currentAudio, { ...options, targetBpm: newBpm });
              if (reRes) currentAnalysis = reRes.analysis;
            }
          } else if (action === 'd') {
            const newBpm = Math.round(currentAnalysis.primaryBpm * 2 * 100) / 100;
            console.log(`\n[...] Doblando BPM a ${newBpm} BPM (x2)...`);
            const reRes = await analyzeAndShow(currentAudio, { ...options, targetBpm: newBpm });
            if (reRes) currentAnalysis = reRes.analysis;
          } else if (action === 'm') {
            const newBpm = Math.round(currentAnalysis.primaryBpm * 0.5 * 100) / 100;
            console.log(`\n[...] Reduciendo BPM a la mitad: ${newBpm} BPM (/2)...`);
            const reRes = await analyzeAndShow(currentAudio, { ...options, targetBpm: newBpm });
            if (reRes) currentAnalysis = reRes.analysis;
          } else if (action === 'b') {
            const bpmInput = (await askQuestion(rl, '\nIngresa el BPM deseado (ej. 154 o 174.5): ')).trim();
            const parsedBpm = parseFloat(bpmInput);
            if (!isNaN(parsedBpm) && parsedBpm >= 30 && parsedBpm <= 450) {
              console.log(`\n[...] Recalculando con BPM fijado en ${parsedBpm}...`);
              const reRes = await analyzeAndShow(currentAudio, { ...options, targetBpm: parsedBpm });
              if (reRes) currentAnalysis = reRes.analysis;
            } else {
              console.log('\n[!] Valor de BPM invalido (debe ser un numero entre 30 y 450).');
            }
          } else if (action === 'i') {
            const secInput = (await askQuestion(rl, '\nIngresa el segundo donde entra el ritmo o drop (ej. 30 o 45): ')).trim();
            const parsedSec = parseFloat(secInput);
            if (!isNaN(parsedSec) && parsedSec >= 0 && parsedSec < currentAnalysis.durationSec) {
              console.log(`\n[...] Analizando desde el segundo ${parsedSec} (proyectando el compás hacia el inicio)...`);
              const reRes = await analyzeAndShow(currentAudio, { ...options, startAt: parsedSec });
              if (reRes) currentAnalysis = reRes.analysis;
            } else {
              console.log('\n[!] Segundo inválido.');
            }
          } else if (action === 'g') {
            console.log('\nGenerando paquete para osu! (.osz)...');
            const baseName = path.basename(currentAudio, path.extname(currentAudio));
            const defaultOszPath = path.join(path.dirname(currentAudio), `${baseName}.osz`);
            const exported = await exportToOszPackage(defaultOszPath, currentAudio, currentAnalysis);
            console.log(`\n[OK] Paquete .osz generado: ${exported.oszPath}`);
            console.log(`[OK] Archivo .osu generado: ${exported.osuPath}`);
            console.log('\n[INSTRUCCIONES PARA ABRIR EN OSU!]');
            console.log('  1. Haz DOBLE CLIC en el archivo .osz o ARRASTRALO dentro de la ventana de osu!.');
            console.log('  2. osu! importara el mapa automaticamente con el audio y todos los Timing Points.');
            console.log('  (Si ya tienes un mapa abierto en el editor F6, solo presiona Ctrl+V para pegar las lineas).');
          }
        }
      }
    } catch (err) {
      console.error(`\n[ERROR] Error al analizar el archivo: ${err.message}`);
      const retry = (
        await askQuestion(rl, '\nPresiona [Enter] para intentar con otro archivo o [S] para salir: ')
      )
        .trim()
        .toLowerCase();
      if (retry === 's' || retry === 'salir' || retry === 'q') {
        keepRunning = false;
      }
    }
  }

  rl.close();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  let audioPath = null;
  let waitOnExit = false;
  const options = {
    minBpm: 60,
    maxBpm: 260,
    sensitivity: 0.5,
    snapBpm: true,
    json: false,
    osuOut: null,
    oszOut: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--bpm' || arg === '-b') && i + 1 < args.length) {
      options.targetBpm = Number(args[++i]);
    } else if (arg === '--double' || arg === '-d') {
      options.doubleBpm = true;
    } else if (arg === '--half' || arg === '-m') {
      options.halfBpm = true;
    } else if ((arg === '--start-at' || arg === '--skip-intro' || arg === '-i') && i + 1 < args.length) {
      options.startAt = Number(args[++i]);
    } else if (arg === '--min-bpm' && i + 1 < args.length) {
      options.minBpm = Number(args[++i]);
    } else if (arg === '--max-bpm' && i + 1 < args.length) {
      options.maxBpm = Number(args[++i]);
    } else if (arg === '--sensitivity' && i + 1 < args.length) {
      options.sensitivity = Math.max(0, Math.min(1, Number(args[++i])));
    } else if (arg === '--no-snap') {
      options.snapBpm = false;
    } else if (arg === '--rubato') {
      options.rubato = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--wait') {
      waitOnExit = true;
    } else if (arg === '--osz' && i + 1 < args.length) {
      options.oszOut = args[++i];
    } else if (arg === '--osu' && i + 1 < args.length) {
      options.osuOut = args[++i];
    } else if (!arg.startsWith('-')) {
      audioPath = arg;
    }
  }

  if (!audioPath) {
    await runInteractiveMode(options);
    process.exit(0);
  }

  try {
    await analyzeAndShow(audioPath, options);
    if (waitOnExit && !options.json) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await askQuestion(rl, '\nPresiona [Enter] para cerrar...');
      rl.close();
    }
  } catch (err) {
    console.error(`\n[ERROR] Error durante el análisis: ${err.message}`);
    if (waitOnExit) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await askQuestion(rl, '\nPresiona [Enter] para cerrar...');
      rl.close();
    }
    process.exit(1);
  }
}

main();
