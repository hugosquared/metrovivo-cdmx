import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient, type InStatement, type InValue } from "@libsql/client/web";

const LOCAL_DB = path.join(process.cwd(), "data", "scancdmx.sqlite");

async function main() {
  const rawUrl = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

  if (!rawUrl || !authToken) {
    console.error(
      "Faltan variables de entorno: configura TURSO_DATABASE_URL y TURSO_AUTH_TOKEN antes de ejecutar este comando."
    );
    process.exit(1);
  }

  const url = rawUrl.replace(/^libsql:\/\//i, "https://");
  console.log(`Conectando a Turso: ${url} ...`);
  const remote = createClient({ url, authToken });
  const local = new DatabaseSync(LOCAL_DB);

  console.log("1/5 Creando tablas e índices en Turso...");
  await remote.batch(
    [
      `DROP TABLE IF EXISTS empirical_observations`,
      `DROP TABLE IF EXISTS live_line_status`,
      `DROP TABLE IF EXISTS headway_profiles`,
      `DROP TABLE IF EXISTS segment_travel_profiles`,
      `DROP TABLE IF EXISTS segments`,
      `DROP TABLE IF EXISTS lines`,
      `CREATE TABLE lines (
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
      )`,
      `CREATE TABLE segments (
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
      )`,
      `CREATE TABLE segment_travel_profiles (
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
      )`,
      `CREATE TABLE headway_profiles (
        line_id TEXT NOT NULL,
        day_type TEXT NOT NULL,
        time_band_id TEXT NOT NULL,
        headway_sec INTEGER NOT NULL,
        PRIMARY KEY (line_id, day_type, time_band_id)
      )`,
      `CREATE TABLE live_line_status (
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
      )`,
      `CREATE TABLE empirical_observations (
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
        observer_tag TEXT NOT NULL DEFAULT 'anonimo',
        notes TEXT,
        recorded_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_obs_line_time ON empirical_observations(line_id, recorded_at DESC)`,
      `CREATE INDEX idx_obs_segment ON empirical_observations(segment_id)`,
    ],
    "write"
  );

  const pushTable = async (
    label: string,
    selectSql: string,
    insertSql: string,
    mapper: (row: Record<string, unknown>) => InValue[]
  ) => {
    const rows = local.prepare(selectSql).all() as Record<string, unknown>[];
    console.log(`${label}: subiendo ${rows.length} filas...`);
    const chunkSize = 250;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const slice = rows.slice(i, i + chunkSize);
      const stmts: InStatement[] = slice.map((r) => ({
        sql: insertSql,
        args: mapper(r),
      }));
      await remote.batch(stmts, "write");
    }
  };

  await pushTable(
    "2/5 Líneas",
    `SELECT * FROM lines`,
    `INSERT INTO lines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    (r) => [
      r.id as string,
      r.name as string,
      r.origin_name as string,
      r.destination_name as string,
      r.color as string,
      r.rolling_stock as string,
      r.train_model as string,
      r.cars_count as number,
      r.train_length_m as number,
      r.default_depth_m as number,
      r.has_surface_or_elevated as number,
      r.total_length_km as number,
    ]
  );

  await pushTable(
    "3/5 Tramos e estado inicial",
    `SELECT * FROM segments`,
    `INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    (r) => [
      r.id as string,
      r.line_id as string,
      r.direction_id as number,
      r.sequence as number,
      r.from_station_id as string,
      r.to_station_id as string,
      r.from_name as string,
      r.to_name as string,
      r.length_m as number,
      r.min_curve_radius_m as number,
      r.origin_ridership as number,
      r.origin_is_transfer as number,
      r.origin_is_terminal as number,
    ]
  );

  await pushTable(
    "3b/5 Estado en vivo base",
    `SELECT * FROM live_line_status`,
    `INSERT INTO live_line_status VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    (r) => [
      r.line_id as string,
      r.official_status_text as string,
      r.affected_stations_raw as string,
      r.extra_info_raw as string,
      r.regime as string,
      r.speed_multiplier as number,
      r.dwell_multiplier as number,
      r.headway_multiplier as number,
      r.phase_offset_dir0_sec as number,
      r.phase_offset_dir1_sec as number,
      (r.last_phase_anchor_dir0_at as string | null) ?? null,
      (r.last_phase_anchor_dir1_at as string | null) ?? null,
      r.updated_at as string,
    ]
  );

  await pushTable(
    "4/5 Frecuencias por franja",
    `SELECT * FROM headway_profiles`,
    `INSERT INTO headway_profiles VALUES (?, ?, ?, ?)`,
    (r) => [
      r.line_id as string,
      r.day_type as string,
      r.time_band_id as string,
      r.headway_sec as number,
    ]
  );

  await pushTable(
    "5/5 Perfiles de viaje (7,686 combinaciones)",
    `SELECT * FROM segment_travel_profiles`,
    `INSERT INTO segment_travel_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    (r) => [
      r.segment_id as string,
      r.day_type as string,
      r.time_band_id as string,
      r.run_time_sec as number,
      r.base_physics_sec as number,
      r.p85_run_time_sec as number,
      r.rain_run_time_sec as number,
      r.dwell_origin_sec as number,
      r.sample_count as number,
      r.confidence as string,
      r.updated_at as string,
    ]
  );

  local.close();
  console.log("¡Listo! Base de datos de MetroVivo CDMX cargada en Turso exitosamente.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
