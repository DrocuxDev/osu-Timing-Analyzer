/**
 * Motor de Analisis de Tempo, Offset, Compas y Cambios Dinamicos (Timing Points) para osu!
 *
 * Incluye las mejores practicas de MIR (Music Information Retrieval) y osu! Mapping:
 * 1. Evaluacion de Estabilidad Global Primero (Global Tempo Hypothesis Test):
 *    En osu!, el 95% de las canciones tienen un unico BPM maestro (ej. 231 BPM). Antes de cortar
 *    la cancion en multiples pedazos por ruido de bajo/voz o polirritmias (como tresillos 2/3x -> 154 BPM),
 *    el motor comprueba si el BPM maestro explica las secciones. Solo crea una nueva linea roja si el
 *    BPM realmente cambia de forma estructural.
 * 2. Filtro de Relaciones Polirritmicas y Octavas Metricas (2/3x, 3/2x, 3/4x, 4/3x, 1/2x, 2x):
 *    Evita confundir un puente con tresillos o blancas a tresillo (ej. 154 BPM cuando la cancion va a 231 BPM)
 *    con un cambio real de BPM.
 * 3. Estabilidad de Compas (4/4 y 3/4 Prior):
 *    Evita reportar compases raros (5/4, 7/4, 6/4) producidos por sincopas vocales o fills de bateria,
 *    a menos que la metrica compleja sea verdaderamente dominante y sostenida.
 * 4. El modo sub-segmentacion de Rubato/Live-Drummer solo se activa bajo pedido explicito (--rubato),
 *    para nunca contaminar mapas estandar con docenas de lineas rojas con ±0.1 BPM de fluctuacion.
 */

export function analyzeTiming(features, options = {}) {
  let minBpm = options.minBpm || 60;
  let maxBpm = options.maxBpm || 260;
  const preferIntegerBpm = options.snapBpm !== false;
  const sensitivity = options.sensitivity ?? 0.5;
  const enableRubatoTracking = Boolean(options.rubato);
  let targetBpm = options.bpm || options.targetBpm || null;
  const startAtSec = Math.max(0, Number(options.startAt || options.skipIntro || 0));

  const {
    onsetEnv,
    lowOnsetEnv,
    midOnsetEnv,
    highOnsetEnv,
    onsetEvents,
    frameRate,
    sampleRate,
    hopSize
  } = features;

  const totalDurationSec = (onsetEnv.length * hopSize) / sampleRate;
  const startFrame = Math.min(onsetEnv.length - 1, Math.round(startAtSec * frameRate));

  // Calculo de candidatos globales con discriminacion armonica y asimetria de octava
  // Si el usuario especifico startAtSec, el analisis se enfoca desde el drop/ritmo principal
  const globalBpmEst = estimateWindowBpm(
    onsetEnv,
    lowOnsetEnv,
    onsetEvents,
    startFrame,
    onsetEnv.length,
    frameRate,
    minBpm,
    maxBpm,
    midOnsetEnv
  );

  if (options.doubleBpm) {
    targetBpm = (targetBpm || globalBpmEst.bpm) * 2;
  } else if (options.halfBpm) {
    targetBpm = (targetBpm || globalBpmEst.bpm) * 0.5;
  }

  // 1. Detectar segmentos candidatos de Tempo (o fijar targetBpm si fue especificado por el usuario)
  let rawSegments;
  if (targetBpm) {
    rawSegments = [
      {
        startSec: startAtSec,
        endSec: totalDurationSec,
        roughBpm: targetBpm,
        lockBpm: true,
        confidence: 1.0
      }
    ];
  } else {
    rawSegments = detectTempoSegments(
      onsetEnv,
      lowOnsetEnv,
      midOnsetEnv,
      onsetEvents,
      frameRate,
      totalDurationSec,
      { minBpm, maxBpm, sensitivity, startAtSec }
    );
  }

  // 2. Refinar cada segmento candidato
  const initialRefined = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const refined = refineSegmentTiming(
      seg,
      features,
      { minBpm, maxBpm, preferIntegerBpm, forcedBpm: targetBpm }
    );
    initialRefined.push(refined);
  }

  // 3. Normalizar octavas metricas y polirritmias (1/2x, 2x, 2/3x, 3/2x, 3/4x, 4/3x)
  //    y colapsar variaciones irrelevantes (< 1.2 BPM) hacia el BPM maestro dominante.
  const consolidated = consolidateDominantTempo(initialRefined, features, {
    minBpm,
    maxBpm,
    preferIntegerBpm,
    sensitivity
  });

  // 4. Fusionar segmentos con mismo BPM, verificar si hay algun cambio real de compas (4/4 <-> 3/4)
  //    o reset de fase claro, y opcionalmente rubato si el usuario paso --rubato.
  const structuredSegments = mergeAndSplitAdvancedSegments(consolidated, features, {
    minBpm,
    maxBpm,
    preferIntegerBpm,
    sensitivity,
    enableRubatoTracking
  });

  // 5. Construir la lista final de Uninherited Timing Points (lineas rojas de osu!)
  const timingPoints = buildOsuTimingPoints(structuredSegments, totalDurationSec);

  // 6. Estadisticas globales y Diagnostico para Mappers de osu!
  const primaryPoint = selectPrimaryTimingPoint(timingPoints, totalDurationSec);
  const uniqueBpms = new Set(timingPoints.map((tp) => Math.round(tp.bpm * 10) / 10));
  const uniqueMeters = new Set(timingPoints.map((tp) => tp.meter));
  const hasPhaseResets = timingPoints.some((tp) => tp.changeType === 'phase_reset');
  const hasRubato = timingPoints.some((tp) => tp.changeType === 'rubato_drift');

  const diagnostics = computeMapperDiagnostics(timingPoints, onsetEvents, totalDurationSec);

  // Construir lista estructurada de candidatos de tempo para visualizacion e interactividad
  const candidateList = globalBpmEst.candidates.slice(0, 4).map((c) => ({
    bpm: Math.round(c.bpm * 100) / 100,
    confidence: Math.round(c.score * 100) / 100,
    relation: c.relation
  }));

  if (targetBpm && !candidateList.some((c) => Math.abs(c.bpm - targetBpm) <= 0.25)) {
    candidateList.unshift({
      bpm: Math.round(targetBpm * 100) / 100,
      confidence: 1.0,
      relation: 'Manual / Forzado'
    });
  }

  return {
    durationSec: totalDurationSec,
    isVariableBpm: uniqueBpms.size > 1,
    isVariableMeter: uniqueMeters.size > 1,
    hasPhaseResets,
    hasRubato,
    tempoCharacter: classifyTempoCharacter(uniqueBpms.size, uniqueMeters.size, hasPhaseResets, hasRubato),
    primaryBpm: primaryPoint.bpm,
    initialOffsetMs: timingPoints[0].offsetMs,
    primaryMeter: `${primaryPoint.meter}/4`,
    confidence: primaryPoint.confidence,
    candidates: candidateList,
    diagnostics,
    timingPoints
  };
}

function classifyTempoCharacter(numBpms, numMeters, hasPhaseResets, hasRubato) {
  if (hasRubato) return 'VARIABLE_RUBATO_O_PROGRESIVO';
  if (numBpms > 1 && numMeters > 1) return 'MULTIBPM_Y_MULTICOMPAS';
  if (numBpms > 1) return 'MULTIBPM_SECCIONAL';
  if (numMeters > 1) return 'BPM_CONSTANTE_CON_CAMBIO_DE_COMPAS';
  if (hasPhaseResets) return 'BPM_CONSTANTE_CON_RESET_DE_COMPAS';
  return 'LINEAL_CONSTANTE';
}

/**
 * Calcula un Tempograma Deslizante Hibrido (ACF + IOI) y utiliza Programacion Dinamica (Viterbi)
 * para encontrar las secciones donde realmente cambia el BPM.
 */
