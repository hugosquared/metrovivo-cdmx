export type LineId =
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "A"
  | "B"
  | "12";

export type RollingStockType = "pneumatic" | "steel";

export type DayType = "weekday" | "saturday" | "sunday";

export type TimeBandId =
  | "B1_MADRUGADA"
  | "B2_PICO_AM"
  | "B3_VALLE_AM"
  | "B4_MEDIODIA"
  | "B5_VALLE_PM"
  | "B6_PICO_PM"
  | "B7_NOCHE";

export type OperationalRegime =
  | "REGULAR"
  | "RAIN_SLOW"
  | "HIGH_CROWD"
  | "DELAYED"
  | "PARTIAL_CLOSURE"
  | "SUSPENDED";

export type ConfidenceSource =
  | "synthetic_physics"
  | "hybrid_calibrated"
  | "empirical_verified";

export interface MetroLineStatic {
  id: LineId;
  routeGtfsId: string;
  name: string;
  originName: string;
  destinationName: string;
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
  totalLengthKm: number;
  directions: {
    "0": DirectionTrackStatic;
    "1": DirectionTrackStatic;
  };
}

/**
 * Vertex in cumulative curvilinear track coordinates:
 * [lon, lat, cumulativeDistM, elevationM, bearingDeg]
 */
export type TrackVertex = [number, number, number, number, number];

export interface StationStopOnDirection {
  stationId: string;
  name: string;
  slug: string;
  sequence: number;
  lon: number;
  lat: number;
  distAlongTrackM: number;
  elevationM: number;
  isTransfer: boolean;
  transferLines: LineId[];
  isTerminal: boolean;
  dailyRidership: number;
}

export interface StationExitPoint {
  id: string;
  stationId: string;
  lineId: LineId;
  label: string;
  lon: number;
  lat: number;
}

export interface SegmentStatic {
  id: string;
  lineId: LineId;
  directionId: 0 | 1;
  sequence: number;
  fromStationId: string;
  toStationId: string;
  fromName: string;
  toName: string;
  startDistM: number;
  endDistM: number;
  lengthM: number;
  minCurveRadiusM: number;
}

export interface DirectionTrackStatic {
  directionId: 0 | 1;
  headsign: string;
  totalLengthM: number;
  vertices: TrackVertex[];
  stations: StationStopOnDirection[];
  segments: SegmentStatic[];
}

export interface NetworkStaticBundle {
  generatedAt: string;
  sourceGtfsModified: string;
  lines: MetroLineStatic[];
  exits: StationExitPoint[];
}

export interface SegmentRuntimeTiming {
  segmentId: string;
  runTimeSec: number;
  baseRunTimeSec: number;
  p85RunTimeSec: number;
  rainRunTimeSec: number;
  dwellAtOriginSec: number;
  sampleCount: number;
  confidence: ConfidenceSource;
}

export interface LineLiveState {
  lineId: LineId;
  officialStatusText: string;
  affectedStationsRaw: string;
  extraInfoRaw: string;
  regime: OperationalRegime;
  speedMultiplier: number; // >1 means slower (runTime multiplied by this factor)
  dwellMultiplier: number;
  headwayMultiplier: number;
  empiricalSlownessRatio: number; // Measured T_obs / T_base over recent window
  confidenceTier: 1 | 2 | 3; // 1=Physics, 2=Official Live+Timed, 3=Live Phase Anchored
  headwaySec: number;
  phaseOffsetDir0Sec: number;
  phaseOffsetDir1Sec: number;
  lastPhaseAnchorDir0At: string | null;
  lastPhaseAnchorDir1At: string | null;
  empiricalCoveragePct: number;
  activeTrainsCount: number;
  updatedAt: string;
}

export interface LiveSystemSnapshot {
  serverTimeMs: number;
  cdmxIsoTime: string;
  dayType: DayType;
  activeTimeBand: TimeBandId;
  activeTimeBandLabel: string;
  officialSourceConnected: boolean;
  officialUpdatedAtLabel: string;
  lines: Record<LineId, LineLiveState>;
  timings: Record<string, SegmentRuntimeTiming>; // keyed by segmentId
  recentObservationsCount: number;
}

export interface EmpiricalMeasurementInput {
  type: "segment_run" | "station_dwell" | "platform_sighting";
  lineId: LineId;
  directionId: 0 | 1;
  segmentId?: string;
  stationId?: string;
  durationSec?: number;
  observedAtMs?: number;
  weather?: "dry" | "rain";
  observerTag?: string;
  notes?: string;
}
