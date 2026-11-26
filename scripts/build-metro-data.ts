import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DayType,
  DirectionTrackStatic,
  LineId,
  MetroLineStatic,
  NetworkStaticBundle,
  RollingStockType,
  SegmentStatic,
  StationExitPoint,
  StationStopOnDirection,
  TrackVertex,
} from "../src/types/metro";
import { TIME_BANDS } from "../src/lib/time-bands";

const WORKSPACE_DIR = process.cwd();
const SCRATCH_DIR =
  "C:\\Users\\hugo3\\.gemini\\antigravity\\brain\\fbfbcb85-57e6-4739-9c8a-5a69494bfb07\\scratch";
const GTFS_DIR = path.join(SCRATCH_DIR, "gtfs");
const AFLUENCIA_CSV = path.join(SCRATCH_DIR, "afluencia.csv");

const DATA_DIR = path.join(WORKSPACE_DIR, "data");
const PUBLIC_DATA_DIR = path.join(WORKSPACE_DIR, "public", "data");
const DB_PATH = path.join(DATA_DIR, "scancdmx.sqlite");
const STATIC_JSON_PATH = path.join(PUBLIC_DATA_DIR, "network-static.json");

interface LineEngineeringSpec {
  id: LineId;
  order: number;
  color: string;
  textColor: string;
  rollingStock: RollingStockType;
  trainModel: string;
  carsCount: number;
  trainLengthM: number;
  maxSpeedKmh: number;
  accelMps2: number;
  decelMps2: number;
  defaultDepthM: number;
  hasSurfaceOrElevated: boolean;
  peakHeadwaySec: number;
  elevationResolver: (stationSlug: string, seqRatio: number) => number;
}