function detectTempoSegments(onsetEnv, lowOnsetEnv, midOnsetEnv, onsetEvents, frameRate, totalDurationSec, opts) {
  const { minBpm, maxBpm, sensitivity } = opts;
  const startAtSec = opts.startAtSec || 0.0;
  const initialFrame = Math.round(startAtSec * frameRate);

  if (totalDurationSec - startAtSec < 12.0) {
    const globalBpmEst = estimateWindowBpm(
      onsetEnv,
      lowOnsetEnv,
      onsetEvents,
      initialFrame,
      onsetEnv.length,
      frameRate,
      minBpm,
      maxBpm,
      midOnsetEnv
    );
    return [
      {
        startSec: startAtSec,
        endSec: totalDurationSec,
        roughBpm: globalBpmEst.bpm,
        confidence: globalBpmEst.confidence
      }
    ];
  }

  const winSec = 6.0;
  const stepSec = 1.0;
  const winFrames = Math.round(winSec * frameRate);
  const stepFrames = Math.round(stepSec * frameRate);

  const windows = [];
  for (let startFrame = initialFrame; startFrame + Math.round(frameRate * 3.0) < onsetEnv.length; startFrame += stepFrames) {
    const endFrame = Math.min(onsetEnv.length, startFrame + winFrames);
    const centerSec = ((startFrame + endFrame) * 0.5) / frameRate;

    let energySum = 0;
    for (let i = startFrame; i < endFrame; i++) energySum += onsetEnv[i];
    const meanEnergy = energySum / Math.max(1, endFrame - startFrame);

    const est = estimateWindowBpm(
      onsetEnv,
      lowOnsetEnv,
      onsetEvents,
      startFrame,
      endFrame,
      frameRate,
      minBpm,
      maxBpm,
      midOnsetEnv
    );
    windows.push({
      startFrame,
      endFrame,
      startSec: startFrame / frameRate,
      endSec: endFrame / frameRate,
      centerSec,
      bpm: est.bpm,
      confidence: meanEnergy < 0.008 ? 0.05 : est.confidence,
      candidates: est.candidates,
      meanEnergy
    });
  }

  if (windows.length === 0) {
    const est = estimateWindowBpm(
      onsetEnv,
      lowOnsetEnv,
      onsetEvents,
      initialFrame,
      onsetEnv.length,
      frameRate,
      minBpm,
      maxBpm,
      midOnsetEnv
    );
    return [{ startSec: startAtSec, endSec: totalDurationSec, roughBpm: est.bpm, confidence: est.confidence }];
  }

  const globalEst = estimateWindowBpm(
    onsetEnv,
    lowOnsetEnv,
    onsetEvents,
    initialFrame,
    onsetEnv.length,
    frameRate,
    minBpm,
    maxBpm,
    midOnsetEnv
  );
  const candidatePool = new Set();
  candidatePool.add(Math.round(globalEst.bpm * 2) / 2);
  for (const c of globalEst.candidates) {
    candidatePool.add(Math.round(c.bpm * 2) / 2);
  }
  for (const w of windows) {
    if (w.confidence > 0.25) {
      candidatePool.add(Math.round(w.bpm * 2) / 2);
      for (const c of w.candidates.slice(0, 3)) {
        candidatePool.add(Math.round(c.bpm * 2) / 2);
      }
    }
  }

  const states = Array.from(candidatePool).sort((a, b) => a - b);
  const numWindows = windows.length;
  const numStates = states.length;

  // Penalizacion fuerte contra cambios espurios o saltos polirritmicos (2/3x, 3/2x, 1/2x, 2x)
  const switchPenalty = 2.4 * (1.4 - 0.7 * sensitivity);
  const harmonicPenalty = switchPenalty * 1.45;

  const dp = Array.from({ length: numWindows }, () => new Float64Array(numStates).fill(-Infinity));
  const backptr = Array.from({ length: numWindows }, () => new Int32Array(numStates).fill(0));

  for (let s = 0; s < numStates; s++) {
    dp[0][s] = scoreWindowForBpm(windows[0], states[s]);
  }

  for (let t = 1; t < numWindows; t++) {
    const w = windows[t];
    for (let s = 0; s < numStates; s++) {
      const emission = scoreWindowForBpm(w, states[s]);
      let bestPrevScore = -Infinity;
      let bestPrevState = s;

      for (let p = 0; p < numStates; p++) {
        let transPenalty = 0;
        if (p !== s) {
          const isHarmonic = isHarmonicOrPolyrhythmicRatio(states[s], states[p]);
          if (Math.abs(states[s] - states[p]) <= 1.0) {
            transPenalty = 0.35;
          } else if (isHarmonic) {
            transPenalty = harmonicPenalty;
          } else {
            transPenalty = switchPenalty;
          }
        }
        const candScore = dp[t - 1][p] - transPenalty;
        if (candScore > bestPrevScore) {
          bestPrevScore = candScore;
          bestPrevState = p;
        }
      }

      dp[t][s] = bestPrevScore + emission;
      backptr[t][s] = bestPrevState;
    }
  }

  let bestLastState = 0;
  let bestLastScore = -Infinity;
  for (let s = 0; s < numStates; s++) {
    if (dp[numWindows - 1][s] > bestLastScore) {
      bestLastScore = dp[numWindows - 1][s];
      bestLastState = s;
    }
  }

  const statePath = new Array(numWindows);
  statePath[numWindows - 1] = bestLastState;
  for (let t = numWindows - 1; t > 0; t--) {
    statePath[t - 1] = backptr[t][statePath[t]];
  }

  const rawGroups = [];
  let curGroup = {
    startWin: 0,
    endWin: 0,
    bpms: [states[statePath[0]]],
    confidences: [windows[0].confidence]
  };

  for (let t = 1; t < numWindows; t++) {
    const bpm = states[statePath[t]];
    const prevMeanBpm = curGroup.bpms.reduce((a, b) => a + b, 0) / curGroup.bpms.length;
    if (Math.abs(bpm - prevMeanBpm) <= 1.5) {
      curGroup.endWin = t;
      curGroup.bpms.push(bpm);
      curGroup.confidences.push(windows[t].confidence);
    } else {
      rawGroups.push(curGroup);
      curGroup = {
        startWin: t,
        endWin: t,
        bpms: [bpm],
        confidences: [windows[t].confidence]
      };
    }
  }
  rawGroups.push(curGroup);

  // Filtrar segmentos cortos (< 5 ventanas = ~5 segundos) absorbiendolos en el segmento adyacente
  const filteredGroups = [];
  for (let i = 0; i < rawGroups.length; i++) {
    const g = rawGroups[i];
    const durationWin = g.endWin - g.startWin + 1;
    if (durationWin < 5 && rawGroups.length > 1) {
      if (filteredGroups.length > 0) {
        filteredGroups[filteredGroups.length - 1].endWin = g.endWin;
      } else if (i + 1 < rawGroups.length) {
        rawGroups[i + 1].startWin = g.startWin;
      } else {
        filteredGroups.push(g);
      }
    } else {
      filteredGroups.push(g);
    }
  }

  const segments = [];
  let currentStartSec = startAtSec;

  for (let i = 0; i < filteredGroups.length; i++) {
    const g = filteredGroups[i];
    const roughBpm = median(g.bpms);
    const avgConf = g.confidences.reduce((a, b) => a + b, 0) / g.confidences.length;

    let boundarySec = totalDurationSec;
    if (i < filteredGroups.length - 1) {
      const nextG = filteredGroups[i + 1];
      const nextRoughBpm = median(nextG.bpms);
      const approxBoundarySec = windows[nextG.startWin].centerSec;
      boundarySec = pinpointTempoTransition(
        onsetEnv,
        onsetEvents,
        frameRate,
        approxBoundarySec,
        roughBpm,
        nextRoughBpm,
        currentStartSec,
        totalDurationSec
      );
    }

    segments.push({
      startSec: currentStartSec,
      endSec: boundarySec,
      roughBpm,
      confidence: avgConf
    });
    currentStartSec = boundarySec;
  }

  return segments;
}

/**
 * Comprueba si dos BPMs estan en relacion armonica o polirritmica comun:
 * - 2:1 o 1:2 (doble / mitad de tempo)
 * - 3:2 o 2:3 (tresillo de blanca / polirritmia 3 contra 2, ej: 231 BPM <-> 154 BPM)
 * - 4:3 o 3:4 (polirritmia 4 contra 3)
 */
function isHarmonicOrPolyrhythmicRatio(bpmA, bpmB) {
  const ratio = bpmA / bpmB;
  const commonRatios = [0.5, 2.0, 2.0 / 3.0, 1.5, 0.75, 4.0 / 3.0];
  for (const r of commonRatios) {
    if (Math.abs(ratio - r) <= 0.025) {
      return true;
    }
  }
  return false;
}

function scoreWindowForBpm(win, targetBpm) {
  if (win.meanEnergy < 0.008) {
    return 0.0;
  }
  let bestScore = 0;
  for (const cand of win.candidates) {
    const diff = Math.abs(cand.bpm - targetBpm);
    if (diff < 3.5) {
      const weight = Math.exp(-(diff * diff) / (2 * 1.1 * 1.1));
      const s = cand.score * weight;
      if (s > bestScore) bestScore = s;
    }
  }
  return bestScore;
}

/**
 * Estima el BPM combinando:
 * 1. Autocorrelacion Espectral con Filtro Peine Armonico (1x, 2x, 3x, 4x, 1/2x)
 * 2. Histograma de Intervalos Entre Ataques (IOI - Inter-Onset Interval Histogram)
 */
