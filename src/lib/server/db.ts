import fs from "node:fs";
import path from "node:path";
import { createClient, type Client as LibsqlClient, type InValue } from "@libsql/client/web";
import type {
  ConfidenceSource,
  EmpiricalMeasurementInput,
  LineId,
  LineLiveState,
  LiveSystemSnapshot,
  NetworkStaticBundle,
  OperationalRegime,
  SegmentRuntimeTiming,
} from "@/types/metro";
import {
  getActiveTimeBand,
  getCdmxDateParts,
  getServiceStartSec,
} from "@/lib/time-bands";
import { pollOfficialMetroStatus } from "./official-status-poller";

const DB_PATH = path.join(process.cwd(), "data", "scancdmx.sqlite");
const STATIC_JSON_PATH = path.join(
  process.cwd(),
  "public",
  "data",
  "network-static.json"
);

interface AsyncDbAdapter {
  all<T = Record<string, unknown>>(sql: string, args?: InValue[]): Promise<T[]>;
  get<T = Record<string, unknown>>(
    sql: string,
    args?: InValue[]
  ): Promise<T | undefined>;
  run(sql: string, args?: InValue[]): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __scancdmxAdapter: AsyncDbAdapter | undefined;
  // eslint-disable-next-line no-var
  var __scancdmxNetwork: NetworkStaticBundle | undefined;
}

