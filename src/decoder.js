import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Decodes any audio file into a mono Float32Array at the target sample rate.
 * Uses native WAV parsing if possible, or FFmpeg as universal decoder.
 */
export async function decodeAudio(filePath, targetSampleRate = 44100) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`El archivo de audio no existe: ${resolvedPath}`);
  }

  // Intentar usar FFmpeg primero porque normaliza cualquier formato (.mp3, .ogg, .wav, .flac, .m4a)
  // directamente a PCM 32-bit float mono a la frecuencia deseada.
  try {
    const pcmBuffer = await decodeWithFFmpeg(resolvedPath, targetSampleRate);
    const floatArray = new Float32Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      Math.floor(pcmBuffer.byteLength / 4)
    );
    return {
      samples: floatArray,
      sampleRate: targetSampleRate,
      duration: floatArray.length / targetSampleRate,
      filePath: resolvedPath
    };
  } catch (ffmpegErr) {
    // Fallback para archivos WAV sin comprimir si FFmpeg no estuviera en el PATH
    if (resolvedPath.toLowerCase().endsWith('.wav')) {
      return decodeWavFallback(resolvedPath);
    }
    throw new Error(
      `No se pudo decodificar el archivo de audio (${ffmpegErr.message}). Asegúrate de tener 'ffmpeg' instalado en tu sistema.`
    );
  }
}

function decodeWithFFmpeg(filePath, sampleRate) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-i', filePath,
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      '-ac', '1',
      '-ar', String(sampleRate),
      'pipe:1'
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];

    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', (chunk) => errChunks.push(chunk));

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const errMsg = Buffer.concat(errChunks).toString('utf8').trim();
        reject(new Error(errMsg || `FFmpeg salió con código ${code}`));
        return;
      }
      const fullBuffer = Buffer.concat(chunks);
      if (fullBuffer.byteLength === 0) {
        reject(new Error('El flujo de audio decodificado está vacío.'));
        return;
      }
      resolve(fullBuffer);
    });
  });
}

export function decodeWavFallback(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Formato WAV inválido o archivo truncado (< 44 bytes).');
  }

  let offset = 12;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 1;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset <= buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      if (offset + 8 + chunkSize > buffer.length || chunkSize < 16) {
        throw new Error('Bloque fmt corrupto o truncado en el archivo WAV.');
      }
      audioFormat = buffer.readUInt16LE(offset + 8);
      numChannels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkSize, Math.max(0, buffer.length - dataOffset));
      break;
    }
    const nextOffset = offset + 8 + chunkSize + (chunkSize % 2);
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (numChannels <= 0 || numChannels > 32) {
    throw new RangeError(`Número de canales WAV inválido: ${numChannels}`);
  }
  if (sampleRate <= 0 || sampleRate > 384000) {
    throw new RangeError(`Sample rate WAV inválido: ${sampleRate}`);
  }
  if (![8, 16, 24, 32].includes(bitsPerSample)) {
    throw new RangeError(`Bits por muestra no soportados: ${bitsPerSample}`);
  }
  if (dataOffset === -1 || dataSize <= 0) {
    throw new Error('No se encontró el bloque de datos en el archivo WAV.');
  }

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const availableBytes = Math.min(dataSize, buffer.length - dataOffset);
  const totalFrames = Math.floor(availableBytes / blockAlign);

  if (totalFrames <= 0) {
    throw new Error('El archivo WAV no contiene frames de audio completos.');
  }

  const samples = new Float32Array(totalFrames);

  for (let i = 0; i < totalFrames; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const samplePos = dataOffset + i * blockAlign + ch * bytesPerSample;
      let val = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        val = buffer.readFloatLE(samplePos);
      } else if (bitsPerSample === 16) {
        val = buffer.readInt16LE(samplePos) / 32768.0;
      } else if (bitsPerSample === 24) {
        const b0 = buffer[samplePos];
        const b1 = buffer[samplePos + 1];
        const b2 = buffer[samplePos + 2];
        const signed = (b2 << 24) | (b1 << 16) | (b0 << 8);
        val = (signed >> 8) / 8388608.0;
      } else if (bitsPerSample === 8) {
        val = (buffer.readUInt8(samplePos) - 128) / 128.0;
      }
      if (Number.isFinite(val)) {
        sum += Math.max(-1.0, Math.min(1.0, val));
      }
    }
    samples[i] = sum / numChannels;
  }

  return {
    samples,
    sampleRate,
    duration: totalFrames / sampleRate,
    filePath
  };
}