function estimateWindowBpm(
  onsetEnv,
  lowOnsetEnv,
  onsetEvents,
  startFrame,
  endFrame,
  frameRate,
  minBpm,
  maxBpm,
  midOnsetEnv
) {
  const len = endFrame - startFrame;
  const minLag = Math.max(2, Math.floor((60.0 * frameRate) / maxBpm));
  const maxLag = Math.min(Math.floor(len * 0.65), Math.ceil((60.0 * frameRate) / minBpm));

  if (maxLag <= minLag) {
    return { bpm: 120, confidence: 0.1, candidates: [{ bpm: 120, score: 0.1, relation: 'Fallback' }] };
  }

  const maxHarmonicLag = Math.min(len - 1, maxLag * 4);
  const acf = new Float64Array(maxHarmonicLag + 1);

  // Señal rítmica ponderada: Graves (bombo/bajo) y Medios (caja) comandan el pulso musical
  // Atenuamos agudos para que el hi-hat continuo no duplique el tempo
  const rhythmSignal = new Float32Array(len);
  let norm0 = 0;
  for (let i = 0; i < len; i++) {
    const fIdx = startFrame + i;
    const l = lowOnsetEnv ? lowOnsetEnv[fIdx] : 0;
    const m = midOnsetEnv ? midOnsetEnv[fIdx] : 0;
    const t = onsetEnv[fIdx] || 0;
    const v = l * 2.5 + m * 1.4 + t * 0.35;
    rhythmSignal[i] = v;
    norm0 += v * v;
  }

  if (norm0 < 1e-8) {
    return { bpm: 120, confidence: 0.0, candidates: [{ bpm: 120, score: 0.0, relation: 'Sin energia' }] };
  }

  for (let lag = minLag >> 1; lag <= maxHarmonicLag; lag++) {
    let sum = 0;
    const limit = len - lag;
    for (let i = 0; i < limit; i++) {
      sum += rhythmSignal[i] * rhythmSignal[i + lag];
    }
    acf[lag] = sum / Math.max(1, limit);
  }

  const startSec = startFrame / frameRate;
  const endSec = endFrame / frameRate;
  const winEvents = onsetEvents
    ? onsetEvents.filter((e) => e.timeSec >= startSec && e.timeSec <= endSec && (e.strength > 0.06 || e.lowStrength > 0.08))
    : [];

  const stepBpm = 0.5;
  const numBpmSteps = Math.floor((maxBpm - minBpm) / stepBpm) + 1;
  const ioiHist = new Float64Array(numBpmSteps);

  if (winEvents.length >= 4) {
    for (let i = 0; i < winEvents.length; i++) {
      const eA = winEvents[i];
      for (let j = i + 1; j < Math.min(winEvents.length, i + 14); j++) {
        const eB = winEvents[j];
        const dt = eB.timeSec - eA.timeSec;
        if (dt < 0.16) continue;
        if (dt > 2.6) break;

        const pairWeight = (eA.lowStrength * 2.2 + eA.midStrength * 1.2 + 0.1) *
                           (eB.lowStrength * 2.2 + eB.midStrength * 1.2 + 0.1);

        for (const mult of [1.0, 2.0, 4.0, 0.5, 3.0 / 2.0, 2.0 / 3.0]) {
          const impliedBpm = (60.0 * mult) / dt;
          if (impliedBpm >= minBpm && impliedBpm <= maxBpm) {
            const mWeight = mult === 1.0 ? 1.0 : mult === 2.0 ? 0.6 : mult === 0.5 ? 0.45 : 0.3;
            const centerIdx = Math.round((impliedBpm - minBpm) / stepBpm);
            for (let k = -2; k <= 2; k++) {
              const idx = centerIdx + k;
              if (idx >= 0 && idx < numBpmSteps) {
                const g = Math.exp(-0.5 * k * k);
                ioiHist[idx] += pairWeight * mWeight * g;
              }
            }
          }
        }
      }
    }
  }

  let maxIoi = 1e-9;
  for (let i = 0; i < numBpmSteps; i++) {
    if (ioiHist[i] > maxIoi) maxIoi = ioiHist[i];
  }

  const scores = new Float64Array(numBpmSteps);
  let maxScore = 1e-9;

  for (let idx = 0; idx < numBpmSteps; idx++) {
    const bpm = minBpm + idx * stepBpm;
    const exactLag = (60.0 * frameRate) / bpm;

    const e1 = sampleLagInterpolated(acf, exactLag);
    const e2 = sampleLagInterpolated(acf, exactLag * 2.0);
    const e3 = sampleLagInterpolated(acf, exactLag * 3.0);
    const e4 = sampleLagInterpolated(acf, exactLag * 4.0);
    const eHalf = sampleLagInterpolated(acf, exactLag * 0.5);

    // Prior perceptual centrado en 140 BPM con dispersion natural (90 - 220 BPM)
    const logDiff = Math.log2(bpm / 140.0);
    const perceptualPrior = Math.exp(-(logDiff * logDiff) / (2 * 0.58 * 0.58));

    // Armonicos: e1 (lag fundamental), e2 (2 beats), e3 (3 beats), e4 (compas completo)
    const acfScore = 1.20 * e1 + 0.80 * e2 + 0.35 * e3 + 0.50 * e4 + 0.08 * eHalf;
    const normIoi = ioiHist[idx] / maxIoi;

    const combScore = acfScore * (1.0 + 0.38 * normIoi) * (0.50 + 0.50 * perceptualPrior);
    scores[idx] = combScore;
    if (combScore > maxScore) maxScore = combScore;
  }

  const rawCandidates = [];
  for (let idx = 1; idx < numBpmSteps - 1; idx++) {
    if (scores[idx] >= scores[idx - 1] && scores[idx] >= scores[idx + 1]) {
      const bpm = minBpm + idx * stepBpm;
      const normScore = scores[idx] / maxScore;
      if (normScore > 0.15) {
        rawCandidates.push({ bpm, score: normScore, rawScore: scores[idx] });
      }
    }
  }

  rawCandidates.sort((a, b) => b.score - a.score);
  if (rawCandidates.length === 0) {
    return { bpm: 120, confidence: 0.1, candidates: [{ bpm: 120, score: 0.1, relation: 'Fallback' }] };
  }

  // Desempate de armónicos y discriminación de octava vía asimetría de compás (Even vs Odd Beats)
  const evaluatedCandidates = [];
  for (const cand of rawCandidates.slice(0, 6)) {
    let finalScore = cand.score;
    if (winEvents.length >= 6) {
      const asym = computeOctaveAsymmetry(winEvents, cand.bpm, startSec, endSec);
      if (asym.maxAsymmetry > 1.70 && cand.bpm * 0.5 >= minBpm) {
        // Los beats impares están casi vacíos de bombo/bajo: es un falso doble de tempo
        finalScore *= Math.max(0.40, 1.0 / (asym.maxAsymmetry * 0.75));
      }
    }
    evaluatedCandidates.push({
      bpm: cand.bpm,
      score: finalScore,
      rawScore: cand.rawScore,
      relation: 'Fundamental'
    });
  }

  evaluatedCandidates.sort((a, b) => b.score - a.score);
  const winningBpm = evaluatedCandidates[0].bpm;

  // Clasificar relaciones
  for (let i = 0; i < evaluatedCandidates.length; i++) {
    const c = evaluatedCandidates[i];
    if (i === 0) {
      c.relation = 'Fundamental';
      continue;
    }
    const ratio = c.bpm / winningBpm;
    if (Math.abs(ratio - 2.0) <= 0.04) {
      c.relation = 'Doble Tempo (x2)';
    } else if (Math.abs(ratio - 0.5) <= 0.02) {
      c.relation = 'Mitad de Tempo (/2)';
    } else if (Math.abs(ratio - 1.5) <= 0.035) {
      c.relation = 'Polirritmia (3:2 / Tresillo)';
    } else if (Math.abs(ratio - 2.0 / 3.0) <= 0.035) {
      c.relation = 'Polirritmia (2:3)';
    } else if (Math.abs(ratio - 4.0 / 3.0) <= 0.035) {
      c.relation = 'Polirritmia (4:3)';
    } else if (Math.abs(ratio - 0.75) <= 0.035) {
      c.relation = 'Polirritmia (3:4)';
    } else {
      c.relation = 'Alternativa';
    }
  }

  const meanScore = scores.reduce((a, b) => a + b, 0) / numBpmSteps;
  const prominence = Math.min(1.0, Math.max(0.1, (maxScore - meanScore) / (maxScore + 1e-9)));

  return {
    bpm: evaluatedCandidates[0].bpm,
    confidence: prominence,
    candidates: evaluatedCandidates.slice(0, 6)
  };
}

function computeOctaveAsymmetry(events, bpm, startSec, endSec) {
  const period = 60.0 / bpm;
  if (!events || events.length === 0 || period <= 0) {
    return { maxAsymmetry: 1.0, meanEven: 1, meanOdd: 1 };
  }

  const res = evaluateExactBpmAndPhase(events, startSec, endSec, bpm);
  const phaseSec = res.phaseSec;
  const tol = Math.min(0.040, period * 0.22);

  let evenBass = 0, evenCount = 0;
  let oddBass = 0, oddCount = 0;

  for (let t = phaseSec; t <= endSec - tol; t += period) {
    if (t < startSec) continue;
    const beatIdx = Math.round((t - phaseSec) / period);
    const isEven = beatIdx % 2 === 0;

    let maxBass = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const dt = Math.abs(ev.timeSec - t);
      if (dt <= tol) {
        const bass = ev.lowStrength * 2.5 + ev.midStrength * 1.2;
        if (bass > maxBass) maxBass = bass;
      }
    }

    if (isEven) {
      evenBass += maxBass;
      evenCount++;
    } else {
      oddBass += maxBass;
      oddCount++;
    }
  }

  const meanEven = evenCount > 0 ? evenBass / evenCount : 0;
  const meanOdd = oddCount > 0 ? oddBass / oddCount : 0;
  const ratio1 = (meanEven + 0.02) / (meanOdd + 0.02);
  const ratio2 = (meanOdd + 0.02) / (meanEven + 0.02);
  return { maxAsymmetry: Math.max(ratio1, ratio2), meanEven, meanOdd };
}

