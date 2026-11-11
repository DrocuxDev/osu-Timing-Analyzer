/**
 * Parser, Validador y Analizador de Precision Matematica para archivos .osu (v14).
 *
 * Cumple estrictamente con las reglas internas del motor de osu!:
 * 1. Estructura de [TimingPoints]: time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
 * 2. Lineas rojas (uninherited = 1): beatLength > 0, BPM = 60000 / beatLength.
 * 3. Lineas verdes (uninherited = 0): beatLength < 0, SV = clamp(-100 / beatLength, 0.1, 10.0).
 * 4. Ordenamiento estable en el mismo ms: uninherited = 1 SIEMPRE precede a uninherited = 0.
 * 5. Cruce HitObjects <-> TimingPoints en O(log N) mediante busqueda binaria.
 * 6. Verificacion de Snapping con tolerancia epsilon (±1ms / ±2ms) inmune a imprecision IEEE 754.
 */

export const OSU_MIN_SV = 0.1;
export const OSU_MAX_SV = 10.0;
export const OSU_MIN_BPM = 0.0001;
export const OSU_MAX_BPM = 1000000;
export const DEFAULT_SNAP_EPSILON_MS = 2.0;
export const STANDARD_BEAT_DIVISORS = Object.freeze([1, 2, 3, 4, 6, 8, 12, 16]);

/**
 * Valida y convierte un valor numerico finito de forma estricta.
 * Rechaza null, undefined, strings vacios, booleanos, NaN e Infinity.
 */
export function parseStrictFiniteNumber(raw, fieldName = 'valor') {
  if (raw === null || raw === undefined || typeof raw === 'boolean') {
    throw new TypeError(`El campo '${fieldName}' es nulo, indefinido o booleano.`);
  }
  const str = String(raw).trim();
  if (str === '') {
    throw new TypeError(`El campo '${fieldName}' esta vacio.`);
  }
  const num = Number(str);
  if (!Number.isFinite(num)) {
    throw new RangeError(`El campo '${fieldName}' no es un numero finito valido: '${raw}'.`);
  }
  return num;
}

/**
 * Calcula el BPM a partir de beatLength (ms) para un punto NO heredado (uninherited = 1).
 * Previene divisiones por cero, valores negativos, NaN o Infinity.
 */
export function computeBpmFromBeatLength(beatLength) {
  const bl = parseStrictFiniteNumber(beatLength, 'beatLength');
  if (bl <= 0) {
    throw new RangeError(`Uninherited TimingPoint requiere beatLength > 0 (recibido: ${bl}).`);
  }
  const bpm = 60000.0 / bl;
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError(`BPM resultante invalido (${bpm}) para beatLength=${bl}.`);
  }
  return bpm;
}

/**
 * Calcula el multiplicador de Slider Velocity (SV) para un punto heredado (uninherited = 0).
 * Aplica la formula oficial SV = -100 / beatLength y el clamping de osu! entre [0.1x, 10.0x].
 * Previene que valores positivos o 0 en una linea heredada rompan el analizador.
 */
export function computeClampedSliderVelocity(beatLength) {
  if (beatLength === null || beatLength === undefined || typeof beatLength === 'boolean' || String(beatLength).trim() === '') {
    return { sv: 1.0, rawSv: 1.0, clamped: true, corruptedPositiveOrZero: true };
  }
  const bl = Number(beatLength);
  if (!Number.isFinite(bl)) {
    return { sv: 1.0, rawSv: 1.0, clamped: true, corruptedPositiveOrZero: true };
  }
  if (bl >= 0) {
    return {
      sv: 1.0,
      rawSv: bl === 0 ? Infinity : -100.0 / bl,
      clamped: true,
      corruptedPositiveOrZero: true
    };
  }
  const rawSv = -100.0 / bl;
  const clampedSv = Math.min(OSU_MAX_SV, Math.max(OSU_MIN_SV, rawSv));
  return {
    sv: Number(clampedSv.toFixed(6)),
    rawSv,
    clamped: Math.abs(clampedSv - rawSv) > 1e-9,
    corruptedPositiveOrZero: false
  };
}

