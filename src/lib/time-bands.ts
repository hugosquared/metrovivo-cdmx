import type { DayType, TimeBandId } from "@/types/metro";

export interface TimeBandDefinition {
  id: TimeBandId;
  label: string;
  shortLabel: string;
  startSec: number; // seconds since 00:00 CDMX
  endSec: number;
  demandFactor: number; // relative passenger load factor
  headwayFactor: number; // relative headway multiplier vs line nominal peak
}

export const TIME_BANDS: TimeBandDefinition[] = [
  {
    id: "B1_MADRUGADA",
    label: "Inicio de servicio / Madrugada (05:00–06:30)",
    shortLabel: "Madrugada",
    startSec: 5 * 3600,
    endSec: 6.5 * 3600,
    demandFactor: 0.72,
    headwayFactor: 1.45,
  },
  {
    id: "B2_PICO_AM",
    label: "Hora Pico Mañana (06:30–09:30)",
    shortLabel: "Hora Pico AM",
    startSec: 6.5 * 3600,
    endSec: 9.5 * 3600,
    demandFactor: 1.35,
    headwayFactor: 1.0,
  },
  {
    id: "B3_VALLE_AM",
    label: "Hora Valle Mañana (09:30–13:30)",
    shortLabel: "Valle AM",
    startSec: 9.5 * 3600,
    endSec: 13.5 * 3600,
    demandFactor: 0.85,
    headwayFactor: 1.35,
  },
  {
    id: "B4_MEDIODIA",
    label: "Pico Escolar / Mediodía (13:30–15:30)",
    shortLabel: "Mediodía",
    startSec: 13.5 * 3600,
    endSec: 15.5 * 3600,
    demandFactor: 1.08,
    headwayFactor: 1.18,
  },
  {
    id: "B5_VALLE_PM",
    label: "Valle Tarde (15:30–17:30)",
    shortLabel: "Valle PM",
    startSec: 15.5 * 3600,
    endSec: 17.5 * 3600,
    demandFactor: 0.95,
    headwayFactor: 1.25,
  },
  {
    id: "B6_PICO_PM",
    label: "Hora Pico Tarde-Noche (17:30–21:00)",
    shortLabel: "Hora Pico PM",
    startSec: 17.5 * 3600,
    endSec: 21 * 3600,
    demandFactor: 1.4,
    headwayFactor: 1.02,
  },
  {
    id: "B7_NOCHE",
    label: "Horario Nocturno (21:00–24:00)",
    shortLabel: "Nocturno",
    startSec: 21 * 3600,
    endSec: 24.5 * 3600,
    demandFactor: 0.65,
    headwayFactor: 1.85,
  },
];

export function getCdmxDateParts(timestampMs: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  weekday: number; // 0=Sun..6=Sat
  secondsOfDay: number;
  dayType: DayType;
  formattedClock: string;
} {
  // CDMX abolished DST permanently in Oct 2022 -> fixed UTC-6 year-round!
  // Using Intl.DateTimeFormat with America/Mexico_City guarantees accuracy in any host TZ.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = dtf.formatToParts(new Date(timestampMs));
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  const second = Number(map.second);
  const ms = ((timestampMs % 1000) + 1000) % 1000;

  const wkMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = wkMap[map.weekday] ?? 1;
  const dayType: DayType =
    weekday === 0 ? "sunday" : weekday === 6 ? "saturday" : "weekday";

  // Treat 00:00 - 00:35 as end-of-service continuation (24:00 - 24:35) of night band
  let secondsOfDay = hour * 3600 + minute * 60 + second + ms / 1000;
  if (hour === 0 && minute <= 35) {
    secondsOfDay += 24 * 3600;
  }

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    ms,
    weekday,
    secondsOfDay,
    dayType,
    formattedClock: `${hh}:${mm}:${ss}`,
  };
}

export function getServiceStartSec(dayType: DayType): number {
  if (dayType === "weekday") return 5 * 3600;
  if (dayType === "saturday") return 6 * 3600;
  return 7 * 3600;
}

export function getServiceEndSec(): number {
  return 24 * 3600 + 15 * 60; // Last trains finish arriving ~00:15-00:30
}

export function isWithinServiceHours(
  secondsOfDay: number,
  dayType: DayType
): boolean {
  const start = getServiceStartSec(dayType);
  return secondsOfDay >= start && secondsOfDay <= 24 * 3600 + 35 * 60;
}

export function getActiveTimeBand(secondsOfDay: number): TimeBandDefinition {
  for (const b of TIME_BANDS) {
    if (secondsOfDay >= b.startSec && secondsOfDay < b.endSec) {
      return b;
    }
  }
  return secondsOfDay < 5 * 3600 ? TIME_BANDS[0] : TIME_BANDS[TIME_BANDS.length - 1];
}