function sampleLagInterpolated(arr, floatIndex) {
  const idx = Math.floor(floatIndex);
  const frac = floatIndex - idx;
  if (idx < 1 || idx + 1 >= arr.length) return 0;
  const vCenter = arr[idx] * (1 - frac) + arr[idx + 1] * frac;
  const vLeft = arr[idx - 1];
  const vRight = idx + 2 < arr.length ? arr[idx + 2] : arr[idx + 1];
  return Math.max(vCenter, 0.75 * vLeft, 0.75 * vRight);
}

function pinpointTempoTransition(
  onsetEnv,
  onsetEvents,
  frameRate,
  approxBoundarySec,
  bpmA,
  bpmB,
  minSec,
  maxSec
) {
  const searchRadiusSec = 4.0;
  const searchStart = Math.max(minSec + 1.5, approxBoundarySec - searchRadiusSec);
  const searchEnd = Math.min(maxSec - 1.5, approxBoundarySec + searchRadiusSec);

  const candidateEvents = onsetEvents.filter(
    (ev) => ev.timeSec >= searchStart && ev.timeSec <= searchEnd && ev.strength > 0.12
  );

  if (candidateEvents.length === 0) {
    return approxBoundarySec;
  }

  const periodA = 60.0 / bpmA;
  const periodB = 60.0 / bpmB;

  let bestTimeSec = approxBoundarySec;
  let bestScore = -Infinity;

  for (const ev of candidateEvents) {
    const t0 = ev.timeSec;

    let scoreBefore = 0;
    for (let k = 1; k <= 8; k++) {
      const tBack = t0 - k * periodA;
      if (tBack < minSec) break;
      const fIdx = Math.round(tBack * frameRate);
      if (fIdx >= 0 && fIdx < onsetEnv.length) {
        scoreBefore += getLocalFrameEnergy(onsetEnv, fIdx);
      }
    }

    let scoreAfter = 0;
    for (let k = 0; k <= 8; k++) {
      const tFwd = t0 + k * periodB;
      if (tFwd > maxSec) break;
      const fIdx = Math.round(tFwd * frameRate);
      if (fIdx >= 0 && fIdx < onsetEnv.length) {
        scoreAfter += getLocalFrameEnergy(onsetEnv, fIdx);
      }
    }

    const downbeatBonus = ev.lowStrength * 0.8 + ev.strength * 0.5;
    const totalScore = scoreBefore + scoreAfter + downbeatBonus;

    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestTimeSec = t0;
    }
  }

  return bestTimeSec;
}

function getLocalFrameEnergy(env, fIdx) {
  const center = Math.max(0, Math.min(env.length - 1, fIdx - 1));
  const a = Math.max(0, center - 3);
  const b = Math.min(env.length - 1, center + 3);
  let maxV = 0;
  for (let i = a; i <= b; i++) {
    if (env[i] > maxV) maxV = env[i];
  }
  return maxV;
}

function refineSegmentTiming(seg, features, opts) {
  const { onsetEnv, lowOnsetEnv, midOnsetEnv, highOnsetEnv, onsetEvents, frameRate } = features;
  const { minBpm, maxBpm, preferIntegerBpm } = opts;

  const startFrame = Math.max(0, Math.floor(seg.startSec * frameRate));
  const endFrame = Math.min(onsetEnv.length, Math.ceil(seg.endSec * frameRate));
  const segEvents = onsetEvents.filter((e) => e.timeSec >= seg.startSec - 0.05 && e.timeSec <= seg.endSec + 0.05);

  const segEst = estimateWindowBpm(
    onsetEnv,
    lowOnsetEnv,
    onsetEvents,
    startFrame,
    endFrame,
    frameRate,
    minBpm,
    maxBpm,
    midOnsetEnv
  );

  // Si se solicita forzar un BPM especifico (ej. al consolidar con el BPM dominante de la cancion o eleccion del usuario),
  // evaluar directamente ese BPM sin saltar a otros candidatos
  const isForced = Boolean(seg.lockBpm || opts.forcedBpm);
  const baseCandidates = new Set();
  if (isForced) {
    baseCandidates.add(opts.forcedBpm || seg.roughBpm);
  } else {
    baseCandidates.add(seg.roughBpm);
    baseCandidates.add(segEst.bpm);
    if (seg.roughBpm > 205 && seg.roughBpm * 0.5 >= minBpm) {
      baseCandidates.add(seg.roughBpm * 0.5);
    }
    for (const c of segEst.candidates.slice(0, 4)) {
      baseCandidates.add(c.bpm);
      if (c.bpm > 205 && c.bpm * 0.5 >= minBpm) {
        baseCandidates.add(c.bpm * 0.5);
      }
    }
  }

  let bestBpm = isForced ? (opts.forcedBpm || seg.roughBpm) : seg.roughBpm;
  let bestPhaseSec = 0;
  let bestFitScore = -Infinity;

  if (isForced) {
    const res = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, bestBpm);
    bestPhaseSec = res.phaseSec;
    bestFitScore = res.score;
  } else {
    for (const centerBpm of baseCandidates) {
      const searchSpan = 2.5;
      const coarseResult = searchBpmRange(
        segEvents,
        seg.startSec,
        seg.endSec,
        centerBpm - searchSpan,
        centerBpm + searchSpan,
        0.1,
        minBpm,
        maxBpm
      );
      const fineResult = searchBpmRange(
        segEvents,
        seg.startSec,
        seg.endSec,
        coarseResult.bpm - 0.25,
        coarseResult.bpm + 0.25,
        0.01,
        minBpm,
        maxBpm
      );

      const logDiff = Math.log2(fineResult.bpm / 140.0);
      const priorWeight = 0.6 + 0.4 * Math.exp(-(logDiff * logDiff) / (2 * 0.55 * 0.55));
      const totalScore = fineResult.score * priorWeight;

      if (totalScore > bestFitScore) {
        bestFitScore = totalScore;
        bestBpm = fineResult.bpm;
        bestPhaseSec = fineResult.phaseSec;
      }
    }

    const regressed = refineBpmViaLinearRegression(segEvents, bestBpm, bestPhaseSec, seg.startSec, seg.endSec);
    if (regressed.valid) {
      const regCheck = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, regressed.bpm);
      if (regCheck.score >= bestFitScore * 0.98) {
        bestBpm = regressed.bpm;
        bestPhaseSec = regCheck.phaseSec;
        bestFitScore = Math.max(bestFitScore, regCheck.score);
      }
    }
  }

  // En osu!, las canciones masterizadas digitalmente usan BPM entero (.0) o medio entero (.5).
  if (!isForced && preferIntegerBpm) {
    const nearestInt = Math.round(bestBpm);
    const nearestHalf = Math.round(bestBpm * 2) / 2;

    if (Math.abs(bestBpm - nearestInt) <= 0.42) {
      const intCheck = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, nearestInt);
      const rawCurrent = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, bestBpm);
      if (intCheck.score >= rawCurrent.score * 0.93) {
        bestBpm = nearestInt;
        bestPhaseSec = intCheck.phaseSec;
      }
    } else if (Math.abs(bestBpm - nearestHalf) <= 0.22) {
      const halfCheck = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, nearestHalf);
      const rawCurrent = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, bestBpm);
      if (halfCheck.score >= rawCurrent.score * 0.95) {
        bestBpm = nearestHalf;
        bestPhaseSec = halfCheck.phaseSec;
      }
    }
  }

  bestBpm = Math.round(bestBpm * 100) / 100;

  const beatPeriodSec = 60.0 / bestBpm;
  const beats = buildBeatGridForSegment(
    seg.startSec,
    seg.endSec,
    bestPhaseSec,
    beatPeriodSec,
    onsetEnv,
    lowOnsetEnv,
    midOnsetEnv,
    highOnsetEnv,
    segEvents,
    frameRate
  );

  const meterInfo = detectMeterAndDownbeat(beats, beatPeriodSec);

  const offsetMs = computeOsuAlignedOffsetMs(
    seg.startSec,
    beats,
    meterInfo.downbeatIndex,
    meterInfo.meter,
    beatPeriodSec,
    segEvents
  );

  const driftStats = computeSegmentDriftStats(beats);

  return {
    startSec: seg.startSec,
    endSec: seg.endSec,
    bpm: bestBpm,
    offsetMs,
    meter: meterInfo.meter,
    meterConfidence: meterInfo.confidence,
    confidence: Math.min(0.99, Math.max(0.35, seg.confidence * 0.55 + meterInfo.gridFit * 0.45)),
    beats,
    downbeatIndex: meterInfo.downbeatIndex,
    driftRmseMs: driftStats.rmseMs,
    maxDriftMs: driftStats.maxAbsMs,
    changeType: seg.changeType || 'tempo_change'
  };
}