/**
 * Parsea una linea individual de [TimingPoints]:
 * time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
 */
export function parseTimingPointLine(rawLine, lineIndex = 0) {
  if (typeof rawLine !== 'string') {
    throw new TypeError(`Linea ${lineIndex}: se esperaba un string.`);
  }
  const cleanLine = rawLine.replace(/\/\/.*$/, '').trim();
  if (!cleanLine) return null;

  const parts = cleanLine.split(',').map((p) => p.trim());
  if (parts.length < 2) {
    throw new Error(
      `Linea ${lineIndex}: TimingPoint incompleto (${parts.length} parametros; se requieren al menos 2 en formato legacy u 8 en v14).`
    );
  }

  const time = parseStrictFiniteNumber(parts[0], `TimingPoint[${lineIndex}].time`);
  const beatLength = parseStrictFiniteNumber(parts[1], `TimingPoint[${lineIndex}].beatLength`);
  const meterRaw =
    parts.length >= 3 && parts[2] !== ''
      ? parseStrictFiniteNumber(parts[2], `TimingPoint[${lineIndex}].meter`)
      : 4;
  const sampleSet =
    parts.length >= 4 && parts[3] !== ''
      ? parseStrictFiniteNumber(parts[3], `TimingPoint[${lineIndex}].sampleSet`)
      : 2;
  const sampleIndex =
    parts.length >= 5 && parts[4] !== ''
      ? parseStrictFiniteNumber(parts[4], `TimingPoint[${lineIndex}].sampleIndex`)
      : 0;
  const volumeRaw =
    parts.length >= 6 && parts[5] !== ''
      ? parseStrictFiniteNumber(parts[5], `TimingPoint[${lineIndex}].volume`)
      : 100;
  const uninheritedRaw =
    parts.length >= 7 && parts[6] !== ''
      ? parseStrictFiniteNumber(parts[6], `TimingPoint[${lineIndex}].uninherited`)
      : beatLength > 0
        ? 1
        : 0;
  const effectsRaw =
    parts.length >= 8 && parts[7] !== ''
      ? parseStrictFiniteNumber(parts[7], `TimingPoint[${lineIndex}].effects`)
      : 0;

  if (uninheritedRaw !== 0 && uninheritedRaw !== 1) {
    throw new RangeError(`Linea ${lineIndex}: 'uninherited' debe ser 0 o 1 (recibido: ${uninheritedRaw}).`);
  }

  const uninherited = uninheritedRaw === 1;
  const meter = Math.trunc(meterRaw);
  if (uninherited && meter <= 0) {
    throw new RangeError(
      `Linea ${lineIndex}: compas (meter) malformado '${meterRaw}/4'. Debe ser un entero >= 1.`
    );
  }

  const volume = Math.min(100, Math.max(0, Math.round(volumeRaw)));
  const effects = Math.max(0, Math.trunc(effectsRaw));

  let bpm = null;
  let sv = 1.0;
  let svClamped = false;
  let corruptedGreenLine = false;

  if (uninherited) {
    bpm = computeBpmFromBeatLength(beatLength);
  } else {
    const svInfo = computeClampedSliderVelocity(beatLength);
    sv = svInfo.sv;
    svClamped = svInfo.clamped;
    corruptedGreenLine = svInfo.corruptedPositiveOrZero;
  }

  return {
    time,
    beatLength,
    meter: meter > 0 ? meter : 4,
    sampleSet: Math.trunc(sampleSet),
    sampleIndex: Math.trunc(sampleIndex),
    volume,
    uninherited,
    effects,
    bpm,
    sv,
    svClamped,
    corruptedGreenLine,
    isIncompleteFormat: parts.length < 8,
    originalIndex: lineIndex
  };
}

/**
 * Ordena TimingPoints garantizando estabilidad y la regla interna de osu!:
 * Si dos puntos comparten el mismo `time` (milisegundo exacto), la linea roja (uninherited = true)
 * SIEMPRE se procesa antes que la linea verde (uninherited = false).
 */
