/**
 * Fast Radix-2 Cooley-Tukey FFT in-place implementation
 * along with multi-band Spectral Flux Onset Detection Function (ODF).
 */

export class FFT {
  constructor(size) {
    if ((size & (size - 1)) !== 0) {
      throw new Error(`El tamaño de FFT debe ser potencia de 2 (recibido: ${size})`);
    }
    this.size = size;
    this.reverseTable = new Uint32Array(size);
    this.sinTable = new Float64Array(size);
    this.cosTable = new Float64Array(size);

    let limit = 1;
    let bit = size >> 1;
    while (limit < size) {
      for (let i = 0; i < limit; i++) {
        this.reverseTable[i + limit] = this.reverseTable[i] + bit;
      }
      limit <<= 1;
      bit >>= 1;
    }

    for (let i = 0; i < size; i++) {
      this.sinTable[i] = Math.sin(-Math.PI / i);
      this.cosTable[i] = Math.cos(-Math.PI / i);
    }
  }

  transform(real, imag) {
    const n = this.size;
    const rev = this.reverseTable;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = real[j];
        real[j] = real[i];
        real[i] = tr;
        const ti = imag[j];
        imag[j] = imag[i];
        imag[i] = ti;
      }
    }

    let halfSize = 1;
    while (halfSize < n) {
      const phaseShiftStepReal = this.cosTable[halfSize];
      const phaseShiftStepImag = this.sinTable[halfSize];
      let currentPhaseShiftReal = 1.0;
      let currentPhaseShiftImag = 0.0;

      for (let fftStep = 0; fftStep < halfSize; fftStep++) {
        let i = fftStep;
        while (i < n) {
          const off = i + halfSize;
          const tr = currentPhaseShiftReal * real[off] - currentPhaseShiftImag * imag[off];
          const ti = currentPhaseShiftReal * imag[off] + currentPhaseShiftImag * real[off];

          real[off] = real[i] - tr;
          imag[off] = imag[i] - ti;
          real[i] += tr;
          imag[i] += ti;

          i += halfSize << 1;
        }
        const tmpReal = currentPhaseShiftReal;
        currentPhaseShiftReal = tmpReal * phaseShiftStepReal - currentPhaseShiftImag * phaseShiftStepImag;
        currentPhaseShiftImag = tmpReal * phaseShiftStepImag + currentPhaseShiftImag * phaseShiftStepReal;
      }
      halfSize <<= 1;
    }
  }
}

/**
 * Extrae las envolventes de ataques (Onset Detection Function) en múltiples bandas de frecuencia:
 * - lowFlux: 30 Hz - 220 Hz (Bombo / Bajo - crucial para el downbeat del compás)
 * - midFlux: 220 Hz - 2500 Hz (Caja / Instrumentos / Voz)
 * - highFlux: 2500 Hz - 12000 Hz (Hi-hats / Platillos / Transientes rápidos)
 * - totalFlux: Combinación ponderada para detección precisa de beats y ataques
 */
export function extractMultiBandOnsets(samples, sampleRate, frameSize = 1024, hopSize = 256) {
  const fft = new FFT(frameSize);
  const halfBins = frameSize >> 1;
  const numFrames = Math.max(1, Math.floor((samples.length - frameSize) / hopSize) + 1);

  // Ventana de Hann
  const window = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
  }

  const binHz = sampleRate / frameSize;
  const lowBinEnd = Math.min(halfBins, Math.max(2, Math.round(170 / binHz)));
  const midBinEnd = Math.min(halfBins, Math.max(lowBinEnd + 1, Math.round(2500 / binHz)));
  const highBinEnd = Math.min(halfBins, Math.max(midBinEnd + 1, Math.round(12000 / binHz)));

  const lowFlux = new Float32Array(numFrames);
  const midFlux = new Float32Array(numFrames);
  const highFlux = new Float32Array(numFrames);
  const totalFlux = new Float32Array(numFrames);
  const lowRms = new Float32Array(numFrames);
  const rmsEnergy = new Float32Array(numFrames);

  const prevMag = new Float32Array(halfBins);
  const real = new Float64Array(frameSize);
  const imag = new Float64Array(frameSize);

  const gamma = 40.0; // Compresión logarítmica para resaltar transientes frente a volumen alto
  let maxLowRms = 1e-9;

  for (let f = 0; f < numFrames; f++) {
    const startIdx = f * hopSize;
    let sumSq = 0;

    for (let i = 0; i < frameSize; i++) {
      const s = samples[startIdx + i] || 0;
      sumSq += s * s;
      real[i] = s * window[i];
      imag[i] = 0.0;
    }

    rmsEnergy[f] = Math.sqrt(sumSq / frameSize);
    fft.transform(real, imag);

    let lFlux = 0;
    let mFlux = 0;
    let hFlux = 0;
    let lEnergy = 0;

    for (let b = 1; b < highBinEnd; b++) {
      const mag = Math.sqrt(real[b] * real[b] + imag[b] * imag[b]);
      if (b < lowBinEnd) {
        lEnergy += mag;
      }
      const logMag = Math.log1p(gamma * mag);
      const diff = logMag - prevMag[b];
      prevMag[b] = logMag;

      if (diff > 0) {
        if (b < lowBinEnd) {
          lFlux += diff;
        } else if (b < midBinEnd) {
          mFlux += diff;
        } else {
          hFlux += diff;
        }
      }
    }

    lowRms[f] = lEnergy / Math.max(1, lowBinEnd - 1);
    if (lowRms[f] > maxLowRms) maxLowRms = lowRms[f];

    // Normalizar por ancho de banda
    lFlux /= Math.max(1, lowBinEnd - 1);
    mFlux /= Math.max(1, midBinEnd - lowBinEnd);
    hFlux /= Math.max(1, highBinEnd - midBinEnd);

    lowFlux[f] = lFlux;
    midFlux[f] = mFlux;
    highFlux[f] = hFlux;
    // Ponderamos más graves y medios para el pulso rítmico, y agudos para precisión de offset
    totalFlux[f] = lFlux * 1.45 + mFlux * 1.15 + hFlux * 0.75;
  }

  for (let f = 0; f < numFrames; f++) {
    lowRms[f] /= maxLowRms;
  }

  // Limpiar el primer frame (inicialización del espectro previo)
  lowFlux[0] = 0;
  midFlux[0] = 0;
  highFlux[0] = 0;
  totalFlux[0] = 0;

  // Filtrado de umbral adaptativo (Adaptive Moving Mean Subtraction) para aislar los ataques reales
  const onsetEnv = applyAdaptiveThreshold(totalFlux, Math.round((0.15 * sampleRate) / hopSize));
  const lowOnsetEnv = applyAdaptiveThreshold(lowFlux, Math.round((0.15 * sampleRate) / hopSize));
  const midOnsetEnv = applyAdaptiveThreshold(midFlux, Math.round((0.15 * sampleRate) / hopSize));
  const highOnsetEnv = applyAdaptiveThreshold(highFlux, Math.round((0.15 * sampleRate) / hopSize));

  // Detectar picos discretos de ataque con interpolación parabólica para resolución sub-milisegundo
  const onsetEvents = extractSubframePeaks(onsetEnv, lowOnsetEnv, midOnsetEnv, highOnsetEnv, lowRms, sampleRate, hopSize);

  return {
    sampleRate,
    hopSize,
    frameSize,
    frameRate: sampleRate / hopSize,
    onsetEnv,
    lowOnsetEnv,
    midOnsetEnv,
    highOnsetEnv,
    lowRms,
    rmsEnergy,
    onsetEvents
  };
}

