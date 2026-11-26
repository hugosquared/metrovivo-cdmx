import type {
  DirectionTrackStatic,
  LineId,
  LiveSystemSnapshot,
  MetroLineStatic,
  NetworkStaticBundle,
  TrackVertex,
} from "@/types/metro";
import {
  getCdmxDateParts,
  getServiceStartSec,
  isWithinServiceHours,
} from "./time-bands";

export interface ArticulatedCarPose {
  carIndex: number;
  lon: number;
  lat: number;
  elevationM: number;
  bearingDeg: number;
  pitchDeg: number;
  lengthM: number;
  isLead: boolean;
  isTail: boolean;
}

export interface ActiveTrainPose {
  id: string;
  runNumber: number;
  lineId: LineId;
  lineColor: string;
  lineTextColor: string;
  trainModel: string;
  rollingStock: "pneumatic" | "steel";
  directionId: 0 | 1;
  headsign: string;
  distAlongTrackM: number;
  totalTrackLengthM: number;
  lon: number;
  lat: number;
  elevationM: number;
  bearingDeg: number;
  speedKmh: number;
  state: "DWELLING" | "ACCELERATING" | "CRUISING" | "BRAKING" | "HELD_SIGNAL";
  currentOrPrevStationName: string;
  nextStationName: string;
  nextStationEtaSec: number;
  progressInSegment: number; // 0..1
  confidenceTier: 1 | 2 | 3;
  isDelayed: boolean;
  cars: ArticulatedCarPose[];
}

export interface StationArrivalPrediction {
  trainId: string;
  runNumber: number;
  directionId: 0 | 1;
  headsign: string;
  etaSec: number;
  state: string;
  confidenceTier: 1 | 2 | 3;
}

/**
 * Exact Trapezoidal / Triangular Kinematic Solver.
 * Guarantees s(0) = 0, s(T_run) = L, v(0) = 0, v(T_run) = 0.
 */
export function solveTrapezoidalKinematics(
  tauSec: number,
  runTimeSec: number,
  lengthM: number,
  accelMps2: number,
  decelMps2: number
): {
  distM: number;
  speedMps: number;
  phase: "ACCELERATING" | "CRUISING" | "BRAKING";
} {
  if (tauSec <= 0 || runTimeSec <= 0 || lengthM <= 0) {
    return { distM: 0, speedMps: 0, phase: "ACCELERATING" };
  }
  if (tauSec >= runTimeSec) {
    return { distM: lengthM, speedMps: 0, phase: "BRAKING" };
  }

  const a1 = Math.max(0.4, accelMps2);
  const a2 = Math.max(0.4, decelMps2);
  const k = 0.5 / a1 + 0.5 / a2;
  const discriminant = runTimeSec * runTimeSec - 4 * k * lengthM;

  if (discriminant >= 0) {
    // Standard trapezoidal speed profile (accel -> constant cruise -> brake)
    const vCruise = (runTimeSec - Math.sqrt(discriminant)) / (2 * k);
    const t1 = vCruise / a1;
    const t2 = runTimeSec - vCruise / a2;

    if (tauSec < t1) {
      return {
        distM: 0.5 * a1 * tauSec * tauSec,
        speedMps: a1 * tauSec,
        phase: "ACCELERATING",
      };
    } else if (tauSec <= t2) {
      const d1 = 0.5 * a1 * t1 * t1;
      return {
        distM: d1 + vCruise * (tauSec - t1),
        speedMps: vCruise,
        phase: "CRUISING",
      };
    } else {
      const rem = runTimeSec - tauSec;
      return {
        distM: Math.max(0, lengthM - 0.5 * a2 * rem * rem),
        speedMps: a2 * rem,
        phase: "BRAKING",
      };
    }
  } else {
    // Short segment or fast run -> Triangular speed profile with scaled accel/decel
    const ratio = a2 / (a1 + a2);
    const tPeak = runTimeSec * ratio;
    const vPeak = (2 * lengthM) / runTimeSec;
    const a1Eff = vPeak / Math.max(0.01, tPeak);
    const a2Eff = vPeak / Math.max(0.01, runTimeSec - tPeak);

    if (tauSec < tPeak) {
      return {
        distM: 0.5 * a1Eff * tauSec * tauSec,
        speedMps: a1Eff * tauSec,
        phase: "ACCELERATING",
      };
    } else {
      const rem = runTimeSec - tauSec;
      return {
        distM: Math.max(0, lengthM - 0.5 * a2Eff * rem * rem),
        speedMps: a2Eff * rem,
        phase: "BRAKING",
      };
    }
  }
}