export function sortTimingPoints(points) {
  if (!Array.isArray(points)) return [];
  return points
    .map((pt, idx) => ({ pt, idx }))
    .sort((a, b) => {
      if (a.pt.time !== b.pt.time) {
        return a.pt.time - b.pt.time;
      }
      if (a.pt.uninherited !== b.pt.uninherited) {
        return a.pt.uninherited ? -1 : 1;
      }
      const origA = a.pt.originalIndex ?? a.idx;
      const origB = b.pt.originalIndex ?? b.idx;
      return origA - origB;
    })
    .map((item) => item.pt);
}

/**
 * Busqueda binaria O(log N) para obtener el ultimo TimingPoint cuyo `time <= targetTime`.
 * Si existen multiples puntos en el mismo `time`, devuelve el ultimo de ese mismo milisegundo.
 * Si `targetTime` es anterior al primer elemento:
 * - Para lineas rojas (`fallbackToFirst = true`): osu! proyecta hacia atras el primer TimingPoint no heredado.
 * - Para lineas verdes (`fallbackToFirst = false`): devuelve null (SV 1.0x por defecto).
 */
export function binarySearchTimingPoint(sortedPoints, targetTime, fallbackToFirst = false) {
  if (!Array.isArray(sortedPoints) || sortedPoints.length === 0) {
    return null;
  }
  if (targetTime < sortedPoints[0].time) {
    return fallbackToFirst ? sortedPoints[0] : null;
  }

  let low = 0;
  let high = sortedPoints.length - 1;
  let resultIdx = 0;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (sortedPoints[mid].time <= targetTime) {
      resultIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return sortedPoints[resultIdx];
}

/**
 * Resuelve en O(log N) el contexto de timing efectivo (BPM, beatLength, compas y SV)
 * para cualquier marca de tiempo `timeMs` (ej. un HitObject).
 */
export function resolveTimingContextAt(timeMs, uninheritedPoints, inheritedPoints = []) {
  const t = parseStrictFiniteNumber(timeMs, 'timeMs');
  const redPoint = binarySearchTimingPoint(uninheritedPoints, t, true);
  if (!redPoint) {
    throw new Error('El mapa no contiene ningun TimingPoint no heredado (linea roja) valido.');
  }

  const isBeforeFirstRedLine = t < redPoint.time;
  const greenPoint = binarySearchTimingPoint(inheritedPoints, t, false);

  let effectiveSv = 1.0;
  if (greenPoint && !isBeforeFirstRedLine && greenPoint.time >= redPoint.time) {
    effectiveSv = greenPoint.sv;
  }

  return {
    timeMs: t,
    redPoint,
    greenPoint: greenPoint && !isBeforeFirstRedLine && greenPoint.time >= redPoint.time ? greenPoint : null,
    beatLength: redPoint.beatLength,
    bpm: redPoint.bpm,
    meter: redPoint.meter,
    sv: effectiveSv,
    isBeforeFirstRedLine
  };
}

/**
 * Verifica si el tiempo de un HitObject (`objectTimeMs`) esta correctamente alineado (snapped)
 * a alguna subdivision estandar de beat (1/1, 1/2, 1/3, 1/4, 1/6, 1/8, 1/12, 1/16)
 * utilizando tolerancia epsilon (±1ms o ±2ms) para evitar fallos por coma flotante IEEE 754.
 */
export function checkHitObjectSnap(
  objectTimeMs,
  uninheritedPoints,
  epsilonMs = DEFAULT_SNAP_EPSILON_MS,
  divisors = STANDARD_BEAT_DIVISORS
) {
  const t = parseStrictFiniteNumber(objectTimeMs, 'objectTimeMs');
  const tol = parseStrictFiniteNumber(epsilonMs, 'epsilonMs');
  if (tol < 0) {
    throw new RangeError(`La tolerancia epsilonMs no puede ser negativa (recibido: ${tol}).`);
  }

  const redPoint = binarySearchTimingPoint(uninheritedPoints, t, true);
  if (!redPoint) {
    throw new Error('No existen puntos de timing no heredados para verificar el snapping.');
  }

  const beatLength = redPoint.beatLength;
  const deltaMs = t - redPoint.time;

  let bestDivisor = 1;
  let minErrorMs = Infinity;
  let nearestSnapMs = redPoint.time;

  for (const div of divisors) {
    if (!Number.isFinite(div) || div <= 0) continue;
    const stepMs = beatLength / div;
    const stepIndex = Math.round(deltaMs / stepMs);
    const candidateTimeMs = redPoint.time + stepIndex * stepMs;
    const errorMs = Math.abs(t - candidateTimeMs);

    if (errorMs <= tol + 1e-9) {
      return {
        isSnapped: true,
        divisor: div,
        errorMs: Number(errorMs.toFixed(6)),
        nearestSnapMs: Number(candidateTimeMs.toFixed(6)),
        isBeforeFirstRedLine: t < redPoint.time
      };
    }

    if (errorMs < minErrorMs) {
      minErrorMs = errorMs;
      bestDivisor = div;
      nearestSnapMs = candidateTimeMs;
    }
  }

  return {
    isSnapped: false,
    divisor: bestDivisor,
    errorMs: Number(minErrorMs.toFixed(6)),
    nearestSnapMs: Number(nearestSnapMs.toFixed(6)),
    isBeforeFirstRedLine: t < redPoint.time
  };
}

/**
 * Formatea un objeto TimingPoint al string oficial de 8 parametros de osu! v14.
 */
export function formatTimingPointToOsuLine(tp) {
  if (!tp || typeof tp !== 'object') {
    throw new TypeError('TimingPoint invalido al formatear linea .osu.');
  }
  if (typeof tp.osuTimingPointLine === 'string' && tp.osuTimingPointLine.trim() !== '') {
    return tp.osuTimingPointLine.trim();
  }
  const timeVal = parseStrictFiniteNumber(tp.time ?? tp.offsetMs, 'time');
  const blVal = parseStrictFiniteNumber(tp.beatLength ?? tp.beatLengthMs, 'beatLength');
  const timeStr = Number.isInteger(timeVal) ? String(timeVal) : Number(timeVal.toFixed(6)).toString();
  const blStr = Number(blVal.toFixed(12)).toString();
  const meter = Math.max(1, Math.trunc(Number(tp.meter) || 4));
  const sampleSet = Math.trunc(Number(tp.sampleSet ?? 2));
  const sampleIndex = Math.trunc(Number(tp.sampleIndex ?? 0));
  const volume = Math.min(100, Math.max(0, Math.round(Number(tp.volume ?? 100))));
  const uninherited = tp.uninherited === false || tp.uninherited === 0 ? 0 : 1;
  const effects = Math.max(0, Math.trunc(Number(tp.effects ?? 0)));

  return `${timeStr},${blStr},${meter},${sampleSet},${sampleIndex},${volume},${uninherited},${effects}`;
}

/**
 * Parsea un archivo .osu completo de forma resiliente:
 * - Soporta saltos de linea LF (\n) y CRLF (\r\n), espacios extra y comentarios (//).
 * - Maneja secciones [TimingPoints] o [HitObjects] ausentes o vacias sin colapsar.
 * - Detecta HitObjects cronologicamente anteriores al primer TimingPoint no heredado.
 * - Asocia cada HitObject con su TimingPoint activo en O(log N) mediante busqueda binaria.
 */
export function parseOsuFile(osuContent, options = {}) {
  if (typeof osuContent !== 'string') {
    throw new TypeError('El contenido del archivo .osu debe ser un string.');
  }

  const strict = Boolean(options.strict);
  const epsilonMs = options.snapEpsilonMs ?? DEFAULT_SNAP_EPSILON_MS;
  const lines = osuContent.replace(/^\uFEFF/, '').split(/\r?\n/);

  let currentSection = null;
  let hasTimingPointsSection = false;
  let hasHitObjectsSection = false;

  const rawTimingPoints = [];
  const hitObjects = [];
  const errors = [];
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }

    const sectionMatch = /^\[([A-Za-z0-9_]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (currentSection === 'TimingPoints') hasTimingPointsSection = true;
      if (currentSection === 'HitObjects') hasHitObjectsSection = true;
      continue;
    }

    if (currentSection === 'TimingPoints') {
      try {
        const tp = parseTimingPointLine(trimmed, i + 1);
        if (tp) {
          if (tp.isIncompleteFormat) {
            warnings.push(`Linea ${i + 1}: TimingPoint con menos de 8 parametros.`);
          }
          if (tp.corruptedGreenLine) {
            warnings.push(
              `Linea ${i + 1}: TimingPoint heredado con beatLength >= 0 (${tp.beatLength}); SV ajustado a 1.0x.`
            );
          }
          rawTimingPoints.push(tp);
        }
      } catch (err) {
        if (strict) throw err;
        errors.push({ line: i + 1, section: 'TimingPoints', message: err.message });
      }
    } else if (currentSection === 'HitObjects') {
      try {
        const cleanObj = trimmed.replace(/\/\/.*$/, '').trim();
        const parts = cleanObj.split(',').map((p) => p.trim());
        if (parts.length < 5) {
          throw new Error(
            `Linea ${i + 1}: HitObject incompleto (${parts.length} parametros, minimo 5 requeridos).`
          );
        }
        const x = parseStrictFiniteNumber(parts[0], `HitObject[${i + 1}].x`);
        const y = parseStrictFiniteNumber(parts[1], `HitObject[${i + 1}].y`);
        const time = parseStrictFiniteNumber(parts[2], `HitObject[${i + 1}].time`);
        const type = parseStrictFiniteNumber(parts[3], `HitObject[${i + 1}].type`);
        const hitSound = parseStrictFiniteNumber(parts[4], `HitObject[${i + 1}].hitSound`);
        hitObjects.push({
          x,
          y,
          time,
          type: Math.trunc(type),
          hitSound: Math.trunc(hitSound),
          line: i + 1
        });
      } catch (err) {
        if (strict) throw err;
        errors.push({ line: i + 1, section: 'HitObjects', message: err.message });
      }
    }
  }

  if (!hasTimingPointsSection) {
    warnings.push('El archivo .osu no contiene la seccion [TimingPoints].');
  }
  if (!hasHitObjectsSection) {
    warnings.push('El archivo .osu no contiene la seccion [HitObjects].');
  }

  const timingPoints = sortTimingPoints(rawTimingPoints);
  const uninheritedPoints = timingPoints.filter((tp) => tp.uninherited);
  const inheritedPoints = timingPoints.filter((tp) => !tp.uninherited);

  if (uninheritedPoints.length === 0) {
    warnings.push('No se encontro ningun TimingPoint no heredado (linea roja).');
  }

  const unsnappedObjects = [];
  const objectsBeforeFirstRedLine = [];
  const analyzedHitObjects = [];

  if (uninheritedPoints.length > 0) {
    for (let i = 0; i < hitObjects.length; i++) {
      const obj = hitObjects[i];
      const ctx = resolveTimingContextAt(obj.time, uninheritedPoints, inheritedPoints);
      const snap = checkHitObjectSnap(obj.time, uninheritedPoints, epsilonMs);

      if (ctx.isBeforeFirstRedLine) {
        objectsBeforeFirstRedLine.push(obj);
      }
      if (!snap.isSnapped) {
        unsnappedObjects.push({ ...obj, ...snap });
      }
      analyzedHitObjects.push({
        ...obj,
        activeBpm: ctx.bpm,
        activeSv: ctx.sv,
        isBeforeFirstRedLine: ctx.isBeforeFirstRedLine,
        snap
      });
    }
  }

  return {
    hasTimingPointsSection,
    hasHitObjectsSection,
    timingPoints,
    uninheritedPoints,
    inheritedPoints,
    hitObjects: analyzedHitObjects,
    objectsBeforeFirstRedLine,
    unsnappedObjects,
    errors,
    warnings
  };
}