function applyAdaptiveThreshold(flux, halfWin) {
  const n = flux.length;
  const out = new Float32Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + flux[i];
  }

  let maxVal = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - halfWin);
    const b = Math.min(n - 1, i + halfWin);
    const localMean = (prefix[b + 1] - prefix[a]) / (b - a + 1);
    const val = Math.max(0, flux[i] - localMean * 1.05);
    out[i] = val;
    if (val > maxVal) maxVal = val;
  }

  if (maxVal > 1e-9) {
    for (let i = 0; i < n; i++) {
      out[i] /= maxVal;
    }
  }
  return out;
}

function extractSubframePeaks(onsetEnv, lowEnv, midEnv, highEnv, lowRms, sampleRate, hopSize) {
  const events = [];
  const n = onsetEnv.length;
  const minPeakDistance = Math.max(2, Math.round((0.045 * sampleRate) / hopSize)); // mín 45ms entre ataques

  let lastPeakFrame = -minPeakDistance;

  for (let i = 2; i < n - 2; i++) {
    const y0 = onsetEnv[i];
    if (y0 < 0.04) continue; // Umbral mínimo de ruido

    if (
      y0 > onsetEnv[i - 1] &&
      y0 >= onsetEnv[i + 1] &&
      y0 >= onsetEnv[i - 2] &&
      y0 >= onsetEnv[i + 2]
    ) {
      if (i - lastPeakFrame < minPeakDistance) {
        if ( events.length > 0 && y0 > events[events.length - 1].strength) {
          events.pop();
        } else {
          continue;
        }
      }

      // Interpolación parabólica para encontrar el instante exacto entre frames
      const ym1 = onsetEnv[i - 1];
      const yp1 = onsetEnv[i + 1];
      const denom = ym1 - 2 * y0 + yp1;
      let delta = 0;
      if (Math.abs(denom) > 1e-9) {
        delta = (0.5 * (ym1 - yp1)) / denom;
        delta = Math.max(-0.5, Math.min(0.5, delta));
      }

      // Compensación de grupo de fase: el cambio espectral (flux) entre el frame i-1 e i
      // ocurre cuando el ataque entra en la mitad activa (centro) de la ventana Hann del frame i.
      // El centro de la ventana de tamaño 1024 con hopSize 256 está desplazado +2.0 frames (+12ms),
      // pero el ataque percusivo alcanza su máxima derivada espectral ~2.8 frames antes del centro.
      const windowPhaseCompensation = (1024 * 0.72) / hopSize;
      const exactFrame = i + delta + windowPhaseCompensation;
      const timeSec = Math.max(0, (exactFrame * hopSize) / sampleRate);

      // Energía local en bandas alrededor del pico (incluyendo el sustain inmediato de graves tras el impacto del bombo)
      const lowFluxPeak = Math.max(lowEnv[i - 1], lowEnv[i], lowEnv[i + 1]);
      let bassSustain = 0;
      for (let k = 0; k <= 5 && i + k < n; k++) {
        if (lowRms[i + k] > bassSustain) bassSustain = lowRms[i + k];
      }
      const lowStrength = lowFluxPeak * 0.55 + bassSustain * 0.85;
      const midStrength = Math.max(midEnv[i - 1], midEnv[i], midEnv[i + 1]);
      const highStrength = Math.max(highEnv[i - 1], highEnv[i], highEnv[i + 1]);

      events.push({
        frame: exactFrame,
        timeSec,
        timeMs: timeSec * 1000.0,
        strength: y0,
        lowStrength,
        midStrength,
        highStrength
      });
      lastPeakFrame = i;
    }
  }

  return events;
}
