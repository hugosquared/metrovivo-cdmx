"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Award,
  CheckCircle2,
  CloudOff,
  CloudRain,
  Database,
  Download,
  ExternalLink,
  Play,
  Radio,
  RefreshCw,
  Square,
  Sun,
  Timer,
  UploadCloud,
  User,
} from "lucide-react";
import type {
  EmpiricalMeasurementInput,
  LineId,
  LiveSystemSnapshot,
  NetworkStaticBundle,
} from "@/types/metro";
import {
  flushOfflineQueue,
  listQueuedMeasurements,
  submitOrQueueMeasurements,
} from "@/lib/client/offline-queue";

interface FieldTimerPanelProps {
  network: NetworkStaticBundle;
  snapshot: LiveSystemSnapshot | null;
  onDataUpdated: () => void;
  onFlyToStation?: (lon: number, lat: number) => void;
}

interface RecentObsRow {
  id: number;
  obs_type: string;
  line_id: string;
  direction_id: number;
  segment_id: string | null;
  duration_sec: number | null;
  baseline_at_obs_sec: number | null;
  weather: string;
  observer_tag: string;
  recorded_at: string;
  from_name: string | null;
  to_name: string | null;
}

interface LeaderboardEntry {
  observer_tag: string;
  total_runs: number;
}

