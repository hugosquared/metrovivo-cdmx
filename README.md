# MetroVivo CDMX — Mapa 3D Ciudadano en Vivo del Metro CDMX

Equivalente para el **Sistema de Transporte Colectivo (STC) Metro de la Ciudad de México** inspirado en *ScanPaname* (París).

Combina el **GTFS oficial de SEMOVI corregido geométrica y físicamente**, el padrón de **afluencia real 2026**, la **bandeja oficial en vivo de estado del servicio (`incidentesmovilidad.cdmx.gob.mx`)** y una **base de datos propia evolutiva de tiempos reales por tramo y franja horaria** alimentada con un **Modo Cronometrador *offline-first* para túnel**.

---

## Características Principales

- **Renderizado 2.5D / 3D a 60 FPS (`MapLibre GL JS`):**
  - Doble vía paralela suavizada (`4.4 m` de separación entre sentidos) para las **12 líneas** (`1..9, A, B, 12`).
  - **Trenes articulados multi-vagón en 3D** (6, 7 o 9 carros según línea y material rodante `NM-22`, `NM-02`, `MP-68`, `FE-10`) que se curvan orgánicamente en cada curva.
  - **Modo Profundidad Subterránea 3D (Rayos X):** Visualiza la cota real de cada línea (p. ej. Línea 7 a `-34 m` bajo Tacubaya con tiros verticales de estación frente a los viaductos elevados `+9 m` de Línea 4, Línea 9 Oriente y Línea 12).
  - **Cámara a Bordo ("Subirse al tren"):** Seguimiento 3D en tiempo real del convoy seleccionado.
- **Motor Cinemático Trapezoidal Exacto:**
  - Aceleración y frenado físicos diferenciados entre **rodadura neumática** (`1.25 m/s²`) y **rodadura férrea** (`0.96 m/s²` en Líneas A y 12), garantizando parada real en andén y llegada puntual sin saltos.
  - Bloqueo virtual de cantón (anti-colisión) entre trenes consecutivos.
- **Estado Oficial en Vivo + Detección de Líneas Lentas:**
  - Conector con caché *single-flight* (90 s) hacia `incidentesmovilidad.cdmx.gob.mx` (ambas páginas Jakarta/PrimeFaces para cubrir las 12 líneas), activando automáticamente **Marcha de Seguridad por Lluvia** (`+45%` tiempo de recorrido), **Alta Afluencia** o **Incidentes**.
  - Detección estadística de lentitud cuando los cronometrajes recientes superan la base de la franja.
- **Modo Cronometrador *Offline-First* + Anclaje de Fase en Vivo:**
  - Funciona sin señal celular dentro del túnel guardando marcas en `IndexedDB` y sincronizando automáticamente al recuperar conexión.
  - Actualiza los perfiles `(tramo, tipo_día, franja_horaria)` mediante **Media Móvil Exponencial (EMA)** con filtro de *outliers* y permite anclar la fase real de salida de un tren desde cualquier estación.
- **Calculador de Itinerarios en Vivo:** Ruta más rápida considerando tiempos reales por franja, retrasos activos por lluvia y penalización real de caminata en correspondencias largas (Atlalilco, La Raza, Pantitlán).

---

## Ejecución Rápida (Local)

Requisitos: **Node.js 22.5+** (usa `node:sqlite` nativo integrado en Node, sin compilación C++ externa).

```bash
# 1. Instalar dependencias
npm install

# 2. (Opcional — ya pre-generado en data/scancdmx.sqlite y public/data/network-static.json)
# Reconstruir red y base de datos desde GTFS + Afluencia
npm run etl

# 3. Iniciar servidor de desarrollo en http://localhost:3000
npm run dev
```

## Despliegue en Producción (Docker / VPS / Railway / Fly.io)

```bash
docker compose up --build -d
```

El volumen `./data:/app/data` persiste la base de datos SQLite (`scancdmx.sqlite`) con todos los cronometrajes empíricos acumulados.

---

## Aviso Legal y Fuentes de Datos

Proyecto ciudadano e independiente con fines informativos, **sin afiliación oficial con el STC Metro ni la SEMOVI**. El STC Metro no publica GPS en vivo por unidad; las posiciones se estiman mediante cinemática física, perfiles horarios cronometrados y estado operativo oficial.

- Cartografía base y red: *Portal de Datos Abiertos CDMX (SEMOVI)* y *© OpenStreetMap contributors / CARTO*.
- Estado operativo por línea: *Bandeja pública `incidentesmovilidad.cdmx.gob.mx`*.