/**
 * Binary search O(log V) along cumulative track vertices.
 */
export function sampleTrackAtDistance(
  vertices: TrackVertex[],
  distM: number
): {
  lon: number;
  lat: number;
  elevationM: number;
  bearingDeg: number;
} {
  const n = vertices.length;
  if (n === 0) return { lon: -99.1332, lat: 19.4326, elevationM: 0, bearingDeg: 0 };
  if (distM <= vertices[0][2]) {
    return {
      lon: vertices[0][0],
      lat: vertices[0][1],
      elevationM: vertices[0][3],
      bearingDeg: vertices[0][4],
    };
  }
  const last = vertices[n - 1];
  if (distM >= last[2]) {
    return {
      lon: last[0],
      lat: last[1],
      elevationM: last[3],
      bearingDeg: last[4],
    };
  }

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (vertices[mid][2] <= distM) lo = mid;
    else hi = mid;
  }

  const v0 = vertices[lo];
  const v1 = vertices[hi];
  const segLen = v1[2] - v0[2];
  const t = segLen > 0.001 ? (distM - v0[2]) / segLen : 0;

  const lon = v0[0] + (v1[0] - v0[0]) * t;
  const lat = v0[1] + (v1[1] - v0[1]) * t;
  const elevationM = v0[3] + (v1[3] - v0[3]) * t;

  return {
    lon,
    lat,
    elevationM,
    bearingDeg: v0[4],
  };
}

function computeBearingDeg(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  fallback: number
): number {
  const cosLat = Math.cos(((lat1 + lat2) * 0.5 * Math.PI) / 180);
  const dx = (lon2 - lon1) * 111320 * cosLat;
  const dy = (lat2 - lat1) * 110540;
  if (dx * dx + dy * dy < 0.01) return fallback;
  const rad = Math.atan2(dx, dy);
  return ((rad * 180) / Math.PI + 360) % 360;
}

/**
 * Builds articulated individual subway cars behind head position D_head.
 */
export function buildArticulatedCars(
  vertices: TrackVertex[],
  headDistM: number,
  carsCount: number,
  trainLengthM: number
): ArticulatedCarPose[] {
  const spacing = trainLengthM / carsCount;
  const carBodyLen = spacing * 0.91; // leaves subtle realistic gangway gap between cars
  const halfBogie = carBodyLen * 0.38;
  const cars: ArticulatedCarPose[] = [];

  for (let i = 0; i < carsCount; i++) {
    const centerDist = Math.max(
      halfBogie,
      headDistM - (i + 0.5) * spacing
    );
    const frontBogie = sampleTrackAtDistance(vertices, centerDist + halfBogie);
    const rearBogie = sampleTrackAtDistance(
      vertices,
      Math.max(0, centerDist - halfBogie)
    );

    const lon = (frontBogie.lon + rearBogie.lon) * 0.5;
    const lat = (frontBogie.lat + rearBogie.lat) * 0.5;
    const elevationM = (frontBogie.elevationM + rearBogie.elevationM) * 0.5;
    const bearingDeg = computeBearingDeg(
      rearBogie.lon,
      rearBogie.lat,
      frontBogie.lon,
      frontBogie.lat,
      frontBogie.bearingDeg
    );
    const dz = frontBogie.elevationM - rearBogie.elevationM;
    const pitchDeg = (Math.atan2(dz, halfBogie * 2) * 180) / Math.PI;

    cars.push({
      carIndex: i,
      lon,
      lat,
      elevationM,
      bearingDeg,
      pitchDeg,
      lengthM: carBodyLen,
      isLead: i === 0,
      isTail: i === carsCount - 1,
    });
  }
  return cars;
}

