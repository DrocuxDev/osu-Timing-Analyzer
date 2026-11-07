# osu! Timing Analyzer

Analizador de BPM, Offset, Compas y Cambios Dinamicos (Multi-BPM / vBPM) disenado especificamente para mappers de osu!.

Herramienta hibrida (con interfaz de seleccion de archivos para Escritorio y potente CLI para terminal) compatible con Windows, macOS y Linux. Analiza archivos de audio (.mp3, .ogg, .wav, .flac, .m4a) y extrae las lineas de tiempo [TimingPoints] con precision milimetrica.

---

## Caracteristicas Principales

- Deteccion de BPM con resolucion de 0.01 BPM y ajuste inteligente a tempos masterizados.
- Deteccion de Offset Inicial (ms) alineado al downbeat (primer golpe de compas).
- Identificacion de Compas (Time Signature): Detecta 4/4, 3/4, 6/4, 5/4, 7/4 analizando la correlacion entre frecuencias bajas (bombo/bajo) y altas (caja/platillos).
- Analisis Multi-Candidato: Presenta los tempos armonicos detectados (Fundamental, Doble Tempo x2, Mitad de Tempo /2, Polirritmias 3:2 / 2:3) con porcentaje de confianza.
- Filtro de Asimetria de Octava: Evalua la alternancia de energia ritmica par vs. impar para evitar falsas duplicaciones de BPM causadas por hi-hats o flutter.
- Resistencia a Breakdowns: Ignora caidas temporales de bajo o pausas ambientales breves (< 25s) si la cancion tiene un tempo dominante claro.
- Proyeccion Retrograda para Intros Ambientales: Permite especificar el segundo del drop (--start-at); el analizador proyecta compases completos hacia atras para sincronizar el primer punto de timing cerca de 0:00.
- Exportacion Directa a .osz: Genera un beatmap empaquetado (.osz) con audio convertido y metadata listo para arrastrar directamente a osu!.
- Copia Automatica al Portapapeles: Las lineas rojas ([TimingPoints]) quedan listas en el portapapeles para pegar en osu! con Ctrl + V (F6 Timing Setup).
- Sin dependencias externas de npm: Utiliza librerias nativas de Node.js (zlib, crypto, child_process).

---

## Requisitos

1. Node.js (v18.0.0 o superior).
2. FFmpeg disponible en el PATH del sistema (para decodificar y convertir formatos de audio).

---

## Instalacion

Clonar el repositorio:

```bash
git clone https://github.com/DrocuxDev/osu-Timing-Analyzer.git
cd osu-Timing-Analyzer
```

No requiere `npm install` de librerias de terceros. Solo asegurate de tener Node.js y FFmpeg instalados.

Para verificar que el entorno este listo y ejecutar la suite de pruebas:

```bash
npm test
```

---

## Modos de Uso

### 1. Modo Aplicacion de Escritorio (Doble Clic / Arrastrar y Soltar)

En Windows:
- Haz doble clic sobre `osu-timing.cmd`.
- Se abrira inmediatamente la ventana nativa de seleccion de archivos de Windows.
- Elige tu cancion (.mp3, .wav, .ogg, .flac, .m4a).
- Tambien puedes arrastrar cualquier cancion y soltarla encima de `osu-timing.cmd`.

En macOS o Linux:
```bash
chmod +x osu-timing.sh
./osu-timing.sh
```

### 2. Menu Interactivo Posterior al Analisis

Al finalizar el analisis, el programa muestra la tabla de timing y ofrece opciones interactivas inmediatas sin necesidad de reiniciar:

- `[1]`, `[2]`, `[3]`, etc.: Cambiar de inmediato a cualquiera de los otros tempos candidatos detectados.
- `[D]`: Doblar el BPM actual (x2).
- `[M]`: Reducir el BPM a la mitad (/2).
- `[B]`: Introducir manualmente un BPM objetivo (recalcula offset, compas y timing points).
- `[I]`: Fijar el segundo del drop/intro ambiental (proyecta compases hacia atras).
- `[G]`: Generar paquete beatmap .osz y archivo .osu.
- `[Enter]`: Abrir y analizar otra cancion inmediatamente.
- `[S]`: Salir del programa.

---

