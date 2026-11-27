import type { LineId, OperationalRegime } from "@/types/metro";

export interface ParsedOfficialLineStatus {
  lineId: LineId;
  officialStatusText: string;
  affectedStationsRaw: string;
  extraInfoRaw: string;
  regime: OperationalRegime;
  speedMultiplier: number;
  dwellMultiplier: number;
  headwayMultiplier: number;
}

export interface OfficialPollResult {
  connected: boolean;
  updatedAtLabel: string;
  fetchedAtIso: string;
  lines: Partial<Record<LineId, ParsedOfficialLineStatus>>;
}

const INCIDENTES_URL =
  "https://incidentesmovilidad.cdmx.gob.mx/public/bandejaEstadoServicio.xhtml?idMedioTransporte=stc";

const CACHE_TTL_MS = 90_000; // Single-flight 90s server cache when reachable
const FAILURE_BACKOFF_MS = 600_000; // 10 min backoff when .gob.mx blocks datacenter IP
let cachedResult: OfficialPollResult | null = null;
let lastFetchMs = 0;
let lastFailedMs = 0;
let inflightPromise: Promise<OfficialPollResult> | null = null;

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyStatusRegime(
  statusRaw: string,
  affectedRaw: string,
  extraRaw: string
): {
  regime: OperationalRegime;
  speedMultiplier: number;
  dwellMultiplier: number;
  headwayMultiplier: number;
} {
  const combined = `${statusRaw} ${affectedRaw} ${extraRaw}`.toLowerCase();

  if (
    combined.includes("sin servicio") ||
    combined.includes("servicio suspendido")
  ) {
    if (
      affectedRaw.toLowerCase().includes("completa") ||
      affectedRaw.trim() === ""
    ) {
      return {
        regime: "SUSPENDED",
        speedMultiplier: 1.0,
        dwellMultiplier: 1.0,
        headwayMultiplier: 1.0,
      };
    }
    // Single station closed (e.g. Zócalo event): trains pass through at normal speed
    if (combined.includes("estación temporalmente") || combined.includes("estacion temporalmente")) {
      return {
        regime: "REGULAR",
        speedMultiplier: 1.0,
        dwellMultiplier: 1.0,
        headwayMultiplier: 1.0,
      };
    }
    return {
      regime: "PARTIAL_CLOSURE",
      speedMultiplier: 1.35,
      dwellMultiplier: 1.3,
      headwayMultiplier: 1.35,
    };
  }

  if (combined.includes("provisional")) {
    return {
      regime: "PARTIAL_CLOSURE",
      speedMultiplier: 1.3,
      dwellMultiplier: 1.25,
      headwayMultiplier: 1.3,
    };
  }

  if (
    combined.includes("lluvia") ||
    combined.includes("marcha de seguridad") ||
    combined.includes("avance lento")
  ) {
    return {
      regime: "RAIN_SLOW",
      speedMultiplier: 1.45, // ~31% speed reduction under STC rain safety protocol
      dwellMultiplier: 1.2,
      headwayMultiplier: 1.22,
    };
  }

  if (
    combined.includes("revisión") ||
    combined.includes("revision") ||
    combined.includes("falla") ||
    combined.includes("incidente") ||
    combined.includes("retraso") ||
    combined.includes("rescate")
  ) {
    return {
      regime: "DELAYED",
      speedMultiplier: 1.75,
      dwellMultiplier: 1.65,
      headwayMultiplier: 1.45,
    };
  }

  if (combined.includes("alta afluencia") || combined.includes("saturación")) {
    return {
      regime: "HIGH_CROWD",
      speedMultiplier: 1.15,
      dwellMultiplier: 1.55,
      headwayMultiplier: 1.1,
    };
  }

  return {
    regime: "REGULAR",
    speedMultiplier: 1.0,
    dwellMultiplier: 1.0,
    headwayMultiplier: 1.0,
  };
}

function parseTableRowsIntoMap(
  htmlFragment: string,
  target: Partial<Record<LineId, ParsedOfficialLineStatus>>
) {
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRegex.exec(htmlFragment)) !== null) {
    const rowHtml = match[1];
    const iconMatch = rowHtml.match(/lineas\/stc([0-9ab]+)\.svg/i);
    if (!iconMatch) continue;

    const lineKey = iconMatch[1].toUpperCase() as LineId;
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(decodeHtmlEntities(tdMatch[1]));
    }

    if (cells.length >= 3) {
      const officialStatusText = cells[1] || "Servicio Regular";
      const affectedStationsRaw = cells[2] || "Ninguna";
      const extraInfoRaw = cells[3] || "";
      const classified = classifyStatusRegime(
        officialStatusText,
        affectedStationsRaw,
        extraInfoRaw
      );

      target[lineKey] = {
        lineId: lineKey,
        officialStatusText,
        affectedStationsRaw,
        extraInfoRaw,
        ...classified,
      };
    }
  }
}