function refineBpmViaLinearRegression(events, initialBpm, initialPhaseSec, startSec, endSec) {
  if (events.length < 8) {
    return { valid: false, bpm: initialBpm, phaseSec: initialPhaseSec };
  }

  const period = 60.0 / initialBpm;
  const matched = [];

  for (const ev of events) {
    const w = ev.lowStrength * 2.5 + ev.midStrength * 1.2 + ev.strength * 0.8;
    if (w < 0.2) continue;
    const k = Math.round((ev.timeSec - initialPhaseSec) / period);
    const predSec = initialPhaseSec + k * period;
    const residualSec = ev.timeSec - predSec;

    if (Math.abs(residualSec) <= 0.028) {
      matched.push({ k, timeSec: ev.timeSec, weight: w });
    }
  }

  if (matched.length < 6) {
    return { valid: false, bpm: initialBpm, phaseSec: initialPhaseSec };
  }

  const kSpan = matched[matched.length - 1].k - matched[0].k;
  if (kSpan < 10) {
    return { valid: false, bpm: initialBpm, phaseSec: initialPhaseSec };
  }

  let intercept = initialPhaseSec;
  let slope = period;
  const huberDelta = 0.012;

  for (let iter = 0; iter < 4; iter++) {
    let sumW = 0;
    let sumWK = 0;
    let sumWT = 0;
    let sumWKK = 0;
    let sumWKT = 0;

    for (const pt of matched) {
      const err = Math.abs(pt.timeSec - (intercept + slope * pt.k));
      const huberW = err <= huberDelta ? 1.0 : huberDelta / err;
      const w = pt.weight * huberW;

      sumW += w;
      sumWK += w * pt.k;
      sumWT += w * pt.timeSec;
      sumWKK += w * pt.k * pt.k;
      sumWKT += w * pt.k * pt.timeSec;
    }

    const denom = sumW * sumWKK - sumWK * sumWK;
    if (Math.abs(denom) < 1e-9) break;

    slope = (sumW * sumWKT - sumWK * sumWT) / denom;
    intercept = (sumWT - slope * sumWK) / sumW;
  }

  const newBpm = 60.0 / slope;
  if (Math.abs(newBpm - initialBpm) > 1.5) {
    return { valid: false, bpm: initialBpm, phaseSec: initialPhaseSec };
  }

  return {
    valid: true,
    bpm: newBpm,
    phaseSec: intercept
  };
}

/**
 * Consolida el tempo dominante de la cancion para eliminar el "falso Multi-BPM":
 * 1. Agrupa los segmentos por familia de BPM (dentro de +-1.2 BPM).
 * 2. Si existe un BPM dominante (ej. 231 BPM que cubre la mayor parte de la cancion):
 *    - Cualquier segmento cercano (ej. 230.81, 231.01, 231.23) se unifica exactamente al BPM dominante (231 BPM).
 *    - Cualquier segmento corto (< 15s) que caiga en una relacion polirritmica o sub-armonica del BPM dominante
 *      (por ejemplo 154 BPM = 2/3 de 231 BPM, tresillo de blanca en un puente; o 115.5 BPM = 1/2 de 231 BPM)
 *      se evalua contra el BPM dominante y se absorbe si encaja razonablemente.
 */
function consolidateDominantTempo(segments, features, opts) {
  if (segments.length <= 1) return segments;

  const totalDur = segments[segments.length - 1].endSec - segments[0].startSec;

  // Encontrar el cluster de BPM con mayor duracion acumulada
  const clusters = [];
  for (const seg of segments) {
    const dur = seg.endSec - seg.startSec;
    let found = null;
    for (const cl of clusters) {
      if (Math.abs(cl.centerBpm - seg.bpm) <= 1.25) {
        found = cl;
        break;
      }
    }
    if (found) {
      found.totalDur += dur;
      found.segs.push(seg);
      // Actualizar centro ponderado por duracion y preferir entero si ya hay uno entero largo
      const intSeg = found.segs.find((s) => Number.isInteger(s.bpm) && s.endSec - s.startSec >= 10);
      if (intSeg) {
        found.centerBpm = intSeg.bpm;
      } else {
        found.centerBpm = Math.round(
          found.segs.reduce((acc, s) => acc + s.bpm * (s.endSec - s.startSec), 0) / found.totalDur
        );
      }
    } else {
      clusters.push({
        centerBpm: opts.preferIntegerBpm ? Math.round(seg.bpm) : seg.bpm,
        totalDur: dur,
        segs: [seg]
      });
    }
  }

  clusters.sort((a, b) => b.totalDur - a.totalDur);
  const dominantCluster = clusters[0];
  const dominantBpm = dominantCluster.centerBpm;
  const dominantShare = dominantCluster.totalDur / Math.max(1, totalDur);

  const normalized = [];
  for (const seg of segments) {
    const segDur = seg.endSec - seg.startSec;
    const diffToDom = Math.abs(seg.bpm - dominantBpm);

    // Caso 1: Es basicamente el mismo BPM o una ligera fluctuacion (< 1.5 BPM) -> unificar al BPM dominante
    if (diffToDom <= 1.5) {
      normalized.push(
        refineSegmentTiming(
          {
            startSec: seg.startSec,
            endSec: seg.endSec,
            roughBpm: dominantBpm,
            lockBpm: true,
            confidence: seg.confidence
          },
          features,
          opts
        )
      );
      continue;
    }

    // Caso 2: Seccion corta (< 25s) con desviacion moderada de tempo (< 4.5 BPM, como 163 vs 160)
    // producida por caida de bajo/bombo (breakdown, puente vocal, solo de guitarra o intro).
    // En grabaciones de estudio, una cancion de 160 BPM no cambia a 163 BPM por 12 segundos y vuelve a 160.
    if (dominantShare >= 0.60 && segDur < 25.0 && diffToDom <= 4.5) {
      const segEvents = features.onsetEvents.filter(
        (e) => e.timeSec >= seg.startSec - 0.05 && e.timeSec <= seg.endSec + 0.05
      );
      const evalCurrent = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, seg.bpm);
      const evalDom = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, dominantBpm);

      if (evalDom.score >= evalCurrent.score * 0.60 || segEvents.length < 16) {
        normalized.push(
          refineSegmentTiming(
            {
              startSec: seg.startSec,
              endSec: seg.endSec,
              roughBpm: dominantBpm,
              lockBpm: true,
              confidence: seg.confidence
            },
            features,
            opts
          )
        );
        continue;
      }
    }

    // Caso 2: Esta en relacion polirritmica o de octava con el BPM dominante (ej. 154 BPM = 2/3 de 231 BPM)
    const isHarmonic = isHarmonicOrPolyrhythmicRatio(seg.bpm, dominantBpm);
    if (isHarmonic) {
      const segEvents = features.onsetEvents.filter(
        (e) => e.timeSec >= seg.startSec - 0.05 && e.timeSec <= seg.endSec + 0.05
      );
      const evalCurrent = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, seg.bpm);
      const evalDom = evaluateExactBpmAndPhase(segEvents, seg.startSec, seg.endSec, dominantBpm);

      // Si el BPM dominante cubre > 55% de la cancion y este segmento dura menos de 14s (un puente o breakdown),
      // o si el ajuste en la rejilla dominante es >= 75% del ajuste polirritmico, mantener el BPM dominante
      const thresholdRatio = dominantShare > 0.6 && segDur < 14.0 ? 0.65 : 0.84;
      if (evalDom.score >= evalCurrent.score * thresholdRatio) {
        normalized.push(
          refineSegmentTiming(
            {
              startSec: seg.startSec,
              endSec: seg.endSec,
              roughBpm: dominantBpm,
              lockBpm: true,
              confidence: seg.confidence
            },
            features,
            opts
          )
        );
        continue;
      }
    }

    normalized.push(seg);
  }

  return normalized;
}

function searchBpmRange(events, startSec, endSec, lowBpm, highBpm, stepBpm, minBpm, maxBpm) {
  const fromBpm = Math.max(minBpm, lowBpm);
  const toBpm = Math.min(maxBpm, highBpm);

  let bestBpm = fromBpm;
  let bestScore = -Infinity;
  let bestPhaseSec = 0;

  for (let bpm = fromBpm; bpm <= toBpm + 1e-6; bpm += stepBpm) {
    const res = evaluateExactBpmAndPhase(events, startSec, endSec, bpm);
    if (res.score > bestScore) {
      bestScore = res.score;
      bestBpm = bpm;
      bestPhaseSec = res.phaseSec;
    }
  }

  return { bpm: bestBpm, score: bestScore, phaseSec: bestPhaseSec };
}

function evaluateExactBpmAndPhase(events, startSec, endSec, bpm) {
  if (events.length === 0) {
    return { score: 0, phaseSec: startSec };
  }

  const period = 60.0 / bpm;
  const twoPiOverT = (2.0 * Math.PI) / period;

  let cos1 = 0;
  let sin1 = 0;
  let cos2 = 0;
  let sin2 = 0;
  let weightSum = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const w = Math.pow(ev.strength, 2) + 2.5 * Math.pow(ev.lowStrength, 2);
    const angle = twoPiOverT * (ev.timeSec - startSec);
    cos1 += w * Math.cos(angle);
    sin1 += w * Math.sin(angle);
    cos2 += w * Math.cos(2.0 * angle);
    sin2 += w * Math.sin(2.0 * angle);
    weightSum += w;
  }

  if (weightSum < 1e-9) {
    return { score: 0, phaseSec: startSec };
  }

  const mag1 = Math.sqrt(cos1 * cos1 + sin1 * sin1) / weightSum;
  const mag2 = Math.sqrt(cos2 * cos2 + sin2 * sin2) / weightSum;

  let meanAngle = Math.atan2(sin1, cos1);
  if (meanAngle < 0) meanAngle += 2.0 * Math.PI;
  const rawPhaseOffset = (meanAngle / (2.0 * Math.PI)) * period;
  const phaseSec = startSec + rawPhaseOffset;

  const sigma = 0.018;
  let bestPhaseCandidate = phaseSec;
  let bestPulseScore = -Infinity;

  for (let k = 0; k < 16; k++) {
    const frac = k / 16.0;
    const candPhase = phaseSec + period * frac;
    let candScore = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const w = ev.lowStrength * 3.0 + ev.midStrength * 1.5 + ev.strength * 0.5 - ev.highStrength * 0.35;
      if (w <= 0) continue;
      const rel = (ev.timeSec - candPhase) / period;
      const dist = (rel - Math.round(rel)) * period;
      candScore += w * Math.exp(-(dist * dist) / (2 * sigma * sigma));
    }
    if (candScore > bestPulseScore) {
      bestPulseScore = candScore;
      bestPhaseCandidate = candPhase;
    }
  }

  const normPulseScore = bestPulseScore / weightSum;
  const combinedScore = normPulseScore * 0.7 + (mag1 + 0.35 * mag2) * 0.3;
  return {
    score: combinedScore,
    phaseSec: bestPhaseCandidate
  };
}