interface CompiledStopScheduleNode {
  stationIdx: number;
  stationName: string;
  distM: number;
  arriveOffsetSec: number;
  departOffsetSec: number;
  segmentIdNext: string | null;
  segmentLenNextM: number;
  runTimeNextSec: number;
}

function compileDirectionProfile(
  line: MetroLineStatic,
  dir: DirectionTrackStatic,
  snapshot: LiveSystemSnapshot
): {
  nodes: CompiledStopScheduleNode[];
  totalTripDurationSec: number;
} {
  const lineLive = snapshot.lines[line.id];
  const speedMult = lineLive ? lineLive.speedMultiplier : 1.0;
  const dwellMult = lineLive ? lineLive.dwellMultiplier : 1.0;
  const empiricalRatio =
    lineLive && lineLive.empiricalSlownessRatio > 1.05
      ? Math.min(1.6, lineLive.empiricalSlownessRatio)
      : 1.0;
  const effectiveSpeedMult = Math.max(speedMult, empiricalRatio);

  const nodes: CompiledStopScheduleNode[] = [];
  let cursorSec = 0;

  for (let i = 0; i < dir.stations.length; i++) {
    const st = dir.stations[i];
    const seg = i < dir.segments.length ? dir.segments[i] : null;
    const timing = seg ? snapshot.timings[seg.id] : undefined;

    const baseDwell = timing ? timing.dwellAtOriginSec : st.isTransfer ? 32 : 20;
    const dwellSec =
      i === dir.stations.length - 1
        ? 25 // arrival discharge at terminal
        : Math.round(baseDwell * dwellMult);

    const arriveSec = cursorSec;
    const departSec = arriveSec + dwellSec;

    let runNext = 0;
    if (seg) {
      const rawRun = timing ? timing.runTimeSec : Math.max(35, seg.lengthM / 10.5);
      runNext = Math.max(22, rawRun * effectiveSpeedMult);
    }

    nodes.push({
      stationIdx: i,
      stationName: st.name,
      distM: st.distAlongTrackM,
      arriveOffsetSec: arriveSec,
      departOffsetSec: departSec,
      segmentIdNext: seg ? seg.id : null,
      segmentLenNextM: seg ? seg.lengthM : 0,
      runTimeNextSec: runNext,
    });

    cursorSec = departSec + runNext;
  }

  return {
    nodes,
    totalTripDurationSec: cursorSec,
  };
}

/**
 * Generates deterministic, phase-anchored, collision-free poses for all active trains across the network.
 */