async function getDbAdapter(): Promise<AsyncDbAdapter> {
  if (globalThis.__scancdmxAdapter) {
    return globalThis.__scancdmxAdapter;
  }

  const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
  if (tursoUrl) {
    // Cloud mode (Vercel + Turso $0 free tier over HTTPS)
    const client: LibsqlClient = createClient({
      url: tursoUrl.replace(/^libsql:\/\//i, "https://"),
      authToken: process.env.TURSO_AUTH_TOKEN?.trim(),
    });

    globalThis.__scancdmxAdapter = {
      async all<T>(sql: string, args: InValue[] = []): Promise<T[]> {
        const rs = await client.execute({ sql, args });
        return rs.rows.map((row) => ({ ...row } as unknown as T));
      },
      async get<T>(sql: string, args: InValue[] = []): Promise<T | undefined> {
        const rs = await client.execute({ sql, args });
        if (rs.rows.length === 0) return undefined;
        return { ...rs.rows[0] } as unknown as T;
      },
      async run(sql: string, args: InValue[] = []): Promise<void> {
        await client.execute({ sql, args });
      },
    };
    return globalThis.__scancdmxAdapter;
  }

  // Local mode (Node 22 native node:sqlite on data/scancdmx.sqlite)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const sqlite = new DatabaseSync(DB_PATH);
  sqlite.exec("PRAGMA journal_mode = WAL;");

  globalThis.__scancdmxAdapter = {
    async all<T>(sql: string, args: InValue[] = []): Promise<T[]> {
      return sqlite.prepare(sql).all(...(args as never[])) as T[];
    },
    async get<T>(sql: string, args: InValue[] = []): Promise<T | undefined> {
      return sqlite.prepare(sql).get(...(args as never[])) as T | undefined;
    },
    async run(sql: string, args: InValue[] = []): Promise<void> {
      sqlite.prepare(sql).run(...(args as never[]));
    },
  };
  return globalThis.__scancdmxAdapter;
}

export function getStaticNetworkServer(): NetworkStaticBundle {
  if (!globalThis.__scancdmxNetwork) {
    const raw = fs.readFileSync(STATIC_JSON_PATH, "utf8");
    globalThis.__scancdmxNetwork = JSON.parse(raw) as NetworkStaticBundle;
  }
  return globalThis.__scancdmxNetwork;
}

function sanitizeObserverTag(raw?: string): string {
  const cleaned = (raw ?? "anonimo")
    .trim()
    .replace(/[^a-zA-Z0-9_@-]/g, "")
    .slice(0, 24);
  return cleaned || "anonimo";
}

export async function buildLiveSystemSnapshot(
  referenceTimestampMs?: number,
  forceOfficialRefresh: boolean = false
): Promise<LiveSystemSnapshot> {
  const db = await getDbAdapter();
  const nowMs = Date.now();
  const targetMs = referenceTimestampMs ?? nowMs;
  const isLiveNow = Math.abs(targetMs - nowMs) < 5 * 60 * 1000;

  const cdmx = getCdmxDateParts(targetMs);
  const activeBand = getActiveTimeBand(cdmx.secondsOfDay);

  const official = await pollOfficialMetroStatus(forceOfficialRefresh);
  if (official.connected) {
    for (const st of Object.values(official.lines)) {
      if (!st) continue;
      await db.run(
        `
        UPDATE live_line_status
        SET official_status_text = ?,
            affected_stations_raw = ?,
            extra_info_raw = ?,
            regime = ?,
            speed_multiplier = ?,
            dwell_multiplier = ?,
            headway_multiplier = ?,
            updated_at = ?
        WHERE line_id = ?
      `,
        [
          st.officialStatusText,
          st.affectedStationsRaw,
          st.extraInfoRaw,
          st.regime,
          st.speedMultiplier,
          st.dwellMultiplier,
          st.headwayMultiplier,
          official.fetchedAtIso,
          st.lineId,
        ]
      );
    }
  }

  const [profRows, hwRows, totalObsRow, liveRows] = await Promise.all([
    db.all<{
      segment_id: string;
      run_time_sec: number;
      base_physics_sec: number;
      p85_run_time_sec: number;
      rain_run_time_sec: number;
      dwell_origin_sec: number;
      sample_count: number;
      confidence: ConfidenceSource;
    }>(
      `
      SELECT segment_id, run_time_sec, base_physics_sec, p85_run_time_sec,
             rain_run_time_sec, dwell_origin_sec, sample_count, confidence
      FROM segment_travel_profiles
      WHERE day_type = ? AND time_band_id = ?
    `,
      [cdmx.dayType, activeBand.id]
    ),
    db.all<{ line_id: string; headway_sec: number }>(
      `SELECT line_id, headway_sec FROM headway_profiles WHERE day_type = ? AND time_band_id = ?`,
      [cdmx.dayType, activeBand.id]
    ),
    db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM empirical_observations`
    ),
    db.all<{
      line_id: LineId;
      official_status_text: string;
      affected_stations_raw: string;
      extra_info_raw: string;
      regime: OperationalRegime;
      speed_multiplier: number;
      dwell_multiplier: number;
      headway_multiplier: number;
      phase_offset_dir0_sec: number;
      phase_offset_dir1_sec: number;
      last_phase_anchor_dir0_at: string | null;
      last_phase_anchor_dir1_at: string | null;
      updated_at: string;
    }>(`SELECT * FROM live_line_status`),
  ]);

  const timings: Record<string, SegmentRuntimeTiming> = {};
  const empiricalSegCountByLine: Record<string, { emp: number; total: number }> =
    {};

  for (const r of profRows) {
    timings[r.segment_id] = {
      segmentId: r.segment_id,
      runTimeSec: Number(r.run_time_sec),
      baseRunTimeSec: Number(r.base_physics_sec),
      p85RunTimeSec: Number(r.p85_run_time_sec),
      rainRunTimeSec: Number(r.rain_run_time_sec),
      dwellAtOriginSec: Number(r.dwell_origin_sec),
      sampleCount: Number(r.sample_count),
      confidence: r.confidence,
    };
    const m = r.segment_id.match(/^L([0-9AB]+)-/);
    if (m) {
      const lid = m[1];
      const acc = empiricalSegCountByLine[lid] ?? { emp: 0, total: 0 };
      acc.total += 1;
      if (Number(r.sample_count) > 0) acc.emp += 1;
      empiricalSegCountByLine[lid] = acc;
    }
  }

  const headwayMap = new Map<string, number>();
  for (const h of hwRows) headwayMap.set(h.line_id, Number(h.headway_sec));

  const cutoffIso = new Date(nowMs - 45 * 60 * 1000).toISOString();
  const recentRatios = await db.all<{
    line_id: string;
    avg_ratio: number;
    cnt: number;
  }>(
    `
    SELECT line_id,
           AVG(duration_sec / NULLIF(baseline_at_obs_sec, 0)) AS avg_ratio,
           COUNT(*) AS cnt
    FROM empirical_observations
    WHERE obs_type = 'segment_run'
      AND recorded_at >= ?
      AND baseline_at_obs_sec > 0
    GROUP BY line_id
  `,
    [cutoffIso]
  );

  const slownessByLine = new Map<string, number>();
  for (const rr of recentRatios) {
    if (Number(rr.cnt) >= 1 && rr.avg_ratio) {
      slownessByLine.set(rr.line_id, Number(Number(rr.avg_ratio).toFixed(2)));
    }
  }

  const linesState = {} as Record<LineId, LineLiveState>;
  for (const row of liveRows) {
    const lid = row.line_id;
    const cov = empiricalSegCountByLine[lid] ?? { emp: 0, total: 1 };
    const coveragePct = Math.round((cov.emp / Math.max(1, cov.total)) * 100);
    const empRatio = isLiveNow ? slownessByLine.get(lid) ?? 1.0 : 1.0;

    const recentAnchor0 =
      row.last_phase_anchor_dir0_at &&
      nowMs - new Date(row.last_phase_anchor_dir0_at).getTime() < 30 * 60 * 1000;
    const recentAnchor1 =
      row.last_phase_anchor_dir1_at &&
      nowMs - new Date(row.last_phase_anchor_dir1_at).getTime() < 30 * 60 * 1000;

    const confidenceTier: 1 | 2 | 3 =
      isLiveNow && (recentAnchor0 || recentAnchor1)
        ? 3
        : isLiveNow && (official.connected || coveragePct > 0)
        ? 2
        : 1;

    const effectiveRegime: OperationalRegime = isLiveNow ? row.regime : "REGULAR";

    linesState[lid] = {
      lineId: lid,
      officialStatusText: isLiveNow
        ? row.official_status_text
        : "Simulación horaria por franja",
      affectedStationsRaw: isLiveNow ? row.affected_stations_raw : "Ninguna",
      extraInfoRaw: isLiveNow ? row.extra_info_raw : "",
      regime: effectiveRegime,
      speedMultiplier: isLiveNow ? Number(row.speed_multiplier) : 1.0,
      dwellMultiplier: isLiveNow ? Number(row.dwell_multiplier) : 1.0,
      headwayMultiplier: isLiveNow ? Number(row.headway_multiplier) : 1.0,
      empiricalSlownessRatio: empRatio,
      confidenceTier,
      headwaySec: headwayMap.get(lid) ?? 180,
      phaseOffsetDir0Sec: Number(row.phase_offset_dir0_sec),
      phaseOffsetDir1Sec: Number(row.phase_offset_dir1_sec),
      lastPhaseAnchorDir0At: row.last_phase_anchor_dir0_at,
      lastPhaseAnchorDir1At: row.last_phase_anchor_dir1_at,
      empiricalCoveragePct: coveragePct,
      activeTrainsCount: 0,
      updatedAt: row.updated_at,
    };
  }

  return {
    serverTimeMs: nowMs,
    cdmxIsoTime: cdmx.formattedClock,
    dayType: cdmx.dayType,
    activeTimeBand: activeBand.id,
    activeTimeBandLabel: activeBand.label,
    officialSourceConnected: official.connected,
    officialUpdatedAtLabel: official.updatedAtLabel,
    lines: linesState,
    timings,
    recentObservationsCount: Number(totalObsRow?.total ?? 0),
  };
}

export async function recordEmpiricalMeasurements(
  inputs: EmpiricalMeasurementInput[],
  adminPin?: string
): Promise<{
  processed: number;
  rejected: number;
  rejectedReasons: string[];
  phaseSnapsApplied: number;
  updatedSegments: string[];
}> {
  const db = await getDbAdapter();
  const network = getStaticNetworkServer();
  const snapshot = await buildLiveSystemSnapshot();

  const isTrustedAdmin =
    Boolean(process.env.ADMIN_PIN?.trim()) &&
    adminPin?.trim() === process.env.ADMIN_PIN?.trim();

  let processed = 0;
  let rejected = 0;
  const rejectedReasons: string[] = [];
  let phaseSnapsApplied = 0;
  const updatedSegments: string[] = [];

  for (const item of inputs) {
    const obsMs = item.observedAtMs ?? Date.now();
    const obsIso = new Date(obsMs).toISOString();
    const cdmx = getCdmxDateParts(obsMs);
    const band = getActiveTimeBand(cdmx.secondsOfDay);
    const weather = item.weather ?? "dry";
    const observerTag = sanitizeObserverTag(item.observerTag);

    if (item.type === "segment_run" && item.segmentId && item.durationSec) {
      const dur = Number(item.durationSec);

      // Look up true geodesic segment length to enforce anti-troll physics bounds!
      const segMeta = await db.get<{
        length_m: number;
        from_name: string;
        to_name: string;
      }>(`SELECT length_m, from_name, to_name FROM segments WHERE id = ?`, [
        item.segmentId,
      ]);

      if (!segMeta) {
        rejected++;
        rejectedReasons.push(`Tramo no encontrado (${item.segmentId}).`);
        continue;
      }

      const impliedKmh = (Number(segMeta.length_m) / Math.max(1, dur)) * 3.6;
      // Metro CDMX max operational speed never exceeds 80 km/h (commercial avg door-to-door <= 68 km/h)
      if (impliedKmh > 76) {
        rejected++;
        rejectedReasons.push(
          `Filtro físico anti-error: ${dur.toFixed(1)}s en ${Math.round(
            Number(segMeta.length_m)
          )}m implicaría viajar a ${Math.round(
            impliedKmh
          )} km/h. Cronometra de puerta a puerta a bordo del tren.`
        );
        continue;
      }
      if (dur > 600) {
        rejected++;
        rejectedReasons.push(
          `Tiempo mayor a 10 minutos entre estaciones (${Math.round(
            dur
          )}s): corresponde a detención extraordinaria y no altera la base.`
        );
        continue;
      }

      const prof = await db.get<{
        run_time_sec: number;
        base_physics_sec: number;
        p85_run_time_sec: number;
        rain_run_time_sec: number;
        dwell_origin_sec: number;
        sample_count: number;
      }>(
        `
        SELECT run_time_sec, base_physics_sec, p85_run_time_sec, rain_run_time_sec,
               dwell_origin_sec, sample_count
        FROM segment_travel_profiles
        WHERE segment_id = ? AND day_type = ? AND time_band_id = ?
      `,
        [item.segmentId, cdmx.dayType, band.id]
      );

      const baseline = prof ? Number(prof.run_time_sec) : dur;
      await db.run(
        `
        INSERT INTO empirical_observations (
          obs_type, line_id, direction_id, segment_id, station_id,
          day_type, time_band_id, duration_sec, baseline_at_obs_sec,
          weather, observer_tag, notes, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          "segment_run",
          item.lineId,
          item.directionId,
          item.segmentId,
          item.stationId ?? null,
          cdmx.dayType,
          band.id,
          dur,
          baseline,
          weather,
          observerTag,
          item.notes ?? null,
          obsIso,
        ]
      );

      if (prof) {
        const basePhys = Number(prof.base_physics_sec);
        const isExtremeIncident = dur > basePhys * 2.2;
        if (!isExtremeIncident) {
          const newCount = Number(prof.sample_count) + 1;
          const alpha = isTrustedAdmin
            ? 0.45
            : Math.max(0.15, Math.min(0.25, 1 / (newCount + 2)));

          const prevRun = Number(prof.run_time_sec);
          const prevRain = Number(prof.rain_run_time_sec);
          const prevP85 = Number(prof.p85_run_time_sec);

          const newRun =
            weather === "rain"
              ? prevRun
              : Number(((1 - alpha) * prevRun + alpha * dur).toFixed(1));
          const newRain =
            weather === "rain"
              ? Number(((1 - alpha) * prevRain + alpha * dur).toFixed(1))
              : prevRain;
          const newP85 = Math.max(
            Math.round(newRun * 1.15),
            Math.round(0.8 * prevP85 + 0.2 * Math.max(newRun, dur))
          );

          const requiredSamples = isTrustedAdmin ? 1 : 3;
          const conf: ConfidenceSource =
            newCount >= requiredSamples
              ? "empirical_verified"
              : "hybrid_calibrated";

          await db.run(
            `
            UPDATE segment_travel_profiles
            SET run_time_sec = ?,
                p85_run_time_sec = ?,
                rain_run_time_sec = ?,
                sample_count = ?,
                confidence = ?,
                updated_at = ?
            WHERE segment_id = ? AND day_type = ? AND time_band_id = ?
          `,
            [
              newRun,
              newP85,
              newRain,
              newCount,
              conf,
              obsIso,
              item.segmentId,
              cdmx.dayType,
              band.id,
            ]
          );
          updatedSegments.push(item.segmentId);
        }
      }
      processed++;
    } else if (
      item.type === "station_dwell" &&
      item.segmentId &&
      item.durationSec
    ) {
      const dur = Number(item.durationSec);
      if (dur < 6 || dur > 240) {
        rejected++;
        continue;
      }
      const prof = await db.get<{ dwell_origin_sec: number }>(
        `SELECT dwell_origin_sec FROM segment_travel_profiles WHERE segment_id = ? AND day_type = ? AND time_band_id = ?`,
        [item.segmentId, cdmx.dayType, band.id]
      );
      const baseDwell = prof ? Number(prof.dwell_origin_sec) : dur;

      await db.run(
        `
        INSERT INTO empirical_observations (
          obs_type, line_id, direction_id, segment_id, station_id,
          day_type, time_band_id, duration_sec, baseline_at_obs_sec,
          weather, observer_tag, notes, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          "station_dwell",
          item.lineId,
          item.directionId,
          item.segmentId,
          item.stationId ?? null,
          cdmx.dayType,
          band.id,
          dur,
          baseDwell,
          weather,
          observerTag,
          item.notes ?? null,
          obsIso,
        ]
      );

      if (prof && dur <= 150) {
        const blended = Number((0.75 * baseDwell + 0.25 * dur).toFixed(1));
        await db.run(
          `UPDATE segment_travel_profiles SET dwell_origin_sec = ?, updated_at = ? WHERE segment_id = ? AND day_type = ? AND time_band_id = ?`,
          [blended, obsIso, item.segmentId, cdmx.dayType, band.id]
        );
      }
      processed++;
    } else if (item.type === "platform_sighting" && item.stationId) {
      const line = network.lines.find((l) => l.id === item.lineId);
      const lineState = snapshot.lines[item.lineId];
      if (line && lineState) {
        const dirKey = String(item.directionId) as "0" | "1";
        const dir = line.directions[dirKey];
        const stIdx = dir.stations.findIndex(
          (s) => s.stationId === item.stationId
        );

        if (stIdx >= 0) {
          let departOffsetFromTerminalSec = 0;
          for (let i = 0; i <= stIdx; i++) {
            const seg = i < dir.segments.length ? dir.segments[i] : null;
            const timing = seg ? snapshot.timings[seg.id] : undefined;
            const dwell = Math.round(
              (timing ? timing.dwellAtOriginSec : 20) * lineState.dwellMultiplier
            );
            departOffsetFromTerminalSec += dwell;
            if (i < stIdx && seg) {
              const run = Math.round(
                (timing ? timing.runTimeSec : 80) * lineState.speedMultiplier
              );
              departOffsetFromTerminalSec += run;
            }
          }

          const headwaySec = Math.max(
            95,
            Math.round(lineState.headwaySec * lineState.headwayMultiplier)
          );
          const serviceStartSec = getServiceStartSec(cdmx.dayType);
          const seedOffset =
            ((line.id.charCodeAt(0) * 37 + item.directionId * 53) % headwaySec) *
            0.5;

          const impliedTerminalDepSec =
            cdmx.secondsOfDay - departOffsetFromTerminalSec;
          const desiredPhase =
            (((impliedTerminalDepSec - serviceStartSec - seedOffset) %
              headwaySec) +
              headwaySec) %
            headwaySec;

          if (item.directionId === 0) {
            await db.run(
              `UPDATE live_line_status SET phase_offset_dir0_sec = ?, last_phase_anchor_dir0_at = ?, updated_at = ? WHERE line_id = ?`,
              [Number(desiredPhase.toFixed(1)), obsIso, obsIso, item.lineId]
            );
          } else {
            await db.run(
              `UPDATE live_line_status SET phase_offset_dir1_sec = ?, last_phase_anchor_dir1_at = ?, updated_at = ? WHERE line_id = ?`,
              [Number(desiredPhase.toFixed(1)), obsIso, obsIso, item.lineId]
            );
          }
          phaseSnapsApplied++;
        }
      }

      await db.run(
        `
        INSERT INTO empirical_observations (
          obs_type, line_id, direction_id, segment_id, station_id,
          day_type, time_band_id, duration_sec, baseline_at_obs_sec,
          weather, observer_tag, notes, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          "platform_sighting",
          item.lineId,
          item.directionId,
          item.segmentId ?? null,
          item.stationId,
          cdmx.dayType,
          band.id,
          null,
          null,
          weather,
          observerTag,
          item.notes ?? null,
          obsIso,
        ]
      );
      processed++;
    }
  }

  return {
    processed,
    rejected,
    rejectedReasons,
    phaseSnapsApplied,
    updatedSegments,
  };
}

export async function getRecentEmpiricalObservations(limit: number = 30) {
  const db = await getDbAdapter();
  const [observations, leaderboard] = await Promise.all([
    db.all(
      `
      SELECT o.id, o.obs_type, o.line_id, o.direction_id, o.segment_id,
             o.station_id, o.day_type, o.time_band_id, o.duration_sec,
             o.baseline_at_obs_sec, o.weather, o.observer_tag, o.recorded_at,
             s.from_name, s.to_name
      FROM empirical_observations o
      LEFT JOIN segments s ON s.id = o.segment_id
      ORDER BY o.id DESC
      LIMIT ?
    `,
      [limit]
    ),
    db.all<{ observer_tag: string; total_runs: number }>(
      `
      SELECT observer_tag, COUNT(*) AS total_runs
      FROM empirical_observations
      WHERE obs_type = 'segment_run'
      GROUP BY observer_tag
      ORDER BY total_runs DESC
      LIMIT 8
    `
    ),
  ]);

  return { observations, leaderboard };
}