function buildBeatGridForSegment(
  startSec,
  endSec,
  phaseSec,
  beatPeriodSec,
  onsetEnv,
  lowOnsetEnv,
  midOnsetEnv,
  highOnsetEnv,
  segEvents,
  frameRate
) {
  let firstActiveTime = startSec;
  if (segEvents.length > 0) {
    const firstStrong = segEvents.find((e) => e.timeSec >= startSec && (e.strength > 0.15 || e.lowStrength > 0.12));
    if (firstStrong && firstStrong.timeSec < startSec + 8.0) {
      firstActiveTime = Math.max(startSec, firstStrong.timeSec - beatPeriodSec * 0.25);
    }
  }

  let firstBeatSec = phaseSec;
  while (firstBeatSec - beatPeriodSec >= firstActiveTime) {
    firstBeatSec -= beatPeriodSec;
  }
  while (firstBeatSec < firstActiveTime) {
    firstBeatSec += beatPeriodSec;
  }

  const beats = [];
  for (let t = firstBeatSec; t <= endSec + 0.02; t += beatPeriodSec) {
    let nearestEv = null;
    let minDiff = 0.04;
    for (const ev of segEvents) {
      const d = Math.abs(ev.timeSec - t);
      if (d < minDiff) {
        minDiff = d;
        nearestEv = ev;
      }
    }

    const fIdx = Math.round(t * frameRate - 1.44);
    const low = nearestEv
      ? Math.max(nearestEv.lowStrength, getLocalFrameEnergy(lowOnsetEnv, fIdx))
      : getLocalFrameEnergy(lowOnsetEnv, fIdx) * 0.3;
    const mid = nearestEv
      ? Math.max(nearestEv.midStrength, getLocalFrameEnergy(midOnsetEnv, fIdx))
      : getLocalFrameEnergy(midOnsetEnv, fIdx) * 0.3;
    const high = nearestEv
      ? Math.max(nearestEv.highStrength, getLocalFrameEnergy(highOnsetEnv, fIdx))
      : getLocalFrameEnergy(highOnsetEnv, fIdx) * 0.3;
    const total = nearestEv
      ? Math.max(nearestEv.strength, getLocalFrameEnergy(onsetEnv, fIdx))
      : getLocalFrameEnergy(onsetEnv, fIdx) * 0.3;

    beats.push({
      timeSec: t,
      exactOnsetSec: nearestEv ? nearestEv.timeSec : null,
      total,
      low,
      mid,
      high,
      accentScore: low * 2.0 + total * 1.0 - mid * 0.3
    });
  }

  return beats;
}

/**
 * Identifica el Compas (Time Signature: 4/4, 3/4, 6/4, 5/4, 7/4) y la fase del Downbeat (Tiempo 1).
 * Utiliza priors estrictos a favor de 4/4 y 3/4 para evitar que sincopas de rock/pop/anime
 * produzcan falsos positivos de 5/4 o 7/4.
 */
function detectMeterAndDownbeat(beats, beatPeriodSec) {
  const numBeats = beats.length;
  if (numBeats < 4) {
    return { meter: 4, downbeatIndex: 0, confidence: 0.5, gridFit: 0.5 };
  }

  const candidateMeters = [4, 3, 6, 5, 7];

  const rawProfile = new Float64Array(numBeats);
  let meanVal = 0;
  for (let i = 0; i < numBeats; i++) {
    const v = beats[i].low * 2.5 + beats[i].total * 1.0 - beats[i].mid * 0.25;
    rawProfile[i] = v;
    meanVal += v;
  }
  meanVal /= numBeats;

  const centered = new Float64Array(numBeats);
  let variance = 0;
  for (let i = 0; i < numBeats; i++) {
    centered[i] = rawProfile[i] - meanVal;
    variance += centered[i] * centered[i];
  }
  variance = Math.max(1e-9, variance / numBeats);
  const stdDev = Math.sqrt(variance);

  let bestMeter = 4;
  let bestDownbeatIdx = 0;
  let bestMeterScore = -Infinity;

  for (const M of candidateMeters) {
    if (numBeats < M * 2) continue;

    const posMeans = new Float64Array(M);
    const posCounts = new Int32Array(M);

    for (let i = 0; i < numBeats; i++) {
      if (beats[i].total < 0.04) continue;
      const p = i % M;
      posMeans[p] += rawProfile[i];
      posCounts[p]++;
    }
    for (let p = 0; p < M; p++) {
      posMeans[p] = posCounts[p] > 0 ? posMeans[p] / posCounts[p] : meanVal;
    }

    let betweenVar = 0;
    for (let p = 0; p < M; p++) {
      const d = posMeans[p] - meanVal;
      betweenVar += d * d;
    }
    betweenVar = (betweenVar / M) / variance;

    let corrM = 0;
    let countM = 0;
    for (let i = 0; i + M < numBeats; i++) {
      corrM += centered[i] * centered[i + M];
      countM++;
    }
    corrM = countM > 0 ? corrM / (countM * variance) : 0;

    let bestPhaseForM = 0;
    let maxPhaseScore = -Infinity;

    for (let phase = 0; phase < M; phase++) {
      const b1 = posMeans[phase];
      let otherSum = 0;
      for (let k = 1; k < M; k++) {
        otherSum += posMeans[(phase + k) % M];
      }
      const otherMean = otherSum / (M - 1);
      let phaseScore = (b1 - otherMean) / stdDev;

      if (M === 4) {
        const b3 = posMeans[(phase + 2) % 4];
        const b24 = 0.5 * (posMeans[(phase + 1) % 4] + posMeans[(phase + 3) % 4]);
        if (b3 > b24) {
          phaseScore += 0.25 * ((b3 - b24) / stdDev);
        }
      }

      if (M === 6) {
        const b4 = posMeans[(phase + 3) % 6];
        if (Math.abs(b1 - b4) < 0.25 * stdDev) {
          phaseScore -= 0.85;
        }
      }

      if (phaseScore > maxPhaseScore) {
        maxPhaseScore = phaseScore;
        bestPhaseForM = phase;
      }
    }

    // Priors estrictos: 4/4 y 3/4 son casi universales en osu!;
    // 6/4, 5/4 y 7/4 requieren evidencia abrumadora para superar a 4/4.
    const priors = {
      4: 1.0,
      3: 0.95,
      6: 0.38,
      5: 0.35,
      7: 0.32
    };

    const rawScore = (betweenVar * 0.85 + corrM * 0.45 + maxPhaseScore * 0.55) * (priors[M] || 0.55);

    if (rawScore > bestMeterScore) {
      bestMeterScore = rawScore;
      bestMeter = M;
      bestDownbeatIdx = bestPhaseForM;
    }
  }

  let alignedBeats = 0;
  let activeBeats = 0;
  for (const b of beats) {
    if (b.total > 0.05) {
      activeBeats++;
      if (b.exactOnsetSec !== null) alignedBeats++;
    }
  }
  const gridFit = activeBeats > 0 ? alignedBeats / activeBeats : 0.5;

  return {
    meter: bestMeter,
    downbeatIndex: bestDownbeatIdx,
    confidence: Math.min(0.98, Math.max(0.45, 0.5 + bestMeterScore * 0.3)),
    gridFit
  };
}

function computeOsuAlignedOffsetMs(startSec, beats, downbeatIndex, meter, beatPeriodSec, segEvents) {
  if (beats.length === 0) {
    return Math.round(startSec * 1000);
  }

  const diffs = [];
  for (const b of beats) {
    if (b.exactOnsetSec !== null && b.total > 0.15) {
      diffs.push(b.exactOnsetSec - b.timeSec);
    }
  }
  const fineShiftSec = diffs.length >= 3 ? median(diffs) : 0.0;

  let firstAudibleBeatIdx = 0;
  for (let i = 0; i < beats.length; i++) {
    if (beats[i].total > 0.08 || beats[i].exactOnsetSec !== null) {
      firstAudibleBeatIdx = i;
      break;
    }
  }

  if (startSec < 0.05) {
    let targetIdx = downbeatIndex;
    while (targetIdx < firstAudibleBeatIdx) {
      targetIdx += meter;
    }
    if (targetIdx > firstAudibleBeatIdx && targetIdx - meter >= 0) {
      targetIdx -= meter;
    }

    let offsetSec = beats[targetIdx].timeSec + fineShiftSec;
    while (offsetSec < 0) {
      offsetSec += beatPeriodSec * meter;
    }
    return Math.round(offsetSec * 1000);
  }

  let firstIdx = 0;
  while (firstIdx + 1 < beats.length && beats[firstIdx].timeSec + fineShiftSec < startSec - 0.015) {
    firstIdx++;
  }
  return Math.round((beats[firstIdx].timeSec + fineShiftSec) * 1000);
}