export function computeAllActiveTrains(
  network: NetworkStaticBundle,
  snapshot: LiveSystemSnapshot,
  timestampMs: number,
  enabledLines?: Set<LineId>,
  buildFullCars: boolean = true
): ActiveTrainPose[] {
  const cdmx = getCdmxDateParts(timestampMs);
  if (!isWithinServiceHours(cdmx.secondsOfDay, cdmx.dayType)) {
    return [];
  }

  const serviceStartSec = getServiceStartSec(cdmx.dayType);
  const allTrains: ActiveTrainPose[] = [];

  for (const line of network.lines) {
    if (enabledLines && !enabledLines.has(line.id)) continue;
    const lineState = snapshot.lines[line.id];
    if (!lineState || lineState.regime === "SUSPENDED") continue;

    const headwaySec = Math.max(
      95,
      Math.round(lineState.headwaySec * lineState.headwayMultiplier)
    );

    for (const dirKey of ["0", "1"] as const) {
      const dirId: 0 | 1 = dirKey === "0" ? 0 : 1;
      const dir = line.directions[dirKey];
      if (dir.stations.length < 2) continue;

      const { nodes, totalTripDurationSec } = compileDirectionProfile(
        line,
        dir,
        snapshot
      );

      // Phase offset: deterministic line/dir seed + live empirical phase anchor
      const seedOffset =
        ((line.id.charCodeAt(0) * 37 + dirId * 53) % headwaySec) * 0.5;
      const liveAnchorOffset =
        dirId === 0
          ? lineState.phaseOffsetDir0Sec
          : lineState.phaseOffsetDir1Sec;
      const netPhaseOffset =
        (((seedOffset + liveAnchorOffset) % headwaySec) + headwaySec) %
        headwaySec;

      // Determine all runs k whose trip spans cdmx.secondsOfDay
      const earliestDepartureNeeded = cdmx.secondsOfDay - totalTripDurationSec;
      const kMin = Math.max(
        0,
        Math.floor((earliestDepartureNeeded - serviceStartSec - netPhaseOffset) / headwaySec)
      );
      const kMax = Math.floor(
        (cdmx.secondsOfDay - serviceStartSec - netPhaseOffset) / headwaySec
      );

      const dirTrains: ActiveTrainPose[] = [];

      for (let k = kMin; k <= kMax; k++) {
        const depTerminalSec = serviceStartSec + netPhaseOffset + k * headwaySec;
        if (depTerminalSec > 24 * 3600 + 5 * 60) continue; // No new terminal dispatches after 00:05

        const elapsedTripSec = cdmx.secondsOfDay - depTerminalSec;
        if (elapsedTripSec < 0 || elapsedTripSec > totalTripDurationSec) continue;

        // Locate current station dwell or inter-station run
        let distM = 0;
        let speedMps = 0;
        let state: ActiveTrainPose["state"] = "DWELLING";
        let currStationName = nodes[0].stationName;
        let nextStationName =
          nodes[Math.min(1, nodes.length - 1)].stationName;
        let nextEtaSec = 0;
        let progress = 0;

        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (
            elapsedTripSec >= node.arriveOffsetSec &&
            elapsedTripSec <= node.departOffsetSec
          ) {
            distM = node.distM;
            speedMps = 0;
            state = "DWELLING";
            currStationName = node.stationName;
            const nextNode = nodes[Math.min(i + 1, nodes.length - 1)];
            nextStationName = nextNode.stationName;
            nextEtaSec = Math.max(0, nextNode.arriveOffsetSec - elapsedTripSec);
            progress = 0;
            break;
          }

          if (i < nodes.length - 1) {
            const nextNode = nodes[i + 1];
            if (
              elapsedTripSec > node.departOffsetSec &&
              elapsedTripSec < nextNode.arriveOffsetSec
            ) {
              const tau = elapsedTripSec - node.departOffsetSec;
              const effAccel =
                lineState.regime === "RAIN_SLOW"
                  ? line.accelMps2 * 0.68
                  : line.accelMps2;
              const effDecel =
                lineState.regime === "RAIN_SLOW"
                  ? line.decelMps2 * 0.68
                  : line.decelMps2;

              const kin = solveTrapezoidalKinematics(
                tau,
                node.runTimeNextSec,
                node.segmentLenNextM,
                effAccel,
                effDecel
              );

              distM = node.distM + kin.distM;
              speedMps = kin.speedMps;
              state = kin.phase;
              currStationName = node.stationName;
              nextStationName = nextNode.stationName;
              nextEtaSec = Math.max(0, nextNode.arriveOffsetSec - elapsedTripSec);
              progress =
                node.segmentLenNextM > 0
                  ? kin.distM / node.segmentLenNextM
                  : 0;
              break;
            }
          }
        }

        const runNum = 100 + ((k % 899) + 1);
        const headSample = sampleTrackAtDistance(dir.vertices, distM);

        dirTrains.push({
          id: `L${line.id}-D${dirId}-R${k}`,
          runNumber: runNum,
          lineId: line.id,
          lineColor: line.color,
          lineTextColor: line.textColor,
          trainModel: line.trainModel,
          rollingStock: line.rollingStock,
          directionId: dirId,
          headsign: dir.headsign,
          distAlongTrackM: distM,
          totalTrackLengthM: dir.totalLengthM,
          lon: headSample.lon,
          lat: headSample.lat,
          elevationM: headSample.elevationM,
          bearingDeg: headSample.bearingDeg,
          speedKmh: Math.round(speedMps * 3.6 * 10) / 10,
          state,
          currentOrPrevStationName: currStationName,
          nextStationName,
          nextStationEtaSec: Math.round(nextEtaSec),
          progressInSegment: progress,
          confidenceTier: lineState.confidenceTier,
          isDelayed:
            lineState.regime !== "REGULAR" ||
            lineState.empiricalSlownessRatio > 1.15,
          cars: [],
        });
      }

      // Enforce virtual block signaling (prevent overlap if headway compressed)
      dirTrains.sort((a, b) => b.distAlongTrackM - a.distAlongTrackM);
      const minGapM = line.trainLengthM + 55;
      for (let idx = 1; idx < dirTrains.length; idx++) {
        const leader = dirTrains[idx - 1];
        const follower = dirTrains[idx];
        if (leader.distAlongTrackM - follower.distAlongTrackM < minGapM) {
          follower.distAlongTrackM = Math.max(
            0,
            leader.distAlongTrackM - minGapM
          );
          follower.speedKmh = Math.min(follower.speedKmh, leader.speedKmh);
          follower.state = "HELD_SIGNAL";
          const adjusted = sampleTrackAtDistance(
            dir.vertices,
            follower.distAlongTrackM
          );
          follower.lon = adjusted.lon;
          follower.lat = adjusted.lat;
          follower.elevationM = adjusted.elevationM;
          follower.bearingDeg = adjusted.bearingDeg;
        }
      }

      if (buildFullCars) {
        for (const tr of dirTrains) {
          tr.cars = buildArticulatedCars(
            dir.vertices,
            tr.distAlongTrackM,
            line.carsCount,
            line.trainLengthM
          );
        }
      }

      allTrains.push(...dirTrains);
    }
  }

  return allTrains;
}

