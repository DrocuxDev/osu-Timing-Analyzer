import { decodeAudio, decodeWavFallback } from './decoder.js';
import { FFT, extractMultiBandOnsets } from './dsp.js';
import { analyzeTiming, formatMsToTimestamp } from './analyzer.js';
import {
  printTerminalReport,
  generateOsuFileContent,
  exportToOsuFile,
  exportToOszPackage
} from './formatter.js';
import {
  OSU_MIN_SV,
  OSU_MAX_SV,
  OSU_MIN_BPM,
  OSU_MAX_BPM,
  DEFAULT_SNAP_EPSILON_MS,
  STANDARD_BEAT_DIVISORS,
  parseStrictFiniteNumber,
  computeBpmFromBeatLength,
  computeClampedSliderVelocity,
  parseTimingPointLine,
  sortTimingPoints,
  binarySearchTimingPoint,
  resolveTimingContextAt,
  checkHitObjectSnap,
  formatTimingPointToOsuLine,
  parseOsuFile
} from './osu-parser.js';

export async function analyzeAudioFile(filePath, options = {}) {
  const sampleRate =
    Number.isFinite(Number(options.sampleRate)) && Number(options.sampleRate) > 0
      ? Number(options.sampleRate)
      : 44100;
  const decoded = await decodeAudio(filePath, sampleRate);
  const features = extractMultiBandOnsets(decoded.samples, decoded.sampleRate, 1024, 256);
  const analysis = analyzeTiming(features, options);
  return analysis;
}

export {
  decodeAudio,
  decodeWavFallback,
  FFT,
  extractMultiBandOnsets,
  analyzeTiming,
  formatMsToTimestamp,
  printTerminalReport,
  generateOsuFileContent,
  exportToOsuFile,
  exportToOszPackage,
  OSU_MIN_SV,
  OSU_MAX_SV,
  OSU_MIN_BPM,
  OSU_MAX_BPM,
  DEFAULT_SNAP_EPSILON_MS,
  STANDARD_BEAT_DIVISORS,
  parseStrictFiniteNumber,
  computeBpmFromBeatLength,
  computeClampedSliderVelocity,
  parseTimingPointLine,
  sortTimingPoints,
  binarySearchTimingPoint,
  resolveTimingContextAt,
  checkHitObjectSnap,
  formatTimingPointToOsuLine,
  parseOsuFile
};