function computeSegmentDriftStats(beats) {
  let sumSq = 0;
  let maxAbs = 0;
  let count = 0;

  for (const b of beats) {
    if (b.exactOnsetSec !== null && b.total > 0.12) {
      const errMs = Math.abs(b.exactOnsetSec - b.timeSec) * 1000.0;
      sumSq += errMs * errMs;
      if (errMs > maxAbs) maxAbs = errMs;
      count++;
    }
  }

  return {
    rmseMs: count > 0 ? Number(Math.sqrt(sumSq / count).toFixed(2)) : 0,
    maxAbsMs: Number(maxAbs.toFixed(2)),
    matchedCount: count
  };
}

/**
 * Pipeline de fusion y verificacion de cambios estructurales:
 * 1. Fusiona todos los segmentos adyacentes que tengan el mismo BPM (diferencia <= 1.25 BPM)
 *    como un unico bloque continuo y luego verifica si dentro de ese bloque hay un Reset de Fase real.
 *    Esto evita que un segmento se divida por simples variaciones de bateria o sincopas.
 * 2. Verifica cambios internos de Compas (ej. 4/4 -> 3/4) solo cuando son sostenidos y de alta confianza.
 * 3. Sub-segmenta por Rubato solo si `enableRubatoTracking` esta activo.
 */
function mergeAndSplitAdvancedSegments(segments, features, opts) {
  if (segments.length === 0) return [];

  // Paso 1: Fusionar incondicionalmente segmentos contiguos que tengan el mismo BPM (dentro de +-1.25 BPM)
  // y re-analizarlos como un solo bloque largo (para que la deteccion de fase y compas tenga contexto completo).
  const merged = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = segments[i];

    if (Math.abs(prev.bpm - curr.bpm) <= 1.25) {
      const targetBpm = Number.isInteger(prev.bpm) ? prev.bpm : curr.bpm;
      const combinedRaw = {
        startSec: prev.startSec,
        endSec: curr.endSec,
        roughBpm: targetBpm,
        lockBpm: true,
        confidence: Math.max(prev.confidence, curr.confidence)
      };
      merged[merged.length - 1] = refineSegmentTiming(combinedRaw, features, opts);
    } else {
      curr.changeType = 'tempo_change';
      merged.push(curr);
    }
  }

  // Paso 2: Dentro de cada segmento unificado, buscar unicamente cambios estructurales genuinos:
  //   a) Resets de Fase internos (cortes con desfase real de beat)
  //   b) Cambios internos de Compas sostenidos (4/4 <-> 3/4)
  //   c) Seguimiento de Rubato (solo si el usuario activo --rubato)
  const finalSegments = [];
  for (const seg of merged) {
    const phaseChecked = detectInternalPhaseResets(seg, features, opts);
    for (const pSeg of phaseChecked) {
      const meterSplit = detectInternalMeterChanges(pSeg, features, opts.sensitivity);
      for (const mSeg of meterSplit) {
        if (opts.enableRubatoTracking) {
          const rubatoSplit = trackRubatoOrDriftIfNeeded(mSeg, features, opts);
          finalSegments.push(...rubatoSplit);
        } else {
          finalSegments.push(mSeg);
        }
      }
    }
  }

  return finalSegments;
}

/**
 * Detecta si dentro de un segmento con BPM constante hay un cambio brusco y permanente de fase del beat
 * (ej. pausa de medio beat o corte de edicion).
 * Importante: Verifica que la fase del PULSO (beat grid) realmente haya cambiado, no solo que la bateria haga sincopa.
 */
function detectInternalPhaseResets(seg, features, opts) {
  const segDuration = seg.endSec - seg.startSec;
  if (segDuration < 16.0) return [seg];

  const periodSec = 60.0 / seg.bpm;
  const segEvents = features.onsetEvents.filter(
    (e) => e.timeSec >= seg.startSec && e.timeSec <= seg.endSec && (e.strength > 0.15 || e.lowStrength > 0.15)
  );
  if (segEvents.length < 24) return [seg];

  const winSec = 5.0;
  const stepSec = 1.5;
  const phaseWindows = [];

  for (let t0 = seg.startSec; t0 + winSec <= seg.endSec; t0 += stepSec) {
    const t1 = t0 + winSec;
    const evs = segEvents.filter((e) => e.timeSec >= t0 && e.timeSec <= t1);
    if (evs.length < 5) continue;

    let cosSum = 0;
    let sinSum = 0;
    let wSum = 0;
    for (const ev of evs) {
      const w = Math.max(0, Math.pow(ev.lowStrength, 2) * 4.0 + ev.midStrength * 1.0 - ev.highStrength * 0.8);
      if (w <= 0.05) continue;
      const angle = ((2 * Math.PI) / periodSec) * (ev.timeSec - seg.offsetMs / 1000.0);
      cosSum += w * Math.cos(angle);
      sinSum += w * Math.sin(angle);
      wSum += w;
    }

    const coherence = Math.sqrt(cosSum * cosSum + sinSum * sinSum) / Math.max(1e-9, wSum);
    const angle = Math.atan2(sinSum, cosSum);
    phaseWindows.push({
      t0,
      t1,
      centerSec: 0.5 * (t0 + t1),
      angle,
      coherence
    });
  }

  if (phaseWindows.length < 5) return [seg];

  const refWin = phaseWindows.find((w) => w.coherence >= 0.5) || phaseWindows[0];
  if (refWin.coherence < 0.45) return [seg];

  for (let i = 1; i < phaseWindows.length - 2; i++) {
    const wCurr = phaseWindows[i];
    const wNext1 = phaseWindows[i + 1];
    const wNext2 = phaseWindows[i + 2];

    // Exigir alta coherencia en todas las ventanas para no disparar en canciones con sincopa de rock/metal
    if (wCurr.coherence < 0.5 || wNext1.coherence < 0.5 || wNext2.coherence < 0.5) continue;

    const diffCurr = wrapAngleDiff(wCurr.angle, refWin.angle);
    const diffNext1 = wrapAngleDiff(wNext1.angle, refWin.angle);
    const diffNext2 = wrapAngleDiff(wNext2.angle, refWin.angle);
    const consistencyNext = Math.max(
      Math.abs(wrapAngleDiff(wNext1.angle, wCurr.angle)),
      Math.abs(wrapAngleDiff(wNext2.angle, wNext1.angle))
    );

    const timeShiftSec = (Math.abs(diffCurr) / (2 * Math.PI)) * periodSec;

    if (
      timeShiftSec > 0.05 &&
      Math.abs(diffCurr) > 0.9 &&
      Math.abs(diffNext1) > 0.9 &&
      Math.abs(diffNext2) > 0.9 &&
      consistencyNext < 0.35
    ) {
      const approxSplitSec = phaseWindows[i - 1].centerSec;
      const exactSplitSec = pinpointPhaseResetBoundary(
        segEvents,
        approxSplitSec,
        periodSec,
        refWin.angle,
        wCurr.angle,
        seg.offsetMs / 1000.0,
        seg.startSec,
        seg.endSec
      );

      if (exactSplitSec - seg.startSec >= 5.0 && seg.endSec - exactSplitSec >= 5.0) {
        const segA = refineSegmentTiming(
          {
            startSec: seg.startSec,
            endSec: exactSplitSec,
            roughBpm: seg.bpm,
            lockBpm: true,
            confidence: seg.confidence
          },
          features,
          opts
        );
        const segB = refineSegmentTiming(
          {
            startSec: exactSplitSec,
            endSec: seg.endSec,
            roughBpm: seg.bpm,
            lockBpm: true,
            confidence: seg.confidence,
            changeType: 'phase_reset'
          },
          features,
          opts
        );

        // Validar que realmente haya un desfase de beat entre segA y segB (> 35ms respecto al periodo del beat)
        const beatLenMs = 60000.0 / seg.bpm;
        const deltaMs = segB.offsetMs - segA.offsetMs;
        const beatPhaseErrMs = Math.abs(deltaMs - Math.round(deltaMs / beatLenMs) * beatLenMs);
        if (beatPhaseErrMs >= 35.0) {
          return [segA, segB];
        }
      }
    }
  }

  return [seg];
}

function wrapAngleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function pinpointPhaseResetBoundary(
  segEvents,
  approxSplitSec,
  periodSec,
  angleBefore,
  angleAfter,
  refOffsetSec,
  minSec,
  maxSec
) {
  const candidates = segEvents.filter(
    (e) =>
      e.timeSec >= Math.max(minSec + 2.0, approxSplitSec - 5.0) &&
      e.timeSec <= Math.min(maxSec - 2.0, approxSplitSec + 5.0) &&
      (e.lowStrength > 0.2 || e.strength > 0.25)
  );

  if (candidates.length === 0) return approxSplitSec;

  const afterPhaseCandidates = candidates.filter((cand) => {
    const angle = ((2 * Math.PI) / periodSec) * (cand.timeSec - refOffsetSec);
    return Math.abs(wrapAngleDiff(angle, angleAfter)) < 0.65;
  });

  const pool = afterPhaseCandidates.length > 0 ? afterPhaseCandidates : candidates;

  let bestSec = pool[0].timeSec;
  let bestScore = -Infinity;

  for (const cand of pool) {
    const tSplit = cand.timeSec;
    let score = 0;

    for (const ev of segEvents) {
      if (ev.timeSec < tSplit - 5.0 || ev.timeSec > tSplit + 5.0) continue;
      const w = Math.max(0, Math.pow(ev.lowStrength, 2) * 4.0 + ev.midStrength * 1.0 - ev.highStrength * 0.8);
      if (w <= 0.05) continue;

      const angle = ((2 * Math.PI) / periodSec) * (ev.timeSec - refOffsetSec);
      const targetAngle = ev.timeSec < tSplit - 0.01 ? angleBefore : angleAfter;
      const diff = wrapAngleDiff(angle, targetAngle);
      score += w * Math.cos(diff);
    }

    score += cand.lowStrength * 1.2;

    if (score > bestScore) {
      bestScore = score;
      bestSec = tSplit;
    }
  }

  return bestSec;
}

function trackRubatoOrDriftIfNeeded(seg, features, opts) {
  const sensitivity = opts.sensitivity ?? 0.5;
  const driftThresholdMs = 19.0 - 6.0 * sensitivity;

  if (seg.driftRmseMs <= driftThresholdMs || seg.endSec - seg.startSec < 14.0) {
    return [seg];
  }

  const barDurationSec = (60.0 / seg.bpm) * (seg.meter || 4);
  const chunkDurationSec = Math.max(6.0, barDurationSec * 4);

  const numChunks = Math.floor((seg.endSec - seg.startSec) / chunkDurationSec);
  if (numChunks < 2) return [seg];

  const subSegments = [];
  for (let c = 0; c < numChunks; c++) {
    const cStart = seg.startSec + c * chunkDurationSec;
    const cEnd = c === numChunks - 1 ? seg.endSec : seg.startSec + (c + 1) * chunkDurationSec;

    const refinedChunk = refineSegmentTiming(
      {
        startSec: cStart,
        endSec: cEnd,
        roughBpm: seg.bpm,
        confidence: seg.confidence,
        changeType: c === 0 ? seg.changeType : 'rubato_drift'
      },
      features,
      { ...opts, preferIntegerBpm: false }
    );
    subSegments.push(refinedChunk);
  }

  const newAvgRmse = subSegments.reduce((acc, s) => acc + s.driftRmseMs, 0) / subSegments.length;
  if (newAvgRmse < seg.driftRmseMs * 0.75) {
    return subSegments;
  }

  return [seg];
}

function detectInternalMeterChanges(seg, features, sensitivity = 0.5) {
  const beats = seg.beats;
  if (!beats || beats.length < 32) {
    return [seg];
  }

  const beatPeriodSec = 60.0 / seg.bpm;
  const winBeats = 24;
  const stepBeats = 8;

  const meterWindows = [];
  for (let bStart = 0; bStart + winBeats <= beats.length; bStart += stepBeats) {
    const subBeats = beats.slice(bStart, bStart + winBeats);
    const mInfo = detectMeterAndDownbeat(subBeats, beatPeriodSec);
    meterWindows.push({
      bStart,
      bEnd: bStart + winBeats,
      meter: mInfo.meter,
      downbeatRel: mInfo.downbeatIndex,
      confidence: mInfo.confidence
    });
  }

  if (meterWindows.length < 3) {
    return [seg];
  }

  const thresholdConf = 0.78 - 0.1 * sensitivity;
  let splitBeatIdx = -1;
  let secondMeter = seg.meter;

  for (let w = 1; w < meterWindows.length - 1; w++) {
    const currM = meterWindows[w].meter;
    const nextM = meterWindows[w + 1].meter;

    if (
      currM !== seg.meter &&
      currM === nextM &&
      meterWindows[w].confidence >= thresholdConf &&
      meterWindows[w + 1].confidence >= thresholdConf
    ) {
      splitBeatIdx = meterWindows[w].bStart + meterWindows[w].downbeatRel;
      secondMeter = currM;
      break;
    }
  }

  if (splitBeatIdx <= 8 || splitBeatIdx >= beats.length - 12) {
    return [seg];
  }

  const splitSec = beats[splitBeatIdx].timeSec;
  const firstHalfBeats = beats.slice(0, splitBeatIdx);
  const secondHalfBeats = beats.slice(splitBeatIdx);

  const firstMeterInfo = detectMeterAndDownbeat(firstHalfBeats, beatPeriodSec);
  const secondMeterInfo = detectMeterAndDownbeat(secondHalfBeats, beatPeriodSec);

  if (firstMeterInfo.meter === secondMeterInfo.meter) {
    return [seg];
  }

  const firstSeg = {
    ...seg,
    endSec: splitSec,
    meter: firstMeterInfo.meter,
    beats: firstHalfBeats
  };

  const secondSeg = {
    ...seg,
    startSec: splitSec,
    offsetMs: Math.round(splitSec * 1000),
    meter: secondMeter || secondMeterInfo.meter,
    beats: secondHalfBeats,
    changeType: 'meter_change'
  };

  return [firstSeg, secondSeg];
}

function buildOsuTimingPoints(segments, totalDurationSec) {
  if (segments.length === 0) return [];

  // Si el primer Timing Point empieza despues de una intro (ej. en el drop a los 30s),
  // retro-proyectamos el compas hacia atras para que la linea roja cubra desde el inicio (t >= 0)
  const firstSeg = segments[0];
  const barMs = (60000.0 / firstSeg.bpm) * (firstSeg.meter || 4);
  if (firstSeg.offsetMs > barMs) {
    let retroOffset = firstSeg.offsetMs;
    while (retroOffset - barMs >= 0) {
      retroOffset -= barMs;
    }
    firstSeg.offsetMs = Math.round(retroOffset);
  }

  return segments.map((seg, idx) => {
    const beatLength = 60000.0 / seg.bpm;
    const offsetMs = seg.offsetMs;
    const endMs = idx + 1 < segments.length ? segments[idx + 1].offsetMs : Math.round(totalDurationSec * 1000);
    const meter = seg.meter || 4;

    const osuLine = `${offsetMs},${beatLength.toFixed(12).replace(/\.?0+$/, '')},${meter},2,0,100,1,0`;

    return {
      index: idx + 1,
      offsetMs,
      endMs,
      startTimeFormatted: formatMsToTimestamp(offsetMs),
      endTimeFormatted: formatMsToTimestamp(endMs),
      bpm: seg.bpm,
      beatLengthMs: Number(beatLength.toFixed(6)),
      meter,
      timeSignature: `${meter}/4`,
      confidence: Number((seg.confidence * 100).toFixed(1)),
      driftRmseMs: seg.driftRmseMs ?? 0,
      changeType: idx === 0 ? 'initial' : seg.changeType || 'tempo_change',
      osuTimingPointLine: osuLine
    };
  });
}

function computeMapperDiagnostics(timingPoints, onsetEvents, totalDurationSec) {
  const avgDriftRmseMs =
    timingPoints.reduce((acc, tp) => acc + (tp.driftRmseMs || 0), 0) / Math.max(1, timingPoints.length);

  const firstOnsetMs = onsetEvents.length > 0 ? Math.round(onsetEvents[0].timeMs) : timingPoints[0].offsetMs;
  const audioLeadInRecommendedMs = firstOnsetMs < 1200 ? Math.max(0, 1500 - firstOnsetMs) : 0;

  let syncQuality = 'EXCELENTE (Precision de Ranking < 5 ms)';
  if (avgDriftRmseMs > 12) {
    syncQuality = 'MODERADA (Cancion con bateria densa / sincopa)';
  } else if (avgDriftRmseMs > 5) {
    syncQuality = 'BUENA (Desviacion < 12 ms)';
  }

  return {
    avgDriftRmseMs: Number(avgDriftRmseMs.toFixed(2)),
    firstAudibleOnsetMs: firstOnsetMs,
    recommendedAudioLeadInMs: audioLeadInRecommendedMs,
    syncQuality
  };
}

function selectPrimaryTimingPoint(timingPoints, totalDurationSec) {
  if (timingPoints.length === 1) return timingPoints[0];

  let bestTp = timingPoints[0];
  let maxDuration = -1;

  for (const tp of timingPoints) {
    const dur = tp.endMs - tp.offsetMs;
    if (dur > maxDuration) {
      maxDuration = dur;
      bestTp = tp;
    }
  }
  return bestTp;
}

export function formatMsToTimestamp(ms) {
  const sign = ms < 0 ? '-' : '';
  const absMs = Math.abs(Math.round(ms));
  const minutes = Math.floor(absMs / 60000);
  const seconds = Math.floor((absMs % 60000) / 1000);
  const millis = absMs % 1000;
  return `${sign}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}