/**
 * Computes upcoming arrivals for a given station on a line across both directions.
 */
export function getUpcomingStationArrivals(
  line: MetroLineStatic,
  stationSlug: string,
  snapshot: LiveSystemSnapshot,
  timestampMs: number
): StationArrivalPrediction[] {
  const cdmx = getCdmxDateParts(timestampMs);
  if (!isWithinServiceHours(cdmx.secondsOfDay, cdmx.dayType)) return [];

  const lineState = snapshot.lines[line.id];
  if (!lineState || lineState.regime === "SUSPENDED") return [];

  const headwaySec = Math.max(
    95,
    Math.round(lineState.headwaySec * lineState.headwayMultiplier)
  );
  const serviceStartSec = getServiceStartSec(cdmx.dayType);
  const predictions: StationArrivalPrediction[] = [];

  for (const dirKey of ["0", "1"] as const) {
    const dirId: 0 | 1 = dirKey === "0" ? 0 : 1;
    const dir = line.directions[dirKey];
    const stIdx = dir.stations.findIndex((s) => s.slug === stationSlug);
    if (stIdx === -1 || stIdx === dir.stations.length - 1) continue; // Skip terminal discharge-only direction

    const { nodes } = compileDirectionProfile(line, dir, snapshot);
    const targetNode = nodes[stIdx];

    const seedOffset =
      ((line.id.charCodeAt(0) * 37 + dirId * 53) % headwaySec) * 0.5;
    const liveAnchorOffset =
      dirId === 0
        ? lineState.phaseOffsetDir0Sec
        : lineState.phaseOffsetDir1Sec;
    const netPhaseOffset =
      (((seedOffset + liveAnchorOffset) % headwaySec) + headwaySec) %
      headwaySec;

    const kStart = Math.max(
      0,
      Math.floor(
        (cdmx.secondsOfDay -
          targetNode.departOffsetSec -
          serviceStartSec -
          netPhaseOffset) /
          headwaySec
      )
    );

    let count = 0;
    for (let k = kStart; k < kStart + 10 && count < 3; k++) {
      const depTerminalSec = serviceStartSec + netPhaseOffset + k * headwaySec;
      if (depTerminalSec > 24 * 3600 + 5 * 60) break;
      const arrAtStationSec = depTerminalSec + targetNode.arriveOffsetSec;
      const depAtStationSec = depTerminalSec + targetNode.departOffsetSec;

      if (depAtStationSec >= cdmx.secondsOfDay) {
        const etaSec = Math.max(0, Math.round(arrAtStationSec - cdmx.secondsOfDay));
        predictions.push({
          trainId: `L${line.id}-D${dirId}-R${k}`,
          runNumber: 100 + ((k % 899) + 1),
          directionId: dirId,
          headsign: dir.headsign,
          etaSec,
          state: etaSec === 0 ? "En andén" : "En camino",
          confidenceTier: lineState.confidenceTier,
        });
        count++;
      }
    }
  }

  return predictions.sort((a, b) => a.etaSec - b.etaSec);
}