export default function FieldTimerPanel({
  network,
  snapshot,
  onDataUpdated,
  onFlyToStation,
}: FieldTimerPanelProps) {
  const [selectedLineId, setSelectedLineId] = useState<LineId>("1");
  const [directionId, setDirectionId] = useState<0 | 1>(0);
  const [segmentIdx, setSegmentIdx] = useState<number>(0);
  const [weather, setWeather] = useState<"dry" | "rain">("dry");
  const [observerAlias, setObserverAlias] = useState<string>("");
  const [isInAppBrowser, setIsInAppBrowser] = useState<boolean>(false);

  const [timerPhase, setTimerPhase] = useState<
    "IDLE" | "RUNNING_SEGMENT" | "DWELLING_STATION"
  >("IDLE");
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const startPerfRef = useRef<number>(0);

  const [manualSec, setManualSec] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<{
    kind: "ok" | "warn";
    text: string;
  } | null>(null);
  const [queuedCount, setQueuedCount] = useState<number>(0);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [recentObs, setRecentObs] = useState<RecentObsRow[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [subTab, setSubTab] = useState<"crono" | "tabla">("crono");
  const [sightingBtnState, setSightingBtnState] = useState<"idle" | "sending" | "done">("idle");

  const selectedLine = useMemo(
    () =>
      network.lines.find((l) => l.id === selectedLineId) ?? network.lines[0],
    [network, selectedLineId]
  );

  const dirTrack = useMemo(
    () => selectedLine.directions[String(directionId) as "0" | "1"],
    [selectedLine, directionId]
  );

  const currentSegment =
    dirTrack.segments[Math.min(segmentIdx, dirTrack.segments.length - 1)];
  const currentOriginStation =
    dirTrack.stations[Math.min(segmentIdx, dirTrack.stations.length - 1)];
  const currentTiming =
    currentSegment && snapshot ? snapshot.timings[currentSegment.id] : undefined;

  const refreshHistoryAndQueue = async () => {
    const q = await listQueuedMeasurements();
    setQueuedCount(q.length);
    try {
      const res = await fetch("/api/observations");
      if (res.ok) {
        const data = await res.json();
        setRecentObs(data.observations ?? []);
        setLeaderboard(data.leaderboard ?? []);
      }
    } catch {
      // Offline in tunnel
    }
  };

  useEffect(() => {
    setIsOnline(typeof navigator !== "undefined" ? navigator.onLine : true);
    if (typeof navigator !== "undefined") {
      const ua = navigator.userAgent || "";
      if (/FBAN|FBAV|Instagram/i.test(ua)) {
        setIsInAppBrowser(true);
      }
    }
    const savedAlias = window.localStorage.getItem("scancdmx_alias") ?? "";
    setObserverAlias(savedAlias);
    refreshHistoryAndQueue();

    const onOnline = async () => {
      setIsOnline(true);
      const res = await flushOfflineQueue();
      if (res.flushed > 0) {
        setStatusBanner({
          kind: "ok",
          text: `Señal recuperada: ${res.flushed} mediciones sincronizadas con la BD comunitaria.`,
        });
        onDataUpdated();
      }
      refreshHistoryAndQueue();
    };
    const onOffline = () => setIsOnline(false);

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (timerPhase === "IDLE") {
      setElapsedSec(0);
      return;
    }
    const id = window.setInterval(() => {
      const now = performance.now();
      setElapsedSec((now - startPerfRef.current) / 1000);
    }, 100);
    return () => window.clearInterval(id);
  }, [timerPhase]);

  const vibrate = (pattern: number | number[]) => {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(pattern);
    }
  };

  const cleanTag = observerAlias.trim() || "anonimo";

  const handleDepartureStart = async () => {
    vibrate(40);
    const itemsToSubmit: EmpiricalMeasurementInput[] = [];

    if (timerPhase === "DWELLING_STATION" && currentSegment && elapsedSec >= 6) {
      itemsToSubmit.push({
        type: "station_dwell",
        lineId: selectedLine.id,
        directionId,
        segmentId: currentSegment.id,
        stationId: currentOriginStation?.stationId,
        durationSec: Number(elapsedSec.toFixed(1)),
        observedAtMs: Date.now(),
        weather,
        observerTag: cleanTag,
      });
    }

    if (currentOriginStation) {
      itemsToSubmit.push({
        type: "platform_sighting",
        lineId: selectedLine.id,
        directionId,
        stationId: currentOriginStation.stationId,
        segmentId: currentSegment?.id,
        observedAtMs: Date.now(),
        weather,
        observerTag: cleanTag,
      });
    }

    startPerfRef.current = performance.now();
    setElapsedSec(0);
    setTimerPhase("RUNNING_SEGMENT");

    if (itemsToSubmit.length > 0) {
      const r = await submitOrQueueMeasurements(itemsToSubmit);
      setQueuedCount(r.queuedCount);
      setStatusBanner({
        kind: "ok",
        text: r.synced
          ? `Salida registrada y fase de Línea ${selectedLine.id} anclada en vivo.`
          : `Sin señal en túnel: salida guardada en memoria offline (${r.queuedCount} en cola).`,
      });
      if (r.synced) onDataUpdated();
      refreshHistoryAndQueue();
    }
  };

  const handleArrivalStop = async () => {
    if (timerPhase !== "RUNNING_SEGMENT" || !currentSegment) return;
    vibrate([35, 50, 35]);

    const measuredSec = Number(elapsedSec.toFixed(1));

    // Quick client-side check before advancing station so accidental double-taps don't skip station!
    const impliedKmh = (currentSegment.lengthM / Math.max(1, measuredSec)) * 3.6;
    if (impliedKmh > 76) {
      setStatusBanner({
        kind: "warn",
        text: `¡Demasiado rápido (${measuredSec}s = ${Math.round(
          impliedKmh
        )} km/h)! El cronómetro sigue corriendo hasta llegar a ${
          currentSegment.toName
        }.`,
      });
      return;
    }

    startPerfRef.current = performance.now();
    setElapsedSec(0);

    const nextIdx = segmentIdx + 1;
    if (nextIdx < dirTrack.segments.length) {
      setSegmentIdx(nextIdx);
      setTimerPhase("DWELLING_STATION");
      const nxtSt = dirTrack.stations[nextIdx];
      if (nxtSt && onFlyToStation) onFlyToStation(nxtSt.lon, nxtSt.lat);
    } else {
      setTimerPhase("IDLE");
    }

    const r = await submitOrQueueMeasurements([
      {
        type: "segment_run",
        lineId: selectedLine.id,
        directionId,
        segmentId: currentSegment.id,
        stationId: currentSegment.toStationId,
        durationSec: measuredSec,
        observedAtMs: Date.now(),
        weather,
        observerTag: cleanTag,
      },
    ]);

    if (r.rejectedReasons.length > 0) {
      setStatusBanner({ kind: "warn", text: r.rejectedReasons[0] });
    } else {
      const diff = currentTiming
        ? Math.round(measuredSec - currentTiming.runTimeSec)
        : 0;
      const diffStr = diff >= 0 ? `+${diff}s` : `${diff}s`;
      setStatusBanner({
        kind: "ok",
        text: r.synced
          ? `¡Gracias! ${currentSegment.fromName} → ${currentSegment.toName}: ${measuredSec}s (${diffStr} vs base).`
          : `Guardado offline en túnel: ${measuredSec}s (${r.queuedCount} pendientes de subir).`,
      });
    }
    if (r.synced) onDataUpdated();
    refreshHistoryAndQueue();
  };

  const handlePhaseSightingOnly = async () => {
    if (!currentOriginStation || sightingBtnState === "sending") return;
    vibrate(35);
    setSightingBtnState("sending");
    if (onFlyToStation) {
      onFlyToStation(currentOriginStation.lon, currentOriginStation.lat);
    }
    const r = await submitOrQueueMeasurements([
      {
        type: "platform_sighting",
        lineId: selectedLine.id,
        directionId,
        stationId: currentOriginStation.stationId,
        observedAtMs: Date.now(),
        weather,
        observerTag: cleanTag,
      },
    ]);
    setQueuedCount(r.queuedCount);
    setSightingBtnState("done");
    window.setTimeout(() => setSightingBtnState("idle"), 4500);
    setStatusBanner({
      kind: "ok",
      text: r.synced
        ? `¡Listo! Se sincronizó un tren en el mapa saliendo de ${currentOriginStation.name} → ${dirTrack.headsign} (activo por 30 min).`
        : `Reporte de salida guardado en cola offline.`,
    });
    if (r.synced) onDataUpdated();
    refreshHistoryAndQueue();
  };

  const handleManualSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = Number(manualSec);
    if (!currentSegment || !Number.isFinite(val) || val < 15 || val > 600) {
      setStatusBanner({
        kind: "warn",
        text: "Ingresa un tiempo real entre 15 y 600 segundos.",
      });
      return;
    }
    const r = await submitOrQueueMeasurements([
      {
        type: "segment_run",
        lineId: selectedLine.id,
        directionId,
        segmentId: currentSegment.id,
        durationSec: val,
        observedAtMs: Date.now(),
        weather,
        observerTag: cleanTag,
      },
    ]);
    setManualSec("");
    setQueuedCount(r.queuedCount);

    if (r.rejectedReasons.length > 0) {
      setStatusBanner({ kind: "warn", text: r.rejectedReasons[0] });
    } else {
      setStatusBanner({
        kind: "ok",
        text: r.synced
          ? `Tiempo real (${val}s) sumado a ${currentSegment.fromName} → ${currentSegment.toName}.`
          : `Guardado en cola offline (${r.queuedCount}).`,
      });
      if (r.synced) onDataUpdated();
    }
    refreshHistoryAndQueue();
  };

  const handleManualFlush = async () => {
    const res = await flushOfflineQueue();
    setQueuedCount(res.remaining);
    if (res.flushed > 0) {
      setStatusBanner({
        kind: "ok",
        text: `Sincronizadas ${res.flushed} mediciones pendientes.`,
      });
      onDataUpdated();
      refreshHistoryAndQueue();
    }
  };

  return (
    <div className="space-y-2.5 text-xs text-zinc-200">
      {/* Facebook / Instagram In-App Browser Helper Banner */}
      {isInAppBrowser && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-400/40 bg-amber-500/15 p-2.5 text-[11px] text-amber-200">
          <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div>
            <span className="font-bold">Tip para túnel sin señal:</span> Estás en el navegador interno de Facebook/IG. Toca{" "}
            <span className="font-bold">⋮</span> arriba y elige{" "}
            <span className="underline">Abrir en Chrome o Safari</span> para guardar tiempos bajo tierra.
          </div>
        </div>
      )}

      {/* Offline / Sync status + Alias */}
      <div className="space-y-1.5 rounded-xl border border-white/10 bg-zinc-900/80 p-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {isOnline ? (
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
            ) : (
              <CloudOff className="h-3.5 w-3.5 text-amber-400" />
            )}
            <span className="text-[11px] text-zinc-300">
              {isOnline
                ? "Conectado a BD Comunitaria"
                : "Modo Túnel Offline (IndexedDB)"}
            </span>
          </div>
          {queuedCount > 0 && (
            <button
              onClick={handleManualFlush}
              className="flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/30"
            >
              <UploadCloud className="h-3 w-3" />
              Subir ({queuedCount})
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 pt-0.5">
          <User className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <input
            type="text"
            maxLength={22}
            value={observerAlias}
            onChange={(e) => {
              setObserverAlias(e.target.value);
              window.localStorage.setItem("scancdmx_alias", e.target.value);
            }}
            placeholder="Tu apodo opcional (ej. @usuario_l3)"
            className="w-full rounded-md border border-white/10 bg-zinc-950 px-2 py-1 text-[11px] text-white placeholder-zinc-500 focus:border-amber-400/60 focus:outline-none"
          />
        </div>
      </div>

      {/* Sub-navigation */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-900 p-1">
        <button
          onClick={() => setSubTab("crono")}
          className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 font-medium transition ${
            subTab === "crono"
              ? "bg-zinc-800 text-white shadow"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Timer className="h-3.5 w-3.5 text-amber-400" />
          Cronómetro en Viaje
        </button>
        <button
          onClick={() => setSubTab("tabla")}
          className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 font-medium transition ${
            subTab === "tabla"
              ? "bg-zinc-800 text-white shadow"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Database className="h-3.5 w-3.5 text-sky-400" />
          BD de Tramos ({dirTrack.segments.length})
        </button>
      </div>

      {/* Line & Direction selector */}
      <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/60 p-2.5">
        <div className="flex flex-wrap gap-1">
          {network.lines.map((l) => (
            <button
              key={l.id}
              onClick={() => {
                setSelectedLineId(l.id);
                setSegmentIdx(0);
                setTimerPhase("IDLE");
              }}
              style={{
                backgroundColor: selectedLineId === l.id ? l.color : undefined,
                color: selectedLineId === l.id ? l.textColor : undefined,
              }}
              className={`h-6 min-w-[26px] rounded px-1.5 text-[11px] font-bold transition ${
                selectedLineId === l.id
                  ? "ring-2 ring-white/80"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {l.id}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-1.5 pt-1">
          {([0, 1] as const).map((d) => {
            const dt = selectedLine.directions[String(d) as "0" | "1"];
            return (
              <button
                key={d}
                onClick={() => {
                  setDirectionId(d);
                  setSegmentIdx(0);
                  setTimerPhase("IDLE");
                }}
                className={`truncate rounded-lg border px-2 py-1.5 text-left text-[11px] transition ${
                  directionId === d
                    ? "border-white/30 bg-zinc-800 font-semibold text-white"
                    : "border-white/5 bg-zinc-950/50 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                → {dt.headsign}
              </button>
            );
          })}
        </div>
      </div>

      {subTab === "crono" ? (
        <>
          <div className="space-y-2.5 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[11px] font-medium text-zinc-400">
                Tramo actual:
              </label>
              <div className="flex items-center gap-1 rounded-md bg-zinc-950 p-0.5">
                <button
                  type="button"
                  onClick={() => setWeather("dry")}
                  className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] ${
                    weather === "dry"
                      ? "bg-amber-500/20 text-amber-300"
                      : "text-zinc-500"
                  }`}
                >
                  <Sun className="h-3 w-3" /> Seco
                </button>
                <button
                  type="button"
                  onClick={() => setWeather("rain")}
                  className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] ${
                    weather === "rain"
                      ? "bg-sky-500/25 text-sky-300"
                      : "text-zinc-500"
                  }`}
                >
                  <CloudRain className="h-3 w-3" /> Lluvia
                </button>
              </div>
            </div>

            <select
              value={segmentIdx}
              onChange={(e) => {
                const idx = Number(e.target.value);
                setSegmentIdx(idx);
                setTimerPhase("IDLE");
                const st = dirTrack.stations[idx];
                if (st && onFlyToStation) onFlyToStation(st.lon, st.lat);
              }}
              className="w-full rounded-lg border border-white/15 bg-zinc-950 px-2.5 py-2 text-xs font-medium text-white focus:border-amber-400 focus:outline-none"
            >
              {dirTrack.segments.map((seg, i) => (
                <option key={seg.id} value={i}>
                  {i + 1}. {seg.fromName} → {seg.toName} ({Math.round(seg.lengthM)} m)
                </option>
              ))}
            </select>

            {currentSegment && (
              <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-zinc-950/80 p-2 text-center">
                <div>
                  <div className="text-[10px] text-zinc-500">Base Franja</div>
                  <div className="font-mono text-xs font-semibold text-emerald-400">
                    {currentTiming ? `${currentTiming.runTimeSec}s` : "--"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Con Lluvia</div>
                  <div className="font-mono text-xs font-semibold text-sky-400">
                    {currentTiming ? `${currentTiming.rainRunTimeSec}s` : "--"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">Muestras BD</div>
                  <div className="font-mono text-xs font-semibold text-amber-300">
                    {currentTiming ? currentTiming.sampleCount : 0}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-black/50 py-3">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                {timerPhase === "IDLE"
                  ? "Listo en estación"
                  : timerPhase === "RUNNING_SEGMENT"
                  ? "En túnel — viajando a siguiente estación"
                  : "Detenido en andén — midiendo parada"}
              </span>
              <div className="mt-0.5 font-mono text-3xl font-bold tracking-tight text-white">
                {elapsedSec.toFixed(1)}
                <span className="ml-1 text-sm font-normal text-zinc-400">s</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleDepartureStart}
                disabled={timerPhase === "RUNNING_SEGMENT"}
                className={`flex flex-col items-center justify-center gap-1 rounded-xl px-3 py-3 font-semibold transition ${
                  timerPhase === "RUNNING_SEGMENT"
                    ? "cursor-not-allowed bg-zinc-800/50 text-zinc-600"
                    : "bg-emerald-500 text-zinc-950 shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 active:scale-[0.98]"
                }`}
              >
                <Play className="h-4 w-4 fill-current" />
                <span>Salida / Arranque</span>
                <span className="text-[10px] font-normal opacity-80">
                  Cierre de puertas
                </span>
              </button>

              <button
                type="button"
                onClick={handleArrivalStop}
                disabled={timerPhase !== "RUNNING_SEGMENT"}
                className={`flex flex-col items-center justify-center gap-1 rounded-xl px-3 py-3 font-semibold transition ${
                  timerPhase !== "RUNNING_SEGMENT"
                    ? "cursor-not-allowed bg-zinc-800/50 text-zinc-600"
                    : "bg-amber-400 text-zinc-950 shadow-lg shadow-amber-400/25 hover:bg-amber-300 active:scale-[0.98]"
                }`}
              >
                <Square className="h-4 w-4 fill-current" />
                <span>Llegada a Andén</span>
                <span className="text-[10px] font-normal opacity-80">
                  Guarda y avanza tramo
                </span>
              </button>
            </div>

            <button
              type="button"
              onClick={handlePhaseSightingOnly}
              disabled={sightingBtnState === "sending"}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-semibold transition ${
                sightingBtnState === "done"
                  ? "border-emerald-400/60 bg-emerald-500/25 text-emerald-200"
                  : sightingBtnState === "sending"
                  ? "border-white/10 bg-zinc-800 text-zinc-400"
                  : "border-sky-400/30 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 active:scale-[0.99]"
              }`}
            >
              {sightingBtnState === "done" ? (
                <>
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span>¡Tren sincronizado saliendo de {currentOriginStation?.name}!</span>
                </>
              ) : sightingBtnState === "sending" ? (
                <span>Sincronizando tren en el mapa...</span>
              ) : (
                <>
                  <Radio className="h-3.5 w-3.5 shrink-0" />
                  <span>Reportar: acaba de salir un tren de {currentOriginStation?.name}</span>
                </>
              )}
            </button>

            <form onSubmit={handleManualSave} className="flex gap-1.5 pt-1">
              <input
                type="number"
                step="0.1"
                min="15"
                max="600"
                value={manualSec}
                onChange={(e) => setManualSec(e.target.value)}
                placeholder="Segs manuales (ej. 78.5)"
                className="flex-1 rounded-lg border border-white/10 bg-zinc-950 px-2.5 py-1.5 text-xs text-white placeholder-zinc-500 focus:border-amber-400 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700"
              >
                Guardar
              </button>
            </form>
          </div>

          {statusBanner && (
            <div
              className={`flex items-start gap-2 rounded-lg border p-2.5 text-[11px] ${
                statusBanner.kind === "warn"
                  ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              }`}
            >
              {statusBanner.kind === "warn" ? (
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              )}
              <span>{statusBanner.text}</span>
            </div>
          )}

          {/* Community Leaderboard */}
          {leaderboard.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-white/10 bg-zinc-900/50 p-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-300">
                <Award className="h-3.5 w-3.5" />
                <span>Colaboradores de la comunidad</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {leaderboard.map((entry) => (
                  <span
                    key={entry.observer_tag}
                    className="rounded-full border border-white/10 bg-zinc-950 px-2 py-0.5 text-[10px] text-zinc-300"
                  >
                    {entry.observer_tag}{" "}
                    <strong className="text-amber-300">{entry.total_runs}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Recent Empirical Feed + Open Data Download */}
          <div className="space-y-1.5 rounded-xl border border-white/10 bg-zinc-900/50 p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-zinc-300">
                Últimas mediciones abiertas
              </span>
              <div className="flex items-center gap-2">
                <a
                  href="/api/observations?export=1"
                  className="flex items-center gap-1 text-[10px] text-sky-400 hover:underline"
                  title="Descargar mediciones abiertas (CC BY 4.0)"
                >
                  <Download className="h-3 w-3" /> JSON
                </a>
                <button
                  onClick={refreshHistoryAndQueue}
                  className="text-zinc-400 hover:text-white"
                  title="Actualizar historial"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>
            </div>
            {recentObs.length === 0 ? (
              <p className="py-1.5 text-[11px] text-zinc-500">
                Sé el primero en cronometrar un tramo real. Proyecto ciudadano libre (0% comercial, datos abiertos CC BY 4.0).
              </p>
            ) : (
              <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
                {recentObs.slice(0, 12).map((o) => (
                  <div
                    key={o.id}
                    className="flex items-center justify-between rounded bg-zinc-950/70 px-2 py-1 text-[11px]"
                  >
                    <div className="truncate pr-2">
                      <span className="mr-1.5 rounded bg-zinc-800 px-1 py-0.5 text-[10px] font-bold text-white">
                        L{o.line_id}
                      </span>
                      {o.obs_type === "platform_sighting" ? (
                        <span className="text-sky-300">
                          Salida en vivo ({o.observer_tag})
                        </span>
                      ) : (
                        <span className="text-zinc-300">
                          {o.from_name ?? o.segment_id} → {o.to_name ?? ""}
                        </span>
                      )}
                    </div>
                    {o.duration_sec && (
                      <span className="shrink-0 font-mono font-semibold text-amber-300">
                        {o.duration_sec}s
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="max-h-[380px] space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-zinc-900/60 p-2">
          {dirTrack.segments.map((seg, i) => {
            const t = snapshot?.timings[seg.id];
            const isVerified = t?.confidence === "empirical_verified";
            const isHybrid = t?.confidence === "hybrid_calibrated";
            return (
              <div
                key={seg.id}
                onClick={() => {
                  setSegmentIdx(i);
                  setSubTab("crono");
                }}
                className="flex cursor-pointer items-center justify-between rounded-lg border border-white/5 bg-zinc-950/70 px-2.5 py-1.5 transition hover:border-white/20"
              >
                <div className="min-w-0 flex-1 pr-2">
                  <div className="truncate text-[11px] font-medium text-zinc-200">
                    {i + 1}. {seg.fromName} → {seg.toName}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span>{Math.round(seg.lengthM)} m</span>
                    <span>•</span>
                    <span>Andén: {t ? `${t.dwellAtOriginSec}s` : "--"}</span>
                    <span>•</span>
                    <span
                      className={
                        isVerified
                          ? "text-emerald-400"
                          : isHybrid
                          ? "text-sky-400"
                          : "text-zinc-500"
                      }
                    >
                      {isVerified
                        ? `Verificado (${t?.sampleCount})`
                        : isHybrid
                        ? `En progreso (${t?.sampleCount}/3)`
                        : "Físico base"}
                    </span>
                  </div>
                </div>
                <div className="text-right font-mono">
                  <div className="text-xs font-bold text-white">
                    {t ? `${t.runTimeSec}s` : "--"}
                  </div>
                  <div className="text-[10px] text-sky-400">
                    🌧 {t ? `${t.rainRunTimeSec}s` : "--"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
