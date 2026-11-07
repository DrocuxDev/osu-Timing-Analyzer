import { decodeAudio } from './decoder.js';
import { extractMultiBandOnsets } from './dsp.js';
import { analyzeTiming } from './analyzer.js';
import { printTerminalReport, exportToOsuFile, exportToOszPackage } from './formatter.js';

export async function analyzeAudioFile(filePath, options = {}) {
  const sampleRate = options.sampleRate || 44100;
  const decoded = await decodeAudio(filePath, sampleRate);
  const features = extractMultiBandOnsets(decoded.samples, decoded.sampleRate, 1024, 256);
  const analysis = analyzeTiming(features, options);
  return analysis;
}

export {
  decodeAudio,
  extractMultiBandOnsets,
  analyzeTiming,
  printTerminalReport,
  exportToOsuFile,
  exportToOszPackage
};