export interface ItineraryStep {
  lineId: LineId;
  lineColor: string;
  lineTextColor: string;
  directionHeadsign: string;
  fromStation: string;
  toStation: string;
  stopsCount: number;
  durationSec: number;
}

export interface ItineraryResult {
  totalDurationSec: number;
  transfersCount: number;
  steps: ItineraryStep[];
}

/**
 * Shortest-path itinerary planner over the live Metro CDMX network (including live delays & realistic transfer walks).
 */
export function computeLiveItinerary(
  network: NetworkStaticBundle,
  snapshot: LiveSystemSnapshot,
  originSlug: string,
  destSlug: string
): ItineraryResult | null {
  if (originSlug === destSlug) return null;

  // Graph node key = `${lineId}:${slug}`
  interface Edge {
    to: string;
    costSec: number;
    kind: "ride" | "transfer";
    lineId: LineId;
    headsign: string;
    stationName: string;
  }

  const adj = new Map<string, Edge[]>();
  const nodeMeta = new Map<
    string,
    { lineId: LineId; slug: string; name: string; color: string; textColor: string }
  >();
  const slugToNodes = new Map<string, string[]>();

  const addEdge = (from: string, edge: Edge) => {
    const arr = adj.get(from) ?? [];
    arr.push(edge);
    adj.set(from, arr);
  };

  for (const line of network.lines) {
    const lineState = snapshot.lines[line.id];
    if (lineState?.regime === "SUSPENDED") continue;
    const mult = lineState ? lineState.speedMultiplier : 1;
    const dwellMult = lineState ? lineState.dwellMultiplier : 1;

    for (const dirKey of ["0", "1"] as const) {
      const dir = line.directions[dirKey];
      for (const st of dir.stations) {
        const key = `${line.id}:${st.slug}`;
        if (!nodeMeta.has(key)) {
          nodeMeta.set(key, {
            lineId: line.id,
            slug: st.slug,
            name: st.name,
            color: line.color,
            textColor: line.textColor,
          });
          const list = slugToNodes.get(st.slug) ?? [];
          if (!list.includes(key)) list.push(key);
          slugToNodes.set(st.slug, list);
        }
      }

      for (const seg of dir.segments) {
        const fromSt = dir.stations.find((s) => s.stationId === seg.fromStationId);
        const toSt = dir.stations.find((s) => s.stationId === seg.toStationId);
        if (!fromSt || !toSt) continue;
        const timing = snapshot.timings[seg.id];
        const runSec = (timing ? timing.runTimeSec : 90) * mult;
        const dwellSec = (timing ? timing.dwellAtOriginSec : 22) * dwellMult;
        addEdge(`${line.id}:${fromSt.slug}`, {
          to: `${line.id}:${toSt.slug}`,
          costSec: runSec + dwellSec,
          kind: "ride",
          lineId: line.id,
          headsign: dir.headsign,
          stationName: toSt.name,
        });
      }
    }
  }

  // Long corridor transfers in CDMX Metro (Atlalilco, La Raza, Pantitlán, Tacubaya, Consulado)
  const longCorridorWalkSec: Record<string, number> = {
    atlalilco: 420,
    "la-raza": 390,
    pantitlan: 330,
    "instituto-del-petroleo": 270,
    consulado: 270,
    oceania: 260,
    ermita: 250,
  };

  for (const [slug, keys] of slugToNodes.entries()) {
    if (keys.length < 2) continue;
    const walkSec = longCorridorWalkSec[slug] ?? 195;
    for (const k1 of keys) {
      for (const k2 of keys) {
        if (k1 === k2) continue;
        const m2 = nodeMeta.get(k2)!;
        const waitHalfHeadway =
          (snapshot.lines[m2.lineId]?.headwaySec ?? 180) * 0.5;
        addEdge(k1, {
          to: k2,
          costSec: walkSec + waitHalfHeadway,
          kind: "transfer",
          lineId: m2.lineId,
          headsign: "Transbordo",
          stationName: m2.name,
        });
      }
    }
  }

  const starts = slugToNodes.get(originSlug) ?? [];
  const goals = new Set(slugToNodes.get(destSlug) ?? []);
  if (starts.length === 0 || goals.size === 0) return null;

  const dist = new Map<string, number>();
  const prev = new Map<string, { from: string; edge: Edge }>();
  const visited = new Set<string>();

  for (const s of starts) {
    const m = nodeMeta.get(s)!;
    const initialWait = (snapshot.lines[m.lineId]?.headwaySec ?? 180) * 0.5;
    dist.set(s, initialWait);
  }

  while (true) {
    let bestNode: string | null = null;
    let bestCost = Infinity;
    for (const [node, d] of dist.entries()) {
      if (!visited.has(node) && d < bestCost) {
        bestCost = d;
        bestNode = node;
      }
    }
    if (!bestNode) break;
    if (goals.has(bestNode)) {
      // Reconstruct path
      const rawEdges: { from: string; edge: Edge }[] = [];
      let curr = bestNode;
      while (prev.has(curr)) {
        const p = prev.get(curr)!;
        rawEdges.unshift(p);
        curr = p.from;
      }

      const steps: ItineraryStep[] = [];
      for (const item of rawEdges) {
        if (item.edge.kind === "transfer") continue;
        const fromMeta = nodeMeta.get(item.from)!;
        const lastStep = steps[steps.length - 1];
        if (
          lastStep &&
          lastStep.lineId === item.edge.lineId &&
          lastStep.directionHeadsign === item.edge.headsign
        ) {
          lastStep.toStation = item.edge.stationName;
          lastStep.stopsCount += 1;
          lastStep.durationSec += Math.round(item.edge.costSec);
        } else {
          steps.push({
            lineId: fromMeta.lineId,
            lineColor: fromMeta.color,
            lineTextColor: fromMeta.textColor,
            directionHeadsign: item.edge.headsign,
            fromStation: fromMeta.name,
            toStation: item.edge.stationName,
            stopsCount: 1,
            durationSec: Math.round(item.edge.costSec),
          });
        }
      }

      return {
        totalDurationSec: Math.round(bestCost),
        transfersCount: Math.max(0, steps.length - 1),
        steps,
      };
    }

    visited.add(bestNode);
    for (const edge of adj.get(bestNode) ?? []) {
      const nd = bestCost + edge.costSec;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, { from: bestNode, edge });
      }
    }
  }

  return null;
}