async function doFetchOfficialStatus(): Promise<OfficialPollResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2200);

  try {
    const res1 = await fetch(INCIDENTES_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "ScanCDMX-TransitVisualizer/1.0 (+OpenDataCDMX; single-flight-90s-cache)",
        Accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    });

    if (!res1.ok) {
      throw new Error(`HTTP ${res1.status}`);
    }

    const setCookies =
      typeof res1.headers.getSetCookie === "function"
        ? res1.headers.getSetCookie()
        : res1.headers.get("set-cookie")
        ? [res1.headers.get("set-cookie")!]
        : [];
    const cookieHeader = setCookies
      .map((c) => c.split(";")[0])
      .filter(Boolean)
      .join("; ");

    const html1 = await res1.text();
    const linesMap: Partial<Record<LineId, ParsedOfficialLineStatus>> = {};
    parseTableRowsIntoMap(html1, linesMap);

    const plain1 = decodeHtmlEntities(html1);
    const updMatch = plain1.match(/Actualizaci[oó]n:\s*([0-9]{1,2}:[0-9]{2})/i);
    const updatedAtLabel = updMatch ? updMatch[1] : "En vivo";

    // Fetch PrimeFaces Page 2 (rows 10..11 -> Líneas A y B) using ViewState
    const vsMatch = html1.match(
      /name="jakarta\.faces\.ViewState"[^>]*value="([^"]+)"/i
    );
    const formMatch = html1.match(/<form[^>]*id="([^"]+)"/i);
    const dtMatch = html1.match(/id="([^"]+_paginator_bottom)"/i);

    if (vsMatch && formMatch && dtMatch) {
      const viewState = vsMatch[1];
      const formId = formMatch[1];
      const dtId = dtMatch[1].replace(/_paginator_bottom$/, "");

      const body = new URLSearchParams({
        "jakarta.faces.partial.ajax": "true",
        "jakarta.faces.source": dtId,
        "jakarta.faces.partial.execute": dtId,
        "jakarta.faces.partial.render": dtId,
        [`${dtId}_pagination`]: "true",
        [`${dtId}_first`]: "10",
        [`${dtId}_rows`]: "10",
        [`${dtId}_skipChildren`]: "true",
        [`${dtId}_encodeFeature`]: "true",
        [formId]: formId,
        "jakarta.faces.ViewState": viewState,
      });

      const res2 = await fetch(INCIDENTES_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "ScanCDMX-TransitVisualizer/1.0 (+OpenDataCDMX; single-flight-90s-cache)",
          "Faces-Request": "partial/ajax",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: body.toString(),
        cache: "no-store",
      });

      if (res2.ok) {
        const xml2 = await res2.text();
        parseTableRowsIntoMap(xml2, linesMap);
      }
    }

    const result: OfficialPollResult = {
      connected: Object.keys(linesMap).length > 0,
      updatedAtLabel,
      fetchedAtIso: new Date().toISOString(),
      lines: linesMap,
    };
    cachedResult = result;
    lastFetchMs = Date.now();
    lastFailedMs = 0;
    return result;
  } catch {
    lastFailedMs = Date.now();
    if (cachedResult) {
      return { ...cachedResult, connected: false };
    }
    const fallback: OfficialPollResult = {
      connected: false,
      updatedAtLabel: "Por franja horaria",
      fetchedAtIso: new Date().toISOString(),
      lines: {},
    };
    cachedResult = fallback;
    lastFetchMs = Date.now();
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export async function pollOfficialMetroStatus(
  forceRefresh: boolean = false
): Promise<OfficialPollResult> {
  const now = Date.now();
  if (
    !forceRefresh &&
    lastFailedMs > 0 &&
    cachedResult &&
    now - lastFailedMs < FAILURE_BACKOFF_MS
  ) {
    return cachedResult;
  }
  if (!forceRefresh && cachedResult && now - lastFetchMs < CACHE_TTL_MS) {
    return cachedResult;
  }
  if (inflightPromise) {
    return inflightPromise;
  }
  inflightPromise = doFetchOfficialStatus().finally(() => {
    inflightPromise = null;
  });
  return inflightPromise;
}