### 3. Modo Terminal (CLI)

Ejecucion basica:
```bash
node bin/osu-timing.js "C:/ruta/a/cancion.mp3"
```

O usando el ejecutable directo:
```bash
# Windows
.\osu-timing.cmd "C:\ruta\a\cancion.mp3"

# Linux / macOS
./osu-timing.sh "/ruta/a/cancion.mp3"
```

---

## Opciones de Linea de Comandos

| Opcion | Descripcion | Ejemplo |
| :--- | :--- | :--- |
| `--osz <archivo.osz>` | Genera directamente el archivo empaquetado `.osz` para osu!. | `node bin/osu-timing.js song.mp3 --osz beatmap.osz` |
| `--osu <archivo.osu>` | Escribe o reemplaza la seccion `[TimingPoints]` en un `.osu` existente. | `node bin/osu-timing.js song.mp3 --osu diff.osu` |
| `--bpm <valor>` | Fija un BPM manualmente y calcula automaticamente el offset y compas optimos. | `node bin/osu-timing.js song.mp3 --bpm 154` |
| `--start-at <seg>` | Especifica el segundo donde entra el ritmo/drop real (proyecta compases a 0s). | `node bin/osu-timing.js song.mp3 --start-at 30` |
| `--skip-intro <seg>` | Alias de `--start-at`. | `node bin/osu-timing.js song.mp3 --skip-intro 15.5` |
| `--double` | Fuerza la seleccion del candidato de tempo doble (x2). | `node bin/osu-timing.js song.mp3 --double` |
| `--half` | Fuerza la seleccion del candidato de mitad de tempo (/2). | `node bin/osu-timing.js song.mp3 --half` |
| `--min-bpm <num>` | Limite inferior para busqueda de tempo (defecto: 60). | `node bin/osu-timing.js song.mp3 --min-bpm 90` |
| `--max-bpm <num>` | Limite superior para busqueda de tempo (defecto: 260). | `node bin/osu-timing.js song.mp3 --max-bpm 300` |
| `--sensitivity <0-1>` | Sensibilidad a fluctuaciones de tempo (0.0 = conservador, 0.5 = normal, 0.8 = sensible). | `node bin/osu-timing.js song.mp3 --sensitivity 0.7` |
| `--rubato` | Habilita sub-segmentacion continua para canciones en vivo o interpretaciones libres sin metronomo. | `node bin/osu-timing.js live.mp3 --rubato` |
| `--no-snap` | Desactiva el auto-ajuste a enteros o semienteros (.0 / .5 BPM). | `node bin/osu-timing.js live.mp3 --no-snap` |
| `--json` | Muestra la salida estructurada en formato JSON puro. | `node bin/osu-timing.js song.mp3 --json` |

---

## Como Importar a osu!

1. Con archivo `.osz`:
   - Arrastra el archivo `.osz` generado directamente dentro de osu! o dale doble clic. Se importara de forma nativa en tu coleccion de canciones.

2. En el Editor de osu! (Timing Setup):
   - Abre tu mapa en el editor (`Ctrl + O`).
   - Presiona `F6` para abrir el panel de Timing.
   - Presiona `Ctrl + V`. El programa copia automaticamente todas las lineas rojas calculadas al portapapeles.

---

## Estructura del Proyecto

```
osu-timing/
├── bin/
│   └── osu-timing.js      # Punto de entrada CLI e interfaz interactiva
├── src/
│   ├── analyzer.js        # Motor de tempo, Viterbi, asimetria de octava y compas
│   ├── decoder.js         # Decodificador universal via FFmpeg Float32 PCM
│   ├── dsp.js             # FFT Radix-2, flujo espectral multibanda y filtros
│   ├── formatter.js       # Formato de tablas, mapas ASCII y empaquetador .osu
│   └── zip.js             # Generador ZIP/OSZ nativo en memoria (zlib)
├── test/
│   └── run-tests.js       # Suite de pruebas automatizadas (8 escenarios sinteticos)
├── osu-timing.cmd         # Lanzador rapido para Windows
├── osu-timing.sh          # Lanzador rapido para macOS / Linux
├── package.json
└── README.md
```

---

## Licencia

Distribuido bajo la Licencia MIT.
