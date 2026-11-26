"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CloudRain,
  Compass,
  Eye,
  Layers,
  LocateFixed,
  Navigation,
  Radio,
  RefreshCw,
  Route,
  Search,
  Timer,
  TrainFront,
  X,
} from "lucide-react";
import type {
  LineId,
  LiveSystemSnapshot,
  NetworkStaticBundle,
} from "@/types/metro";
import {
  type ActiveTrainPose,
  computeLiveItinerary,
  getUpcomingStationArrivals,
} from "@/lib/kinematics";
import { getCdmxDateParts } from "@/lib/time-bands";
import MetroMap3D, { type SelectedStationInfo } from "./MetroMap3D";
import FieldTimerPanel from "./FieldTimerPanel";
import { submitOrQueueMeasurements } from "@/lib/client/offline-queue";

type SidebarTab = "lines" | "itinerary" | "timer";

export default function ScanCdmxApp() {
  const [network, setNetwork] = useState<NetworkStaticBundle | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSystemSnapshot | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);

  // Active lines filter
  const [enabledLines, setEnabledLines] = useState<Set<LineId>>(
    () => new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "12"])
  );

  // Simulation clock & speed multiplier (x1 live, x5, x10, x30, or custom time of day)
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1);
  const [isLiveClock, setIsLiveClock] = useState<boolean>(true);
  const simAnchorRef = useRef<{ realMs: number; simMs: number }>({
    realMs: Date.now(),
    simMs: Date.now(),
  });
  const speedRef = useRef<number>(1);
  const isLiveRef = useRef<boolean>(true);
  const serverDeltaMsRef = useRef<number>(0);
  const scrubTimerRef = useRef<number | null>(null);

  const [displayClock, setDisplayClock] = useState<string>("--:--:--");
  const [displaySecondsOfDay, setDisplaySecondsOfDay] = useState<number>(12 * 3600);
  const [activeTrainCount, setActiveTrainCount] = useState<number>(0);

  // 3D & Subterranean Depth View controls (ScanPaname signature right-hand controls!)
  const [is3DPitch, setIs3DPitch] = useState<boolean>(true);
  const [isSubterraneanMode, setIsSubterraneanMode] = useState<boolean>(false);
  const [depthExaggeration, setDepthExaggeration] = useState<number>(1.35);

  // Sidebar & Selection state
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>("lines");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [selectedTrain, setSelectedTrain] = useState<ActiveTrainPose | null>(null);
  const [followSelectedTrain, setFollowSelectedTrain] = useState<boolean>(false);
  const [selectedStation, setSelectedStation] =
    useState<SelectedStationInfo | null>(null);
  const [phaseSnapFeedback, setPhaseSnapFeedback] = useState<string | null>(null);

  // Itinerary state
  const [originSlug, setOriginSlug] = useState<string>("tacubaya");
  const [destSlug, setDestSlug] = useState<string>("bellas-artes");

  // Camera flyTo trigger
  const [flyToTarget, setFlyToTarget] = useState<{
    lon: number;
    lat: number;
    zoom?: number;
    seq: number;
  } | null>(null);

  const triggerFlyTo = useCallback((lon: number, lat: number, zoom?: number) => {
    setFlyToTarget((prev) => ({
      lon,
      lat,
      zoom,
      seq: (prev?.seq ?? 0) + 1,
    }));
  }, []);

  const simTimeGetter = useCallback(() => {
    const now = Date.now() + serverDeltaMsRef.current;
    if (isLiveRef.current && speedRef.current === 1) {
      return now;
    }
    const elapsedReal = now - simAnchorRef.current.realMs;
    return simAnchorRef.current.simMs + elapsedReal * speedRef.current;
  }, []);

  const fetchLiveSnapshot = useCallback(
    async (customAtMs?: number, forceOfficial: boolean = false) => {
      try {
        const params = new URLSearchParams();
        if (customAtMs) params.set("at", String(Math.round(customAtMs)));
        if (forceOfficial) params.set("refresh", "1");
        const res = await fetch(`/api/live?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: LiveSystemSnapshot = await res.json();
        if (!customAtMs) {
          serverDeltaMsRef.current = data.serverTimeMs - Date.now();
        }
        setSnapshot(data);
      } catch (e) {
        console.error("Snapshot fetch error:", e);
      }
    },
    []
  );

  // Initial load of static network + live snapshot
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [netRes, liveRes] = await Promise.all([
          fetch("/data/network-static.json"),
          fetch("/api/live", { cache: "no-store" }),
        ]);
        if (!netRes.ok) throw new Error("No se pudo cargar network-static.json");
        if (!liveRes.ok) throw new Error(`Error del servidor en /api/live (HTTP ${liveRes.status})`);
        const netData: NetworkStaticBundle = await netRes.json();
        const liveData: LiveSystemSnapshot = await liveRes.json();
        if (!mounted) return;
        serverDeltaMsRef.current = liveData.serverTimeMs - Date.now();
        simAnchorRef.current = {
          realMs: Date.now() + serverDeltaMsRef.current,
          simMs: liveData.serverTimeMs,
        };
        setNetwork(netData);
        setSnapshot(liveData);
      } catch (err) {
        if (mounted) {
          setLoadingError(
            err instanceof Error ? err.message : "Error cargando red del Metro"
          );
        }
      }
    })();

    const pollId = window.setInterval(() => {
      if (isLiveRef.current) {
        fetchLiveSnapshot();
      }
    }, 30_000);

    return () => {
      mounted = false;
      window.clearInterval(pollId);
    };
  }, [fetchLiveSnapshot]);

  // Update digital clock every 250ms
  useEffect(() => {
    const id = window.setInterval(() => {
      const tMs = simTimeGetter();
      const parts = getCdmxDateParts(tMs);
      setDisplayClock(parts.formattedClock);
      setDisplaySecondsOfDay(parts.secondsOfDay);
    }, 250);
    return () => window.clearInterval(id);
  }, [simTimeGetter]);

  const handleSpeedChange = (newSpeed: number) => {
    const currSim = simTimeGetter();
    const nowAligned = Date.now() + serverDeltaMsRef.current;
    simAnchorRef.current = { realMs: nowAligned, simMs: currSim };
    speedRef.current = newSpeed;
    setSpeedMultiplier(newSpeed);
    if (newSpeed !== 1) {
      isLiveRef.current = false;
      setIsLiveClock(false);
    }
  };

  const handleReturnToLive = () => {
    const nowAligned = Date.now() + serverDeltaMsRef.current;
    simAnchorRef.current = { realMs: nowAligned, simMs: nowAligned };
    speedRef.current = 1;
    isLiveRef.current = true;
    setSpeedMultiplier(1);
    setIsLiveClock(true);
    fetchLiveSnapshot();
  };

  const handleTimeScrub = (targetSecondsOfDay: number) => {
    const nowAligned = Date.now() + serverDeltaMsRef.current;
    const currParts = getCdmxDateParts(nowAligned);
    const deltaSec = targetSecondsOfDay - currParts.secondsOfDay;
    const targetSimMs = nowAligned + deltaSec * 1000;

    simAnchorRef.current = { realMs: nowAligned, simMs: targetSimMs };
    isLiveRef.current = false;
    setIsLiveClock(false);
    setDisplaySecondsOfDay(targetSecondsOfDay);
    if (scrubTimerRef.current) {
      window.clearTimeout(scrubTimerRef.current);
    }
    scrubTimerRef.current = window.setTimeout(() => {
      fetchLiveSnapshot(targetSimMs);
    }, 250);
  };

  const handleTrainsTickStats = useCallback(
    (count: number, selectedPose: ActiveTrainPose | null) => {
      setActiveTrainCount(count);
      if (selectedPose) {
        setSelectedTrain(selectedPose);
      }
    },
    []
  );

  // Deduplicated station catalog for search & itinerary
  const uniqueStations = useMemo(() => {
    if (!network) return [];
    const bySlug = new Map<
      string,
      {
        slug: string;
        name: string;
        lon: number;
        lat: number;
        lines: LineId[];
        firstLineId: LineId;
        stationObj: SelectedStationInfo["station"];
      }
    >();

    for (const line of network.lines) {
      for (const st of line.directions["0"].stations) {
        const existing = bySlug.get(st.slug);
        if (existing) {
          if (!existing.lines.includes(line.id)) existing.lines.push(line.id);
        } else {
          bySlug.set(st.slug, {
            slug: st.slug,
            name: st.name,
            lon: st.lon,
            lat: st.lat,
            lines: [line.id],
            firstLineId: line.id,
            stationObj: st,
          });
        }
      }
    }
    return Array.from(bySlug.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "es")
    );
  }, [network]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return uniqueStations
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.slug.includes(q) ||
          s.lines.some((l) => `linea ${l.toLowerCase()}` === q || `l${l.toLowerCase()}` === q)
      )
      .slice(0, 7);
  }, [uniqueStations, searchQuery]);

  const itinerary = useMemo(() => {
    if (!network || !snapshot || activeTab !== "itinerary") return null;
    return computeLiveItinerary(network, snapshot, originSlug, destSlug);
  }, [network, snapshot, activeTab, originSlug, destSlug]);

  const highlightedRouteSlugs = useMemo(() => {
    const s = new Set<string>();
    if (itinerary) {
      s.add(originSlug);
      s.add(destSlug);
    }
    return s;
  }, [itinerary, originSlug, destSlug]);

  const stationArrivals = useMemo(() => {
    if (!network || !snapshot || !selectedStation) return [];
    const ln = network.lines.find((l) => l.id === selectedStation.lineId);
    if (!ln) return [];
    return getUpcomingStationArrivals(
      ln,
      selectedStation.station.slug,
      snapshot,
      simTimeGetter()
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, snapshot, selectedStation, displayClock]);

  const handleQuickStationPhaseSnap = async (dirId: 0 | 1) => {
    if (!selectedStation) return;
    const r = await submitOrQueueMeasurements([
      {
        type: "platform_sighting",
        lineId: selectedStation.lineId,
        directionId: dirId,
        stationId: selectedStation.station.stationId,
        observedAtMs: Date.now(),
      },
    ]);
    setPhaseSnapFeedback(
      r.synced
        ? `¡Listo! Tren sincronizado saliendo de ${selectedStation.station.name} (Línea ${selectedStation.lineId}).`
        : "Reporte guardado en cola offline."
    );
    if (r.synced) fetchLiveSnapshot();
    setTimeout(() => setPhaseSnapFeedback(null), 4000);
  };

  if (loadingError) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#07090E] text-white">
        <div className="max-w-md rounded-2xl border border-red-500/30 bg-zinc-900 p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-red-400" />
          <h2 className="text-lg font-bold">Error al iniciar MetroVivo CDMX</h2>
          <p className="mt-1 text-sm text-zinc-400">{loadingError}</p>
        </div>
      </div>
    );
  }

  if (!network) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#07090E] text-white">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 animate-ping rounded-full bg-[#F04E98]" />
          <span className="text-lg font-bold tracking-tight">MetroVivo CDMX</span>
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          Cargando geometría de doble vía, 195 estaciones y perfiles cinemáticos del STC Metro...
        </p>
      </div>
    );
  }

  const linesAffectedCount = snapshot
    ? Object.values(snapshot.lines).filter((l) => l.regime !== "REGULAR").length
    : 0;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#07090E] font-sans text-zinc-100 select-none">
      {/* Full-screen 3D WebGL Map */}
      <MetroMap3D
        network={network}
        snapshot={snapshot}
        enabledLines={enabledLines}
        simTimeGetter={simTimeGetter}
        is3DPitch={is3DPitch}
        isSubterraneanMode={isSubterraneanMode}
        depthExaggeration={depthExaggeration}
        selectedTrainId={selectedTrain?.id ?? null}
        followSelectedTrain={followSelectedTrain}
        highlightedRouteSlugs={highlightedRouteSlugs}
        flyToTarget={flyToTarget}
        onSelectTrain={(tr) => {
          setSelectedTrain(tr);
          if (!tr) setFollowSelectedTrain(false);
        }}
        onSelectStation={(st) => {
          setSelectedStation(st);
          setFollowSelectedTrain(false);
        }}
        onTrainsTickStats={handleTrainsTickStats}
      />

      {/* LEFT FLOATING PANEL (ScanPaname Architecture) */}
      <aside className="pointer-events-auto absolute top-3 left-3 z-20 flex max-h-[calc(100vh-24px)] w-[356px] max-w-[calc(100vw-72px)] flex-col rounded-2xl border border-white/12 bg-zinc-950/88 shadow-2xl backdrop-blur-xl">
        {/* Top Brand + Clock + Train Count */}
        <div className="border-b border-white/10 p-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-[#F04E98] to-[#E87722] shadow-md">
                <TrainFront className="h-3.5 w-3.5 text-white" />
              </span>
              <span className="text-sm font-bold tracking-tight text-white">
                MetroVivo
              </span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">
                CDMX
              </span>
            </div>

            <button
              onClick={() => setSidebarCollapsed((c) => !c)}
              className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
              title={sidebarCollapsed ? "Expandir panel" : "Contraer panel"}
            >
              {sidebarCollapsed ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </button>
          </div>

          {/* Live Clock & Active Trains Row */}
          <div className="mt-2.5 flex items-baseline justify-between">
            <div>
              <div className="font-mono text-2xl font-bold tracking-tight text-white">
                {displayClock}
              </div>
              <div className="text-[11px] text-zinc-400">
                <span className="font-semibold text-zinc-200">
                  {activeTrainCount}
                </span>{" "}
                trenes en circulación
                {linesAffectedCount > 0 && (
                  <span className="ml-1.5 text-amber-400">
                    • {linesAffectedCount} líneas con marcha lenta
                  </span>
                )}
              </div>
            </div>

            {!isLiveClock ? (
              <button
                onClick={handleReturnToLive}
                className="flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-300 transition hover:bg-amber-500/30"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Volver al directo
              </button>
            ) : (
              <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                EN DIRECTO
              </span>
            )}
          </div>

          {/* Speed & Time-of-Day Scrubber */}
          <div className="mt-2.5 flex items-center gap-1.5">
            {[1, 5, 10, 30].map((spd) => (
              <button
                key={spd}
                onClick={() => handleSpeedChange(spd)}
                className={`rounded-md px-2 py-0.5 text-[11px] font-semibold transition ${
                  speedMultiplier === spd
                    ? "bg-amber-400 text-zinc-950"
                    : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                }`}
              >
                ×{spd}
              </button>
            ))}
            <input
              type="range"
              min={5 * 3600}
              max={24 * 3600}
              step={60}
              value={Math.min(24 * 3600, Math.max(5 * 3600, displaySecondsOfDay))}
              onChange={(e) => handleTimeScrub(Number(e.target.value))}
              className="ml-1 h-1.5 flex-1 cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-amber-400"
              title="Deslizar hora del día (05:00 a 24:00)"
            />
          </div>
        </div>

        {!sidebarCollapsed && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
            {/* Search Station Input */}
            <div className="relative mb-2.5">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Estación o línea (ej. Tacubaya, Chabacano)..."
                className="w-full rounded-xl border border-white/10 bg-zinc-900/90 py-2 pr-7 pl-8 text-xs text-white placeholder-zinc-500 focus:border-amber-400/60 focus:outline-none"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute top-2 right-2 text-zinc-500 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}

              {searchResults.length > 0 && (
                <div className="absolute right-0 left-0 z-30 mt-1 rounded-xl border border-white/15 bg-zinc-950 p-1 shadow-2xl">
                  {searchResults.map((item) => (
                    <button
                      key={item.slug}
                      onClick={() => {
                        setSearchQuery("");
                        triggerFlyTo(item.lon, item.lat, 15.8);
                        setSelectedStation({
                          lineId: item.firstLineId,
                          station: item.stationObj,
                        });
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-zinc-800/80"
                    >
                      <span className="font-medium text-white">{item.name}</span>
                      <div className="flex gap-1">
                        {item.lines.map((lid) => {
                          const ln = network.lines.find((l) => l.id === lid);
                          return (
                            <span
                              key={lid}
                              style={{
                                backgroundColor: ln?.color,
                                color: ln?.textColor,
                              }}
                              className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                            >
                              {lid}
                            </span>
                          );
                        })}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Primary Navigation Tabs */}
            <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-zinc-900/90 p-1 text-[11px] font-semibold">
              <button
                onClick={() => setActiveTab("lines")}
                className={`flex items-center justify-center gap-1 rounded-lg py-1.5 transition ${
                  activeTab === "lines"
                    ? "bg-white text-zinc-950 shadow"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                <Activity className="h-3.5 w-3.5" />
                Red en Vivo
              </button>
              <button
                onClick={() => setActiveTab("itinerary")}
                className={`flex items-center justify-center gap-1 rounded-lg py-1.5 transition ${
                  activeTab === "itinerary"
                    ? "bg-white text-zinc-950 shadow"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                <Route className="h-3.5 w-3.5" />
                Itinerario
              </button>
              <button
                onClick={() => setActiveTab("timer")}
                className={`flex items-center justify-center gap-1 rounded-lg py-1.5 transition ${
                  activeTab === "timer"
                    ? "bg-amber-400 text-zinc-950 shadow"
                    : "text-amber-300/90 hover:text-amber-200"
                }`}
              >
                <Timer className="h-3.5 w-3.5" />
                Cronometrar
              </button>
            </div>

            {/* Scrollable Tab Content */}
            <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
              {activeTab === "lines" && (
                <div className="space-y-2.5">
                  {/* Official STC Status Feed Header */}
                  <div className="rounded-xl border border-white/10 bg-zinc-900/65 p-2.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            snapshot?.officialSourceConnected
                              ? "bg-emerald-400"
                              : "bg-amber-400"
                          }`}
                        />
                        <span className="font-semibold text-zinc-200">
                          Estado Oficial STC ({snapshot?.officialUpdatedAtLabel ?? "..."})
                        </span>
                      </div>
                      <button
                        onClick={() => fetchLiveSnapshot(undefined, true)}
                        className="rounded p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
                        title="Refrescar estado oficial de incidentesmovilidad"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="mt-1 text-[10px] text-zinc-400">
                      {snapshot?.activeTimeBandLabel ?? "Cargando franja..."}
                    </div>
                  </div>

                  {/* Quick Filter All / None */}
                  <div className="flex items-center justify-between px-0.5 text-[11px]">
                    <span className="font-semibold text-zinc-400">
                      Líneas ({enabledLines.size}/12 visibles)
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          setEnabledLines(
                            new Set(network.lines.map((l) => l.id))
                          )
                        }
                        className="text-zinc-300 hover:text-white hover:underline"
                        title="Mostrar las 12 líneas en el mapa"
                      >
                        Ver todas
                      </button>
                      <button
                        onClick={() => setEnabledLines(new Set(["1", "2", "3"]))}
                        className="text-zinc-400 hover:text-white hover:underline"
                        title="Despejar el mapa dejando solo las Líneas 1, 2 y 3"
                      >
                        Principales (L1–L3)
                      </button>
                    </div>
                  </div>

                  {/* 12 Lines Live Cards */}
                  <div className="space-y-1.5">
                    {network.lines.map((line) => {
                      const st = snapshot?.lines[line.id];
                      const active = enabledLines.has(line.id);
                      const isRain = st?.regime === "RAIN_SLOW";
                      const isBad =
                        st?.regime === "DELAYED" ||
                        st?.regime === "PARTIAL_CLOSURE" ||
                        st?.regime === "SUSPENDED";
                      const isSlowEmpirical =
                        (st?.empiricalSlownessRatio ?? 1) > 1.15;

                      return (
                        <div
                          key={line.id}
                          onClick={() => {
                            setEnabledLines((prev) => {
                              const next = new Set(prev);
                              if (next.has(line.id) && next.size > 1) {
                                next.delete(line.id);
                              } else {
                                next.add(line.id);
                              }
                              return next;
                            });
                          }}
                          className={`cursor-pointer rounded-xl border p-2 transition ${
                            active
                              ? "border-white/12 bg-zinc-900/75 hover:border-white/25"
                              : "border-white/5 bg-zinc-950/40 opacity-45 hover:opacity-75"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <span
                                style={{
                                  backgroundColor: line.color,
                                  color: line.textColor,
                                }}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-extrabold shadow"
                              >
                                {line.id}
                              </span>
                              <div className="min-w-0">
                                <div className="truncate text-xs font-semibold text-white">
                                  {line.originName} ↔ {line.destinationName}
                                </div>
                                <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                                  <span>
                                    Paso ~
                                    {st
                                      ? `${Math.round(
                                          (st.headwaySec * st.headwayMultiplier) / 60
                                        )}m ${Math.round(
                                          (st.headwaySec * st.headwayMultiplier) % 60
                                        )}s`
                                      : "--"}
                                  </span>
                                  <span>•</span>
                                  <span>
                                    {line.rollingStock === "steel"
                                      ? "Férreo"
                                      : "Neumático"}
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Status Badge */}
                            <div className="shrink-0 text-right">
                              {isRain ? (
                                <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                                  <CloudRain className="h-3 w-3" />
                                  Lluvia (-31%)
                                </span>
                              ) : isBad ? (
                                <span className="inline-flex items-center gap-1 rounded-md bg-red-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                                  <AlertTriangle className="h-3 w-3" />
                                  Incidente
                                </span>
                              ) : isSlowEmpirical ? (
                                <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                                  Lenta (×{st?.empiricalSlownessRatio})
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                                  Regular
                                </span>
                              )}
                              {st?.confidenceTier === 3 && (
                                <div className="mt-0.5 text-[9px] font-semibold text-sky-400">
                                  ● Sincronizada en vivo
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {activeTab === "itinerary" && (
                <div className="space-y-3 text-xs">
                  <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
                    <div>
                      <label className="mb-1 block text-[10px] font-semibold uppercase text-zinc-400">
                        Estación Origen
                      </label>
                      <select
                        value={originSlug}
                        onChange={(e) => setOriginSlug(e.target.value)}
                        className="w-full rounded-lg border border-white/15 bg-zinc-950 px-2.5 py-1.5 text-xs text-white"
                      >
                        {uniqueStations.map((s) => (
                          <option key={s.slug} value={s.slug}>
                            {s.name} (L{s.lines.join("/")})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-[10px] font-semibold uppercase text-zinc-400">
                        Estación Destino
                      </label>
                      <select
                        value={destSlug}
                        onChange={(e) => setDestSlug(e.target.value)}
                        className="w-full rounded-lg border border-white/15 bg-zinc-950 px-2.5 py-1.5 text-xs text-white"
                      >
                        {uniqueStations.map((s) => (
                          <option key={s.slug} value={s.slug}>
                            {s.name} (L{s.lines.join("/")})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {itinerary ? (
                    <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
                      <div className="flex items-center justify-between border-b border-white/10 pb-2">
                        <div>
                          <div className="text-[10px] text-zinc-400">
                            Tiempo estimado real (incluye esperas y lluvia)
                          </div>
                          <div className="text-lg font-bold text-white">
                            {Math.round(itinerary.totalDurationSec / 60)} min
                          </div>
                        </div>
                        <span className="rounded-lg bg-zinc-800 px-2 py-1 text-[11px] font-semibold text-zinc-300">
                          {itinerary.transfersCount === 0
                            ? "Directo"
                            : `${itinerary.transfersCount} transbordo(s)`}
                        </span>
                      </div>

                      <div className="space-y-2 pt-1">
                        {itinerary.steps.map((step, idx) => (
                          <div
                            key={idx}
                            className="rounded-lg border border-white/5 bg-zinc-950/75 p-2.5"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span
                                  style={{
                                    backgroundColor: step.lineColor,
                                    color: step.lineTextColor,
                                  }}
                                  className="rounded px-1.5 py-0.5 text-[10px] font-extrabold"
                                >
                                  Línea {step.lineId}
                                </span>
                                <span className="text-[11px] font-semibold text-zinc-300">
                                  → {step.directionHeadsign}
                                </span>
                              </div>
                              <span className="font-mono text-[11px] text-amber-300">
                                {Math.round(step.durationSec / 60)} min
                              </span>
                            </div>
                            <div className="mt-1 text-[11px] text-zinc-200">
                              {step.fromStation} →{" "}
                              <span className="font-semibold">{step.toStation}</span>{" "}
                              <span className="text-zinc-500">
                                ({step.stopsCount} est.)
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="px-1 text-[11px] text-zinc-500">
                      Selecciona dos estaciones distintas para calcular la ruta óptima en vivo.
                    </p>
                  )}
                </div>
              )}

              {activeTab === "timer" && (
                <FieldTimerPanel
                  network={network}
                  snapshot={snapshot}
                  onDataUpdated={() => fetchLiveSnapshot()}
                  onFlyToStation={(lon, lat) => triggerFlyTo(lon, lat, 15.5)}
                />
              )}
            </div>

            {/* ScanPaname-style Open Citizen & Data Attribution Disclaimer */}
            <div className="mt-2.5 border-t border-white/10 pt-2 text-[10px] leading-snug text-zinc-500">
              <span className="font-semibold text-zinc-300">
                Proyecto ciudadano libre y sin fines de lucro.
              </span>{" "}
              Posiciones estimadas (el STC Metro no emite GPS por tren). Tiempos comunitarios abiertos (CC BY 4.0) • SEMOVI CDMX • © OpenStreetMap.
            </div>
          </div>
        )}
      </aside>

      {/* RIGHT FLOATING 3D & SUBTERRANEAN DEPTH CONTROLS (ScanPaname Screenshot 1 Style!) */}
      <div className="pointer-events-auto absolute right-3 bottom-6 z-20 flex flex-col items-center gap-2">
        {isSubterraneanMode && (
          <div className="flex flex-col items-center rounded-2xl border border-white/15 bg-zinc-950/90 px-2.5 py-3 shadow-xl backdrop-blur-md">
            <span className="text-[9px] font-bold uppercase tracking-wider text-amber-400">
              Profundidad
            </span>
            <input
              type="range"
              min={0.8}
              max={2.2}
              step={0.1}
              value={depthExaggeration}
              onChange={(e) => setDepthExaggeration(Number(e.target.value))}
              className="my-3 h-24 w-1.5 cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-amber-400 [writing-mode:vertical-lr]"
              title="Exageración vertical subterránea (L7 -34m a L4 +8.5m)"
            />
            <span className="font-mono text-[10px] text-zinc-300">
              ×{depthExaggeration.toFixed(1)}
            </span>
          </div>
        )}

        <button
          onClick={() => {
            setIsSubterraneanMode((v) => {
              const next = !v;
              if (next) setIs3DPitch(true);
              return next;
            });
          }}
          className={`flex h-10 w-10 items-center justify-center rounded-xl border shadow-lg backdrop-blur-md transition ${
            isSubterraneanMode
              ? "border-amber-400 bg-amber-400 text-zinc-950"
              : "border-white/15 bg-zinc-950/90 text-zinc-200 hover:bg-zinc-800"
          }`}
          title="Vista en Profundidad Subterránea (Rayos X: L7 -34m vs Viaductos +9m)"
        >
          <Layers className="h-4 w-4" />
        </button>

        <button
          onClick={() => setIs3DPitch((p) => !p)}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-zinc-950/90 text-xs font-extrabold text-white shadow-lg backdrop-blur-md transition hover:bg-zinc-800"
          title="Alternar vista inclinada 3D / plana 2D"
        >
          {is3DPitch ? "2D" : "3D"}
        </button>

        <button
          onClick={() => triggerFlyTo(-99.1415, 19.4285, 13.4)}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-zinc-950/90 text-zinc-200 shadow-lg backdrop-blur-md transition hover:bg-zinc-800"
          title="Centrar red Metro CDMX"
        >
          <Compass className="h-4 w-4" />
        </button>
      </div>

      {/* BOTTOM SUBTERRANEAN MODE CAPTION BANNER (Just like Screenshot 1!) */}
      {isSubterraneanMode && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-amber-400/30 bg-zinc-950/90 px-4 py-1.5 text-xs text-zinc-200 shadow-2xl backdrop-blur-md">
          <span className="font-semibold text-amber-300">
            Vista en profundidad 3D:
          </span>{" "}
          cada línea muestra su cota real (ej. L7 a -34 m bajo Tacubaya; L4 y L9 Oriente en viaducto +9 m).
        </div>
      )}

      {/* SELECTED TRAIN FLOATING TELEMETRY & ONBOARD CAMERA CARD */}
      {selectedTrain && (
        <div className="pointer-events-auto absolute top-3 right-3 z-20 w-80 rounded-2xl border border-white/15 bg-zinc-950/92 p-3.5 shadow-2xl backdrop-blur-xl">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span
                style={{
                  backgroundColor: selectedTrain.lineColor,
                  color: selectedTrain.lineTextColor,
                }}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-black shadow"
              >
                {selectedTrain.lineId}
              </span>
              <div>
                <div className="text-xs font-bold text-white">
                  Tren #{selectedTrain.runNumber} • → {selectedTrain.headsign}
                </div>
                <div className="text-[11px] text-zinc-400">
                  {selectedTrain.trainModel} ({selectedTrain.cars.length || 9} carros)
                </div>
              </div>
            </div>
            <button
              onClick={() => {
                setSelectedTrain(null);
                setFollowSelectedTrain(false);
              }}
              className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-1.5 rounded-xl bg-zinc-900/90 p-2 text-center">
            <div>
              <div className="text-[10px] text-zinc-500">Velocidad</div>
              <div className="font-mono text-sm font-bold text-white">
                {selectedTrain.speedKmh.toFixed(0)}{" "}
                <span className="text-[10px] font-normal text-zinc-400">km/h</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-500">Estado</div>
              <div className="text-[11px] font-semibold text-amber-300">
                {selectedTrain.state === "DWELLING"
                  ? "En andén"
                  : selectedTrain.state === "ACCELERATING"
                  ? "Acelerando"
                  : selectedTrain.state === "BRAKING"
                  ? "Frenando"
                  : selectedTrain.state === "HELD_SIGNAL"
                  ? "Señal PA"
                  : "Crucero"}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-500">Cota / Nivel</div>
              <div className="font-mono text-xs font-semibold text-zinc-200">
                {selectedTrain.elevationM > 2
                  ? `+${selectedTrain.elevationM.toFixed(0)}m Viad.`
                  : selectedTrain.elevationM >= 0
                  ? "Superficie"
                  : `${selectedTrain.elevationM.toFixed(0)}m Túnel`}
              </div>
            </div>
          </div>

          <div className="mt-2.5 rounded-xl border border-white/8 bg-zinc-900/50 p-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Próxima estación:</span>
              <span className="font-mono font-semibold text-emerald-400">
                {selectedTrain.nextStationEtaSec === 0
                  ? "Puertas abiertas"
                  : `en ${selectedTrain.nextStationEtaSec} s`}
              </span>
            </div>
            <div className="mt-0.5 text-sm font-bold text-white">
              {selectedTrain.nextStationName}
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                style={{
                  width: `${Math.round(selectedTrain.progressInSegment * 100)}%`,
                  backgroundColor: selectedTrain.lineColor,
                }}
                className="h-full transition-all duration-200"
              />
            </div>
          </div>

          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => {
                setFollowSelectedTrain((f) => !f);
                if (!followSelectedTrain) {
                  triggerFlyTo(selectedTrain.lon, selectedTrain.lat, 16.2);
                }
              }}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition ${
                followSelectedTrain
                  ? "bg-amber-400 text-zinc-950"
                  : "bg-zinc-800 text-white hover:bg-zinc-700"
              }`}
            >
              {followSelectedTrain ? (
                <>
                  <LocateFixed className="h-3.5 w-3.5" /> Siguiendo a bordo (3D)
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" /> Subirse al tren (Vista 3D)
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* SELECTED STATION FLOATING ARRIVALS & LIVE PHASE ANCHOR CARD */}
      {selectedStation && (
        <div className="pointer-events-auto absolute top-3 right-3 z-20 w-80 rounded-2xl border border-white/15 bg-zinc-950/92 p-3.5 shadow-2xl backdrop-blur-xl">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-white">
                  {selectedStation.station.name}
                </span>
                {selectedStation.station.isTransfer && (
                  <span className="rounded bg-white/15 px-1.5 py-0.5 text-[9px] font-bold text-white">
                    CORRESPONDENCIA
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-400">
                Línea {selectedStation.lineId} • Afluencia 2026:{" "}
                <span className="text-zinc-200">
                  {selectedStation.station.dailyRidership.toLocaleString("es-MX")}
                </span>{" "}
                pas./día
              </div>
            </div>
            <button
              onClick={() => setSelectedStation(null)}
              className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Upcoming Departures */}
          <div className="mt-3 space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              Próximos trenes estimados
            </div>
            {stationArrivals.length === 0 ? (
              <div className="rounded-lg bg-zinc-900 p-2 text-xs text-zinc-500">
                Fuera de horario de servicio o terminal de descenso.
              </div>
            ) : (
              stationArrivals.slice(0, 4).map((arr) => (
                <div
                  key={arr.trainId}
                  className="flex items-center justify-between rounded-lg border border-white/5 bg-zinc-900/80 px-2.5 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-1.5 truncate pr-2">
                    <Navigation className="h-3 w-3 shrink-0 text-amber-400" />
                    <span className="truncate font-medium text-zinc-200">
                      → {arr.headsign}
                    </span>
                  </div>
                  <span
                    className={`shrink-0 font-mono font-bold ${
                      arr.etaSec <= 20 ? "text-emerald-400" : "text-white"
                    }`}
                  >
                    {arr.etaSec === 0
                      ? "En andén"
                      : arr.etaSec < 60
                      ? `${arr.etaSec} s`
                      : `${Math.floor(arr.etaSec / 60)}m ${arr.etaSec % 60}s`}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Instant Live Train Sighting Sync right from Station Popup */}
          <div className="mt-3 border-t border-white/10 pt-2.5">
            <div className="mb-1.5 flex items-center gap-1 text-[10px] text-sky-300">
              <Radio className="h-3 w-3" />
              <span>¿Ves salir un tren ahorita? Sincroniza el mapa:</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {([0, 1] as const).map((d) => {
                const ln = network.lines.find(
                  (l) => l.id === selectedStation.lineId
                );
                const dir = ln?.directions[String(d) as "0" | "1"];
                if (!dir) return null;
                return (
                  <button
                    key={d}
                    onClick={() => handleQuickStationPhaseSnap(d)}
                    className="truncate rounded-lg border border-sky-400/30 bg-sky-500/15 px-2 py-1.5 text-[10px] font-semibold text-sky-200 hover:bg-sky-500/25 active:scale-[0.98]"
                  >
                    Acaba de salir → {dir.headsign}
                  </button>
                );
              })}
            </div>
            {phaseSnapFeedback && (
              <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/15 p-2 text-[11px] font-medium text-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span>{phaseSnapFeedback}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