const LINE_SPECS: Record<string, LineEngineeringSpec> = {
  "1": {
    id: "1",
    order: 1,
    color: "#F04E98",
    textColor: "#FFFFFF",
    rollingStock: "pneumatic",
    trainModel: "NM-22 / NM-16",
    carsCount: 9,
    trainLengthM: 150,
    maxSpeedKmh: 75,
    accelMps2: 1.28,
    decelMps2: 1.38,
    defaultDepthM: -12,
    hasSurfaceOrElevated: false,
    peakHeadwaySec: 125,
    elevationResolver: (slug) => {
      if (slug.includes("tacubaya") || slug.includes("observatorio")) return -17;
      if (slug.includes("zaragoza") || slug.includes("pantitlan")) return -9;
      return -12;
    },
  },
  "2": {
    id: "2",
    order: 2,
    color: "#005EB8",
    textColor: "#FFFFFF",
    rollingStock: "pneumatic",
    trainModel: "NM-02",
    carsCount: 9,
    trainLengthM: 150,
    maxSpeedKmh: 74,
    accelMps2: 1.25,
    decelMps2: 1.35,
    defaultDepthM: -9,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 125,
    elevationResolver: (slug) => {
      const surface = [
        "tasquena",
        "general-anaya",
        "ermita",
        "portales",
        "nativitas",
        "villa-de-cortes",
        "xola",
        "viaducto",
        "chabacano",
        "san-antonio-abad",
      ];
      if (surface.some((s) => slug.includes(s))) return 0.8;
      return -11;
    },
  },
  "3": {
    id: "3",
    order: 3,
    color: "#AF9800",
    textColor: "#FFFFFF",
    rollingStock: "pneumatic",
    trainModel: "NM-79 / NM-83",
    carsCount: 9,
    trainLengthM: 150,
    maxSpeedKmh: 74,
    accelMps2: 1.22,
    decelMps2: 1.32,
    defaultDepthM: -13,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 130,
    elevationResolver: (slug) => {
      if (
        slug.includes("indios-verdes") ||
        slug.includes("deportivo-18") ||
        slug.includes("potrero") ||
        slug.includes("universidad")
      ) {
        return 0.8;
      }
      return -13.5;
    },
  },
  "4": {
    id: "4",
    order: 4,
    color: "#6BBBAE",
    textColor: "#091E1C",
    rollingStock: "pneumatic",
    trainModel: "NM-73B (6 carros)",
    carsCount: 6,
    trainLengthM: 100,
    maxSpeedKmh: 70,
    accelMps2: 1.22,
    decelMps2: 1.3,
    defaultDepthM: 8.5,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 240,
    elevationResolver: () => 8.5, // 100% Viaducto elevado
  },
  "5": {
    id: "5",
    order: 5,
    color: "#FFD100",
    textColor: "#18181B",
    rollingStock: "pneumatic",
    trainModel: "MP-68R / NM-73",
    carsCount: 9,
    trainLengthM: 150,
    maxSpeedKmh: 72,
    accelMps2: 1.18,
    decelMps2: 1.28,
    defaultDepthM: -7,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 185,
    elevationResolver: (slug) => {
      if (
        slug.includes("la-raza") ||
        slug.includes("misterios") ||
        slug.includes("instituto-del-petroleo") ||
        slug.includes("politecnico")
      ) {
        return -9.5;
      }
      if (slug.includes("consulado")) return 7.5;
      return 0.8;
    },
  },
  "6": {
    id: "6",
    order: 6,
    color: "#DA291C",
    textColor: "#FFFFFF",
    rollingStock: "pneumatic",
    trainModel: "NM-73 / NC-82 (6 carros)",
    carsCount: 6,
    trainLengthM: 100,
    maxSpeedKmh: 72,
    accelMps2: 1.22,
    decelMps2: 1.32,
    defaultDepthM: -16,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 220,
    elevationResolver: (slug) => (slug.includes("el-rosario") ? 0.8 : -16),
  },
  "7": {
    id: "7",
    order: 7,
    color: "#E87722",
    textColor: "#FFFFFF",
    rollingStock: "pneumatic",
    trainModel: "NM-02 / MP-68R96",
    carsCount: 9,
    trainLengthM: 150,
    maxSpeedKmh: 78,
    accelMps2: 1.28,
    decelMps2: 1.38,
    defaultDepthM: -31,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 165,
    elevationResolver: (slug) => {
      if (slug.includes("el-rosario")) return 0.8;
      if (
        slug.includes("camarones") ||
        slug.includes("tacuba") ||
        slug.includes("constituyentes") ||
        slug.includes("tacubaya") ||
        slug.includes("barranca")
      ) {
        return -34;
      }
      return -29;
    },
  },
  "8": {
    id: "8",
    order: 8,
    color: "#009A44",
    textColor: "#FFFFFF",
    rollingStock: "pneumatic",
    trainModel: "NM-79 / NC-82",
    carsCount: 9,
    trainLengthM: 150,
    maxSpeedKmh: 73,
    accelMps2: 1.2,
    decelMps2: 1.3,
    defaultDepthM: -12,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 165,
    elevationResolver: (slug) => {
      if (
        slug.includes("coyuya") ||
        slug.includes("iztacalco") ||
        slug.includes("apatlaco") ||
        slug.includes("aculco") ||
        slug.includes("constitucion")
      ) {
        return 0.8;
      }
      return -12.5;
    },
  },
  "9": {
    id: "9",
    order: 9,
    color: "#512F2E",
    textColor: "#FFFFFF",
    rollingStock: "pneumatic",
    trainModel: "NM-79 / NC-82",
    carsCount: 9,
    trainLengthM: 150,
    maxSpeedKmh: 74,
    accelMps2: 1.22,
    decelMps2: 1.32,
    defaultDepthM: -11,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 150,
    elevationResolver: (slug) => {
      if (
        slug.includes("pantitlan") ||
        slug.includes("puebla") ||
        slug.includes("ciudad-deportiva") ||
        slug.includes("velodromo")
      ) {
        return 9.5; // Viaducto elevado Oriente
      }
      return -13;
    },
  },
  A: {
    id: "A",
    order: 10,
    color: "#981D97",
    textColor: "#FFFFFF",
    rollingStock: "steel",
    trainModel: "FM-86 / FE-07 (Férreo)",
    carsCount: 6,
    trainLengthM: 105,
    maxSpeedKmh: 80,
    accelMps2: 0.96,
    decelMps2: 1.08,
    defaultDepthM: 0.8,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 180,
    elevationResolver: (slug) => (slug.includes("pantitlan") ? -8 : 0.8),
  },
  B: {
    id: "B",
    order: 11,
    color: "#118751",
    textColor: "#FFFFFF",
    rollingStock: "pneumatic",
    trainModel: "MP-68R96",
    carsCount: 9,
    trainLengthM: 150,
    maxSpeedKmh: 74,
    accelMps2: 1.2,
    decelMps2: 1.3,
    defaultDepthM: 3.5,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 155,
    elevationResolver: (slug) => {
      if (
        slug.includes("buenavista") ||
        slug.includes("guerrero") ||
        slug.includes("garibaldi") ||
        slug.includes("lagunilla") ||
        slug.includes("tepito")
      ) {
        return -11;
      }
      if (
        slug.includes("morelos") ||
        slug.includes("san-lazaro") ||
        slug.includes("flores-magon") ||
        slug.includes("romero-rubio") ||
        slug.includes("oceania")
      ) {
        return 8.5; // Viaducto elevado
      }
      return 0.8; // Superficie Av. Central
    },
  },
  "12": {
    id: "12",
    order: 12,
    color: "#C09953",
    textColor: "#0F172A",
    rollingStock: "steel",
    trainModel: "FE-10 CAF (Férreo 7 carros)",
    carsCount: 7,
    trainLengthM: 140,
    maxSpeedKmh: 80,
    accelMps2: 1.0,
    decelMps2: 1.12,
    defaultDepthM: -18,
    hasSurfaceOrElevated: true,
    peakHeadwaySec: 150,
    elevationResolver: (slug) => {
      const underground = [
        "mixcoac",
        "insurgentes-sur",
        "hospital-20",
        "zapata",
        "parque-de-los-venados",
        "eje-central",
        "ermita",
        "mexicaltzingo",
        "atlalilco",
      ];
      if (underground.some((s) => slug.includes(s))) return -19;
      if (slug.includes("tlaltenco") || slug.includes("tlahuac")) return 1.0;
      return 9.5; // Viaducto elevado Av. Tláhuac
    },
  },
};

function slugify(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseCsv(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const splitRow = (row: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') {
        if (inQuotes && row[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = splitRow(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = cols[j] ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

function distMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const cosLat = Math.cos(((lat1 + lat2) * 0.5 * Math.PI) / 180);
  const dx = (lon2 - lon1) * 111320 * cosLat;
  const dy = (lat2 - lat1) * 110540;
  return Math.hypot(dx, dy);
}

function bearingDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const cosLat = Math.cos(((lat1 + lat2) * 0.5 * Math.PI) / 180);
  const dx = (lon2 - lon1) * 111320 * cosLat;
  const dy = (lat2 - lat1) * 110540;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/**
 * Densify long straight chords and apply subtle Chaikin corner-rounding on sharp vertices
 * so trains curve smoothly instead of snapping angles.
 */
function smoothAndOffsetTrack(
  rawPts: [number, number][],
  rightOffsetMeters: number
): [number, number][] {
  if (rawPts.length < 2) return rawPts;

  // Deduplicate near-identical consecutive points
  const dedup: [number, number][] = [rawPts[0]];
  for (let i = 1; i < rawPts.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (distMeters(prev[0], prev[1], rawPts[i][0], rawPts[i][1]) > 1.5) {
      dedup.push(rawPts[i]);
    }
  }
  if (dedup.length < 2) return rawPts;

  // 2 passes of Chaikin corner smoothing only near interior vertices (clamped to 35m from corner so long straights stay straight!)
  let current = dedup;
  for (let pass = 0; pass < 2; pass++) {
    const next: [number, number][] = [current[0]];
    for (let i = 1; i < current.length - 1; i++) {
      const pPrev = current[i - 1];
      const pCurr = current[i];
      const pNext = current[i + 1];

      const dIn = distMeters(pPrev[0], pPrev[1], pCurr[0], pCurr[1]);
      const dOut = distMeters(pCurr[0], pCurr[1], pNext[0], pNext[1]);
      const cutIn = Math.min(0.25, 32 / Math.max(1, dIn));
      const cutOut = Math.min(0.25, 32 / Math.max(1, dOut));

      const q: [number, number] = [
        pCurr[0] + (pPrev[0] - pCurr[0]) * cutIn,
        pCurr[1] + (pPrev[1] - pCurr[1]) * cutIn,
      ];
      const r: [number, number] = [
        pCurr[0] + (pNext[0] - pCurr[0]) * cutOut,
        pCurr[1] + (pNext[1] - pCurr[1]) * cutOut,
      ];
      next.push(q, r);
    }
    next.push(current[current.length - 1]);
    current = next;
  }

  // Offset right-hand normal by +rightOffsetMeters (standard STC right-hand running)
  const offsetPts: [number, number][] = [];
  for (let i = 0; i < current.length; i++) {
    const p = current[i];
    const cosLat = Math.cos((p[1] * Math.PI) / 180);

    let tx = 0;
    let ty = 0;
    if (i > 0) {
      const prev = current[i - 1];
      const vx = (p[0] - prev[0]) * 111320 * cosLat;
      const vy = (p[1] - prev[1]) * 110540;
      const len = Math.hypot(vx, vy);
      if (len > 0.01) {
        tx += vx / len;
        ty += vy / len;
      }
    }
    if (i < current.length - 1) {
      const nxt = current[i + 1];
      const vx = (nxt[0] - p[0]) * 111320 * cosLat;
      const vy = (nxt[1] - p[1]) * 110540;
      const len = Math.hypot(vx, vy);
      if (len > 0.01) {
        tx += vx / len;
        ty += vy / len;
      }
    }
    const tLen = Math.hypot(tx, ty) || 1;
    tx /= tLen;
    ty /= tLen;

    // Right-hand normal in East-North plane: (ty, -tx)
    const nx = ty * rightOffsetMeters;
    const ny = -tx * rightOffsetMeters;

    offsetPts.push([
      Number((p[0] + nx / (111320 * cosLat)).toFixed(7)),
      Number((p[1] + ny / 110540).toFixed(7)),
    ]);
  }

  return offsetPts;
}

function projectPointOntoTrack(
  lon: number,
  lat: number,
  pts: [number, number][],
  cumDist: number[],
  minDistConstraintM: number
): { distM: number; lon: number; lat: number } {
  let bestDistSq = Infinity;
  let bestS = minDistConstraintM;
  let bestLon = pts[0][0];
  let bestLat = pts[0][1];

  const cosLat = Math.cos((lat * Math.PI) / 180);

  for (let i = 0; i < pts.length - 1; i++) {
    if (cumDist[i + 1] < minDistConstraintM - 40) continue;

    const ax = (pts[i][0] - lon) * 111320 * cosLat;
    const ay = (pts[i][1] - lat) * 110540;
    const bx = (pts[i + 1][0] - lon) * 111320 * cosLat;
    const by = (pts[i + 1][1] - lat) * 110540;

    const vx = bx - ax;
    const vy = by - ay;
    const segLenSq = vx * vx + vy * vy;
    let t = segLenSq > 0.001 ? -(ax * vx + ay * vy) / segLenSq : 0;
    t = Math.max(0, Math.min(1, t));

    const px = ax + t * vx;
    const py = ay + t * vy;
    const dSq = px * px + py * py;
    const sCandidate = cumDist[i] + t * (cumDist[i + 1] - cumDist[i]);

    if (sCandidate >= minDistConstraintM - 15 && dSq < bestDistSq) {
      bestDistSq = dSq;
      bestS = Math.max(minDistConstraintM, sCandidate);
      bestLon = pts[i][0] + t * (pts[i + 1][0] - pts[i][0]);
      bestLat = pts[i][1] + t * (pts[i + 1][1] - pts[i][1]);
    }
  }

  return {
    distM: Number(bestS.toFixed(1)),
    lon: Number(bestLon.toFixed(6)),
    lat: Number(bestLat.toFixed(6)),
  };
}

function estimateMinCurveRadius(
  vertices: TrackVertex[],
  startDistM: number,
  endDistM: number
): number {
  let minRadius = 1200;
  const sub = vertices.filter((v) => v[2] >= startDistM && v[2] <= endDistM);
  for (let i = 1; i < sub.length - 1; i++) {
    const b1 = sub[i - 1][4];
    const b2 = sub[i][4];
    let diff = Math.abs(b2 - b1);
    if (diff > 180) diff = 360 - diff;
    const arcLen = Math.max(8, sub[i + 1][2] - sub[i - 1][2]);
    if (diff > 2.5) {
      const rad = (diff * Math.PI) / 180;
      const r = arcLen / rad;
      if (r < minRadius) minRadius = r;
    }
  }
  return Math.round(Math.max(95, minRadius));
}

function loadAverage2026Ridership(): Map<string, number> {
  const ridershipMap = new Map<string, number>();
  if (!fs.existsSync(AFLUENCIA_CSV)) {
    console.warn("Afluencia CSV not found, using calibrated fallback ridership.");
    return ridershipMap;
  }

  const content = fs.readFileSync(AFLUENCIA_CSV, "latin1");
  const lines = content.split(/\r?\n/);
  const sums = new Map<string, { total: number; days: number }>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("2026-")) continue;
    const cols = line.split(",");
    if (cols.length < 6) continue;
    const rawLinea = cols[3];
    const rawEst = cols[4];
    const val = Number(cols[5]);
    if (!Number.isFinite(val) || val <= 0) continue;

    const lineKey = rawLinea
      .replace(/[^0-9ABab]/g, "")
      .toUpperCase();
    const stSlug = slugify(rawEst);
    const key = `${lineKey}:${stSlug}`;
    const entry = sums.get(key) ?? { total: 0, days: 0 };
    entry.total += val;
    entry.days += 1;
    sums.set(key, entry);
  }

  for (const [k, v] of sums.entries()) {
    ridershipMap.set(k, Math.round(v.total / Math.max(1, v.days)));
  }
  console.log(`Loaded 2026 ridership averages for ${ridershipMap.size} station-line pairs.`);
  return ridershipMap;
}

function computePhysicalBaseRunTimeSec(
  spec: LineEngineeringSpec,
  lengthM: number,
  minCurveRadiusM: number
): number {
  // Curve speed limit: v_curve <= sqrt(a_lat_max * R), with a_lat_max ~ 0.95 m/s^2
  const curveCapMps = Math.sqrt(0.95 * minCurveRadiusM);
  const lineMaxMps = (spec.maxSpeedKmh / 3.6) * 0.88; // Operational commercial cruise ~88% of design max
  const vTarget = Math.min(lineMaxMps, curveCapMps);

  const tAccel = vTarget / spec.accelMps2;
  const tDecel = vTarget / spec.decelMps2;
  const dAccelDecel = 0.5 * vTarget * (tAccel + tDecel);

  let rawTime: number;
  if (dAccelDecel >= lengthM) {
    // Triangular profile on very short station spacing
    const k = 0.5 / spec.accelMps2 + 0.5 / spec.decelMps2;
    const vPeak = Math.sqrt(lengthM / k);
    rawTime = vPeak * (1 / spec.accelMps2 + 1 / spec.decelMps2);
  } else {
    rawTime = tAccel + tDecel + (lengthM - dAccelDecel) / vTarget;
  }

  // Add 6 seconds PA-135 / SACEM station entry approach margin & door interlock
  return Math.round(Math.max(32, rawTime + 6));
}

async function main() {
  console.log("=== ScanCDMX ETL: Building Metro CDMX Network & Empirical Timing DB ===");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });

  const routesRows = parseCsv(path.join(GTFS_DIR, "routes.txt")).filter(
    (r) => r.agency_id === "METRO"
  );
  const tripsRows = parseCsv(path.join(GTFS_DIR, "trips.txt"));
  const stopsRows = parseCsv(path.join(GTFS_DIR, "stops.txt"));
  const stopTimesRows = parseCsv(path.join(GTFS_DIR, "stop_times.txt"));
  const shapesRows = parseCsv(path.join(GTFS_DIR, "shapes.txt"));

  const stopsById = new Map<string, Record<string, string>>();
  for (const s of stopsRows) {
    if (s.stop_id.startsWith("B_02")) stopsById.set(s.stop_id, s);
  }

  const ridershipByKey = loadAverage2026Ridership();

  // Map Metro trip_ids (Weekday B_1 has 1 trip per direction per line, normalizing the calendar.txt 20251231 bug)
  const metroRouteIds = new Set(routesRows.map((r) => r.route_id));
  const weekdayTrips = tripsRows.filter(
    (t) => metroRouteIds.has(t.route_id) && t.service_id === "B_1"
  );
  const neededTripIds = new Set(weekdayTrips.map((t) => t.trip_id));
  const neededShapeIds = new Set(weekdayTrips.map((t) => t.shape_id));

  const stopTimesByTrip = new Map<string, Record<string, string>[]>();
  for (const st of stopTimesRows) {
    if (!neededTripIds.has(st.trip_id)) continue;
    const arr = stopTimesByTrip.get(st.trip_id) ?? [];
    arr.push(st);
    stopTimesByTrip.set(st.trip_id, arr);
  }
  for (const arr of stopTimesByTrip.values()) {
    arr.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  }

  const shapesByShapeId = new Map<string, [number, number, number][]>();
  for (const sh of shapesRows) {
    if (!neededShapeIds.has(sh.shape_id)) continue;
    const arr = shapesByShapeId.get(sh.shape_id) ?? [];
    arr.push([
      Number(sh.shape_pt_lon),
      Number(sh.shape_pt_lat),
      Number(sh.shape_pt_sequence),
    ]);
    shapesByShapeId.set(sh.shape_id, arr);
  }
  for (const arr of shapesByShapeId.values()) {
    arr.sort((a, b) => a[2] - b[2]);
  }

  // First pass: identify transfer stations across all 12 lines by normalized station slug
  const slugToLines = new Map<string, Set<LineId>>();
  for (const r of routesRows) {
    const shortRaw = r.route_short_name.replace(/^L/i, "").toUpperCase() as LineId;
    const t0 = weekdayTrips.find((t) => t.route_id === r.route_id);
    if (!t0) continue;
    for (const st of stopTimesByTrip.get(t0.trip_id) ?? []) {
      const stop = stopsById.get(st.stop_id);
      if (!stop) continue;
      const slug = slugify(stop.stop_name);
      const set = slugToLines.get(slug) ?? new Set<LineId>();
      set.add(shortRaw);
      slugToLines.set(slug, set);
    }
  }

  const linesStatic: MetroLineStatic[] = [];
  const exitsStatic: StationExitPoint[] = [];
  const exitedStationKeys = new Set<string>();

  for (const r of routesRows) {
    const lineId = r.route_short_name.replace(/^L/i, "").toUpperCase() as LineId;
    const spec = LINE_SPECS[lineId];
    if (!spec) continue;

    const dirMap: Partial<Record<"0" | "1", DirectionTrackStatic>> = {};

    for (const dirNum of [0, 1] as const) {
      const trip = weekdayTrips.find(
        (t) =>
          t.route_id === r.route_id &&
          Math.round(Number(t.direction_id)) === dirNum
      );
      if (!trip) continue;

      const rawShape = (shapesByShapeId.get(trip.shape_id) ?? []).map(
        (p) => [p[0], p[1]] as [number, number]
      );
      // Offset +2.2m to the right of travel direction -> 4.4m parallel dual tracks!
      const offsetPts = smoothAndOffsetTrack(rawShape, 2.2);

      const cumDist: number[] = [0];
      for (let i = 1; i < offsetPts.length; i++) {
        cumDist.push(
          cumDist[i - 1] +
            distMeters(
              offsetPts[i - 1][0],
              offsetPts[i - 1][1],
              offsetPts[i][0],
              offsetPts[i][1]
            )
        );
      }
      const totalLengthM = Number(cumDist[cumDist.length - 1].toFixed(1));

      // Project stations cleanly onto offset track in monotonic sequence
      const stRows = stopTimesByTrip.get(trip.trip_id) ?? [];
      const stations: StationStopOnDirection[] = [];
      let prevDistM = 0;

      for (let idx = 0; idx < stRows.length; idx++) {
        const stopRow = stopsById.get(stRows[idx].stop_id)!;
        const name = stopRow.stop_name.trim();
        const slug = slugify(name);
        const rawLon = Number(stopRow.stop_lon);
        const rawLat = Number(stopRow.stop_lat);

        let proj: { distM: number; lon: number; lat: number };
        if (idx === 0) {
          proj = { distM: 0, lon: offsetPts[0][0], lat: offsetPts[0][1] };
        } else if (idx === stRows.length - 1) {
          proj = {
            distM: totalLengthM,
            lon: offsetPts[offsetPts.length - 1][0],
            lat: offsetPts[offsetPts.length - 1][1],
          };
        } else {
          proj = projectPointOntoTrack(
            rawLon,
            rawLat,
            offsetPts,
            cumDist,
            prevDistM + 120
          );
        }
        prevDistM = proj.distM;

        const linesHere = Array.from(slugToLines.get(slug) ?? [lineId]).filter(
          (l) => l !== lineId
        );
        const rid =
          ridershipByKey.get(`${lineId}:${slug}`) ??
          (linesHere.length > 0 ? 26000 : 12500);
        const elev = spec.elevationResolver(slug, idx / Math.max(1, stRows.length - 1));

        const stationId = `L${lineId}-${slug}`;
        stations.push({
          stationId,
          name,
          slug,
          sequence: idx + 1,
          lon: proj.lon,
          lat: proj.lat,
          distAlongTrackM: proj.distM,
          elevationM: elev,
          isTransfer: linesHere.length > 0,
          transferLines: linesHere,
          isTerminal: idx === 0 || idx === stRows.length - 1,
          dailyRidership: rid,
        });

        // Generate 2 realistic street exits per station (once per stationId)
        if (!exitedStationKeys.has(stationId)) {
          exitedStationKeys.add(stationId);
          const cosLat = Math.cos((proj.lat * Math.PI) / 180);
          exitsStatic.push(
            {
              id: `${stationId}-EX1`,
              stationId,
              lineId,
              label: "Acceso A",
              lon: Number((rawLon + 22 / (111320 * cosLat)).toFixed(6)),
              lat: Number((rawLat + 14 / 110540).toFixed(6)),
            },
            {
              id: `${stationId}-EX2`,
              stationId,
              lineId,
              label: "Acceso B",
              lon: Number((rawLon - 22 / (111320 * cosLat)).toFixed(6)),
              lat: Number((rawLat - 14 / 110540).toFixed(6)),
            }
          );
        }
      }

      // Interpolate smooth elevation ramp along track vertices between stations
      const vertices: TrackVertex[] = [];
      let stCursor = 0;
      for (let i = 0; i < offsetPts.length; i++) {
        const d = cumDist[i];
        while (
          stCursor < stations.length - 2 &&
          d > stations[stCursor + 1].distAlongTrackM
        ) {
          stCursor++;
        }
        const sA = stations[stCursor];
        const sB = stations[Math.min(stCursor + 1, stations.length - 1)];
        const span = sB.distAlongTrackM - sA.distAlongTrackM;
        const ratio = span > 1 ? Math.max(0, Math.min(1, (d - sA.distAlongTrackM) / span)) : 0;
        // Cosine smoothstep for realistic tunnel-to-surface/viaduct ramps!
        const smoothT = (1 - Math.cos(ratio * Math.PI)) * 0.5;
        const elev = Number(
          (sA.elevationM + (sB.elevationM - sA.elevationM) * smoothT).toFixed(2)
        );

        const pNext = offsetPts[Math.min(i + 1, offsetPts.length - 1)];
        const pPrev = offsetPts[Math.max(i - 1, 0)];
        const brg = Number(
          bearingDeg(pPrev[0], pPrev[1], pNext[0], pNext[1]).toFixed(1)
        );

        vertices.push([
          offsetPts[i][0],
          offsetPts[i][1],
          Number(d.toFixed(1)),
          elev,
          brg,
        ]);
      }

      // Build directed inter-station segments
      const segments: SegmentStatic[] = [];
      for (let i = 0; i < stations.length - 1; i++) {
        const fromSt = stations[i];
        const toSt = stations[i + 1];
        const lengthM = Number(
          Math.max(150, toSt.distAlongTrackM - fromSt.distAlongTrackM).toFixed(1)
        );
        const minCurveR = estimateMinCurveRadius(
          vertices,
          fromSt.distAlongTrackM,
          toSt.distAlongTrackM
        );
        segments.push({
          id: `L${lineId}-D${dirNum}-S${String(i + 1).padStart(2, "0")}`,
          lineId,
          directionId: dirNum,
          sequence: i + 1,
          fromStationId: fromSt.stationId,
          toStationId: toSt.stationId,
          fromName: fromSt.name,
          toName: toSt.name,
          startDistM: fromSt.distAlongTrackM,
          endDistM: toSt.distAlongTrackM,
          lengthM,
          minCurveRadiusM: minCurveR,
        });
      }

      const lastStationName = stations[stations.length - 1]?.name ?? trip.trip_headsign;
      dirMap[String(dirNum) as "0" | "1"] = {
        directionId: dirNum,
        headsign: lastStationName,
        totalLengthM,
        vertices,
        stations,
        segments,
      };
    }

    if (dirMap["0"] && dirMap["1"]) {
      const originName = dirMap["0"].stations[0].name;
      const destName = dirMap["0"].stations[dirMap["0"].stations.length - 1].name;
      linesStatic.push({
        id: spec.id,
        routeGtfsId: r.route_id,
        name: `Línea ${spec.id}`,
        originName,
        destinationName: destName,
        color: spec.color,
        textColor: spec.textColor,
        rollingStock: spec.rollingStock,
        trainModel: spec.trainModel,
        carsCount: spec.carsCount,
        trainLengthM: spec.trainLengthM,
        maxSpeedKmh: spec.maxSpeedKmh,
        accelMps2: spec.accelMps2,
        decelMps2: spec.decelMps2,
        defaultDepthM: spec.defaultDepthM,
        hasSurfaceOrElevated: spec.hasSurfaceOrElevated,
        totalLengthKm: Number((dirMap["0"].totalLengthM / 1000).toFixed(2)),
        directions: {
          "0": dirMap["0"],
          "1": dirMap["1"],
        },
      });
    }
  }

  linesStatic.sort(
    (a, b) => LINE_SPECS[a.id].order - LINE_SPECS[b.id].order
  );

  const bundle: NetworkStaticBundle = {
    generatedAt: new Date().toISOString(),
    sourceGtfsModified: "2026-09-01",
    lines: linesStatic,
    exits: exitsStatic,
  };

  fs.writeFileSync(STATIC_JSON_PATH, JSON.stringify(bundle));
  const jsonKb = Math.round(fs.statSync(STATIC_JSON_PATH).size / 1024);
  console.log(
    `Wrote ${STATIC_JSON_PATH} (${jsonKb} KB) with ${linesStatic.length} lines.`
  );

  // Initialize & seed SQLite database
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE lines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      origin_name TEXT NOT NULL,
      destination_name TEXT NOT NULL,
      color TEXT NOT NULL,
      rolling_stock TEXT NOT NULL,
      train_model TEXT NOT NULL,
      cars_count INTEGER NOT NULL,
      train_length_m REAL NOT NULL,
      default_depth_m REAL NOT NULL,
      has_surface_or_elevated INTEGER NOT NULL,
      total_length_km REAL NOT NULL
    );

    CREATE TABLE segments (
      id TEXT PRIMARY KEY,
      line_id TEXT NOT NULL,
      direction_id INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      from_station_id TEXT NOT NULL,
      to_station_id TEXT NOT NULL,
      from_name TEXT NOT NULL,
      to_name TEXT NOT NULL,
      length_m REAL NOT NULL,
      min_curve_radius_m REAL NOT NULL,
      origin_ridership INTEGER NOT NULL,
      origin_is_transfer INTEGER NOT NULL,
      origin_is_terminal INTEGER NOT NULL
    );

    CREATE TABLE segment_travel_profiles (
      segment_id TEXT NOT NULL,
      day_type TEXT NOT NULL,
      time_band_id TEXT NOT NULL,
      run_time_sec REAL NOT NULL,
      base_physics_sec REAL NOT NULL,
      p85_run_time_sec REAL NOT NULL,
      rain_run_time_sec REAL NOT NULL,
      dwell_origin_sec REAL NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'synthetic_physics',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (segment_id, day_type, time_band_id)
    );

    CREATE TABLE headway_profiles (
      line_id TEXT NOT NULL,
      day_type TEXT NOT NULL,
      time_band_id TEXT NOT NULL,
      headway_sec INTEGER NOT NULL,
      PRIMARY KEY (line_id, day_type, time_band_id)
    );

    CREATE TABLE live_line_status (
      line_id TEXT PRIMARY KEY,
      official_status_text TEXT NOT NULL,
      affected_stations_raw TEXT NOT NULL,
      extra_info_raw TEXT NOT NULL,
      regime TEXT NOT NULL,
      speed_multiplier REAL NOT NULL,
      dwell_multiplier REAL NOT NULL,
      headway_multiplier REAL NOT NULL,
      phase_offset_dir0_sec REAL NOT NULL DEFAULT 0,
      phase_offset_dir1_sec REAL NOT NULL DEFAULT 0,
      last_phase_anchor_dir0_at TEXT,
      last_phase_anchor_dir1_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE empirical_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      obs_type TEXT NOT NULL,
      line_id TEXT NOT NULL,
      direction_id INTEGER NOT NULL,
      segment_id TEXT,
      station_id TEXT,
      day_type TEXT NOT NULL,
      time_band_id TEXT NOT NULL,
      duration_sec REAL,
      baseline_at_obs_sec REAL,
      weather TEXT NOT NULL DEFAULT 'dry',
      observer_tag TEXT NOT NULL DEFAULT 'manual',
      notes TEXT,
      recorded_at TEXT NOT NULL
    );

    CREATE INDEX idx_obs_line_time ON empirical_observations(line_id, recorded_at DESC);
    CREATE INDEX idx_obs_segment ON empirical_observations(segment_id);
  `);

  const nowIso = new Date().toISOString();
  const dayTypes: DayType[] = ["weekday", "saturday", "sunday"];

  const insLine = db.prepare(`
    INSERT INTO lines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insSeg = db.prepare(`
    INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insProf = db.prepare(`
    INSERT INTO segment_travel_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insHeadway = db.prepare(`
    INSERT INTO headway_profiles VALUES (?, ?, ?, ?)
  `);
  const insLive = db.prepare(`
    INSERT INTO live_line_status VALUES (?, 'Servicio Regular', 'Ninguna', '', 'REGULAR', 1.0, 1.0, 1.0, 0, 0, NULL, NULL, ?)
  `);

  db.exec("BEGIN TRANSACTION");

  let totalSegments = 0;
  let totalProfiles = 0;

  for (const line of linesStatic) {
    const spec = LINE_SPECS[line.id];
    insLine.run(
      line.id,
      line.name,
      line.originName,
      line.destinationName,
      line.color,
      line.rollingStock,
      line.trainModel,
      line.carsCount,
      line.trainLengthM,
      line.defaultDepthM,
      line.hasSurfaceOrElevated ? 1 : 0,
      line.totalLengthKm
    );
    insLive.run(line.id, nowIso);

    for (const dt of dayTypes) {
      const dayHeadwayScale = dt === "weekday" ? 1.0 : dt === "saturday" ? 1.22 : 1.42;
      for (const tb of TIME_BANDS) {
        const hw = Math.round(spec.peakHeadwaySec * dayHeadwayScale * tb.headwayFactor);
        insHeadway.run(line.id, dt, tb.id, hw);
      }
    }

    for (const dirKey of ["0", "1"] as const) {
      const dir = line.directions[dirKey];
      for (let i = 0; i < dir.segments.length; i++) {
        const seg = dir.segments[i];
        const originSt = dir.stations[i];
        totalSegments++;

        insSeg.run(
          seg.id,
          line.id,
          seg.directionId,
          seg.sequence,
          seg.fromStationId,
          seg.toStationId,
          seg.fromName,
          seg.toName,
          seg.lengthM,
          seg.minCurveRadiusM,
          originSt.dailyRidership,
          originSt.isTransfer ? 1 : 0,
          originSt.isTerminal ? 1 : 0
        );

        const basePhysSec = computePhysicalBaseRunTimeSec(
          spec,
          seg.lengthM,
          seg.minCurveRadiusM
        );

        // Ridership-weighted station dwell (16s light station -> 52s mega-transfer in rush hour)
        const ridershipFactor = Math.min(
          1.0,
          Math.max(0, (originSt.dailyRidership - 6000) / 55000)
        );
        const nominalDwell =
          16 +
          ridershipFactor * 18 +
          (originSt.isTransfer ? 11 : 0) +
          (originSt.isTerminal ? 14 : 0);

        for (const dt of dayTypes) {
          const dayDemand = dt === "weekday" ? 1.0 : dt === "saturday" ? 0.84 : 0.72;
          for (const tb of TIME_BANDS) {
            const load = dayDemand * tb.demandFactor;
            // Heavy train mass + signaling regulation in peak hours adds 4%-9% run time
            const runSec = Math.round(basePhysSec * (1 + Math.max(0, load - 0.85) * 0.12));
            const p85Sec = Math.round(runSec * 1.18);
            const rainSec = spec.hasSurfaceOrElevated
              ? Math.round(runSec * 1.45)
              : Math.round(runSec * 1.06);
            const dwellSec = Math.round(
              Math.max(14, nominalDwell * (0.72 + 0.35 * load))
            );

            insProf.run(
              seg.id,
              dt,
              tb.id,
              runSec,
              basePhysSec,
              p85Sec,
              rainSec,
              dwellSec,
              0,
              "synthetic_physics",
              nowIso
            );
            totalProfiles++;
          }
        }
      }
    }
  }

  db.exec("COMMIT");
  db.close();

  console.log(
    `Seeded ${DB_PATH}: ${linesStatic.length} lines, ${totalSegments} directed segments, ${totalProfiles} time-band profiles.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
