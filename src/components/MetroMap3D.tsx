"use client";

import React, { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  LineId,
  LiveSystemSnapshot,
  NetworkStaticBundle,
  StationStopOnDirection,
} from "@/types/metro";
import {
  type ActiveTrainPose,
  computeAllActiveTrains,
} from "@/lib/kinematics";

export interface SelectedStationInfo {
  lineId: LineId;
  station: StationStopOnDirection;
}

interface MetroMap3DProps {
  network: NetworkStaticBundle;
  snapshot: LiveSystemSnapshot | null;
  enabledLines: Set<LineId>;
  simTimeGetter: () => number; // returns current effective timestampMs at 60 FPS
  is3DPitch: boolean;
  isSubterraneanMode: boolean;
  depthExaggeration: number; // 1.0 .. 2.2
  selectedTrainId: string | null;
  followSelectedTrain: boolean;
  highlightedRouteSlugs: Set<string>;
  flyToTarget: { lon: number; lat: number; zoom?: number; seq: number } | null;
  onSelectTrain: (train: ActiveTrainPose | null) => void;
  onSelectStation: (info: SelectedStationInfo | null) => void;
  onTrainsTickStats: (count: number, selectedPose: ActiveTrainPose | null) => void;
}

const DARK_VECTOR_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/**
 * Generates a small local East-North rectangle polygon for a single 3D subway car
 * with chamfered cab nose on lead/tail cars for ScanPaname-style visual crispness!
 */
function buildCarPolygon(
  lon: number,
  lat: number,
  bearingDeg: number,
  lengthM: number,
  widthM: number,
  isLead: boolean,
  isTail: boolean
): [number, number][] {
  const rad = (bearingDeg * Math.PI) / 180;
  const sinB = Math.sin(rad);
  const cosB = Math.cos(rad);
  const cosLat = Math.cos((lat * Math.PI) / 180);

  const toLonLat = (forwardM: number, rightM: number): [number, number] => {
    const eastM = forwardM * sinB + rightM * cosB;
    const northM = forwardM * cosB - rightM * sinB;
    return [
      lon + eastM / (111320 * cosLat),
      lat + northM / 110540,
    ];
  };

  const hl = lengthM * 0.5;
  const hw = widthM * 0.5;

  const noseTaper = hw * 0.66;
  const noseSetback = Math.min(2.2, lengthM * 0.14);

  const pts: [number, number][] = [];
  if (isLead) {
    pts.push(
      toLonLat(hl, -noseTaper),
      toLonLat(hl, noseTaper),
      toLonLat(hl - noseSetback, hw)
    );
  } else {
    pts.push(toLonLat(hl, -hw), toLonLat(hl, hw));
  }

  if (isTail) {
    pts.push(
      toLonLat(-hl + noseSetback, hw),
      toLonLat(-hl, noseTaper),
      toLonLat(-hl, -noseTaper),
      toLonLat(-hl + noseSetback, -hw)
    );
  } else {
    pts.push(toLonLat(-hl, hw), toLonLat(-hl, -hw));
  }

  if (isLead) {
    pts.push(toLonLat(hl - noseSetback, -hw));
  }
  pts.push(pts[0]); // close ring
  return pts;
}

function buildOctagonAroundPoint(
  lon: number,
  lat: number,
  radiusM: number
): [number, number][] {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const ring: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ring.push([
      lon + (Math.cos(a) * radiusM) / (111320 * cosLat),
      lat + (Math.sin(a) * radiusM) / 110540,
    ]);
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * Converts track polyline into thin 3D ribbon polygons for subterranean/elevated extrusion view.
 */
function buildTrackRibbonSegments(
  network: NetworkStaticBundle,
  subterraneanMode: boolean,
  exaggeration: number,
  enabledLines: Set<LineId>
) {
  const features: GeoJSON.Feature[] = [];
  const datumShiftM = subterraneanMode ? 42 * exaggeration : 0;

  for (const line of network.lines) {
    if (!enabledLines.has(line.id)) continue;
    for (const dirKey of ["0", "1"] as const) {
      const verts = line.directions[dirKey].vertices;
      // Step in chunks for crisp ribbon performance
      for (let i = 0; i < verts.length - 1; i++) {
        const v0 = verts[i];
        const v1 = verts[i + 1];
        const elevAvg = (v0[3] + v1[3]) * 0.5;

        if (!subterraneanMode && elevAvg < 2.0) continue; // In surface mode only extrude elevated viaducts!

        const baseZ = Math.max(
          0,
          subterraneanMode ? datumShiftM + elevAvg * exaggeration - 0.8 : elevAvg - 1.1
        );
        const topZ = baseZ + 0.9;

        const cosLat = Math.cos(((v0[1] + v1[1]) * 0.5 * Math.PI) / 180);
        const dx = (v1[0] - v0[0]) * 111320 * cosLat;
        const dy = (v1[1] - v0[1]) * 110540;
        const len = Math.hypot(dx, dy);
        if (len < 0.5) continue;

        const halfW = 1.65;
        const nx = ((dy / len) * halfW) / (111320 * cosLat);
        const ny = (-(dx / len) * halfW) / 110540;

        features.push({
          type: "Feature",
          properties: {
            color: line.color,
            baseZ,
            topZ,
          },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [v0[0] - nx, v0[1] - ny],
                [v0[0] + nx, v0[1] + ny],
                [v1[0] + nx, v1[1] + ny],
                [v1[0] - nx, v1[1] - ny],
                [v0[0] - nx, v0[1] - ny],
              ],
            ],
          },
        });
      }
    }
  }

  return {
    type: "FeatureCollection" as const,
    features,
  };
}

export default function MetroMap3D({
  network,
  snapshot,
  enabledLines,
  simTimeGetter,
  is3DPitch,
  isSubterraneanMode,
  depthExaggeration,
  selectedTrainId,
  followSelectedTrain,
  highlightedRouteSlugs,
  flyToTarget,
  onSelectTrain,
  onSelectStation,
  onTrainsTickStats,
}: MetroMap3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapLoadedRef = useRef<boolean>(false);

  // Keep latest props in refs for lock-free 60 FPS animation loop
  const latestPropsRef = useRef({
    network,
    snapshot,
    enabledLines,
    simTimeGetter,
    isSubterraneanMode,
    depthExaggeration,
    selectedTrainId,
    followSelectedTrain,
    onTrainsTickStats,
  });
  latestPropsRef.current = {
    network,
    snapshot,
    enabledLines,
    simTimeGetter,
    isSubterraneanMode,
    depthExaggeration,
    selectedTrainId,
    followSelectedTrain,
    onTrainsTickStats,
  };

  const latestTrainsRef = useRef<ActiveTrainPose[]>([]);

  // Initialize MapLibre GL JS
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: DARK_VECTOR_STYLE,
      center: [-99.1415, 19.4285], // Centro Histórico / Balderas / Salto del Agua hub
      zoom: 13.4,
      pitch: 56,
      bearing: -18,
      maxPitch: 76,
      minZoom: 10.2,
      maxZoom: 18.5,
    });

    mapRef.current = map;

    map.on("load", () => {
      // Build 2D dual-track lines GeoJSON + Stations + Exits + Vertical Shafts
      const trackLineFeatures: GeoJSON.Feature[] = [];
      const stationFeatures: GeoJSON.Feature[] = [];
      const seenStationIds = new Set<string>();

      for (const line of network.lines) {
        for (const dirKey of ["0", "1"] as const) {
          const dir = line.directions[dirKey];
          trackLineFeatures.push({
            type: "Feature",
            properties: {
              lineId: line.id,
              color: line.color,
              directionId: dir.directionId,
            },
            geometry: {
              type: "LineString",
              coordinates: dir.vertices.map((v) => [v[0], v[1]]),
            },
          });

          for (const st of dir.stations) {
            if (seenStationIds.has(st.stationId)) continue;
            seenStationIds.add(st.stationId);
            stationFeatures.push({
              type: "Feature",
              properties: {
                stationId: st.stationId,
                lineId: line.id,
                name: st.name,
                slug: st.slug,
                color: line.color,
                elevationM: st.elevationM,
                isTransfer: st.isTransfer ? 1 : 0,
                isTerminal: st.isTerminal ? 1 : 0,
                dailyRidership: st.dailyRidership,
                 highlighted: 0,
              },
              geometry: {
                type: "Point",
                coordinates: [st.lon, st.lat],
              },
            });
          }
        }
      }

      const exitFeatures: GeoJSON.Feature[] = network.exits.map((ex) => ({
        type: "Feature",
        properties: {
          id: ex.id,
          lineId: ex.lineId,
          label: ex.label,
        },
        geometry: {
          type: "Point",
          coordinates: [ex.lon, ex.lat],
        },
      }));

      // 1. Subterranean dark veil layer (toggled when Vista en Profundidad is active)
      map.addSource("subterranean-veil", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-99.6, 19.0],
                [-98.7, 19.0],
                [-98.7, 19.8],
                [-99.6, 19.8],
                [-99.6, 19.0],
              ],
            ],
          },
        },
      });
      map.addLayer({
        id: "subterranean-veil-layer",
        type: "fill",
        source: "subterranean-veil",
        paint: {
          "fill-color": "#06080F",
          "fill-opacity": 0,
        },
      });

      // 2. 2D Dual Parallel Tracks (Outer casing + Crisp inner rail)
      map.addSource("metro-tracks", {
        type: "geojson",
        data: { type: "FeatureCollection", features: trackLineFeatures },
      });

      map.addLayer({
        id: "metro-tracks-glow",
        type: "line",
        source: "metro-tracks",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10.5,
            2.5,
            14,
            5.5,
            17,
            11,
          ],
          "line-opacity": 0.24,
          "line-blur": 2.5,
        },
      });

      map.addLayer({
        id: "metro-tracks-rail",
        type: "line",
        source: "metro-tracks",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10.5,
            1.4,
            13.5,
            2.4,
            16.5,
            4.2,
          ],
          "line-opacity": 0.9,
        },
      });

      // 3. 3D Extruded Track Ribbons (Viaducts + Subterranean Depth Mode)
      map.addSource("metro-ribbons-3d", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "metro-ribbons-3d-layer",
        type: "fill-extrusion",
        source: "metro-ribbons-3d",
        paint: {
          "fill-extrusion-color": ["get", "color"],
          "fill-extrusion-base": ["get", "baseZ"],
          "fill-extrusion-height": ["get", "topZ"],
          "fill-extrusion-opacity": 0.82,
        },
      });

      // 4. Vertical Station Pillars / Shafts in Subterranean Mode
      map.addSource("station-shafts-3d", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "station-shafts-3d-layer",
        type: "fill-extrusion",
        source: "station-shafts-3d",
        paint: {
          "fill-extrusion-color": "#64748B",
          "fill-extrusion-base": ["get", "baseZ"],
          "fill-extrusion-height": ["get", "topZ"],
          "fill-extrusion-opacity": 0.42,
        },
      });

      // 5. Station Exits (ScanPaname style street exits at high zoom)
      map.addSource("station-exits", {
        type: "geojson",
        data: { type: "FeatureCollection", features: exitFeatures },
      });
      map.addLayer({
        id: "station-exits-circle",
        type: "circle",
        source: "station-exits",
        minzoom: 15,
        paint: {
          "circle-radius": 4,
          "circle-color": "#10B981",
          "circle-stroke-width": 1.2,
          "circle-stroke-color": "#052E16",
        },
      });

      // 6. Stations Circles & Labels
      map.addSource("metro-stations", {
        type: "geojson",
        data: { type: "FeatureCollection", features: stationFeatures },
      });

      map.addLayer({
        id: "metro-stations-circle",
        type: "circle",
        source: "metro-stations",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10.5,
            ["case", ["==", ["get", "isTransfer"], 1], 3.2, 1.8],
            14,
            ["case", ["==", ["get", "isTransfer"], 1], 6.5, 4.2],
            16.5,
            ["case", ["==", ["get", "isTransfer"], 1], 9.5, 6.8],
          ],
          "circle-color": [
            "case",
            ["==", ["get", "isTransfer"], 1],
            "#FFFFFF",
            "#090D16",
          ],
          "circle-stroke-width": [
            "case",
            ["==", ["get", "isTransfer"], 1],
            2.4,
            2.0,
          ],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "isTransfer"], 1],
            "#0F172A",
            ["get", "color"],
          ],
        },
      });

      map.addLayer({
        id: "metro-stations-label",
        type: "symbol",
        source: "metro-stations",
        minzoom: 12.2,
        layout: {
          "text-field": ["get", "name"],
          "text-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12.2,
            10,
            15,
            12.5,
          ],
          "text-offset": [0, 1.15],
          "text-anchor": "top",
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        },
        paint: {
          "text-color": "#F1F5F9",
          "text-halo-color": "#05070C",
          "text-halo-width": 1.8,
        },
      });

      // 7. Live Train Headlight Aura (2D soft glow under trains, visible at all zooms)
      map.addSource("trains-points", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "trains-aura",
        type: "circle",
        source: "trains-points",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10.5,
            6,
            13.5,
            11,
            16,
            16,
          ],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.32,
          "circle-blur": 0.85,
        },
      });

      // Low-zoom crisp capsule dot (LOD when zoomed out across whole CDMX)
      map.addLayer({
        id: "trains-lowzoom-dot",
        type: "circle",
        source: "trains-points",
        maxzoom: 13.1,
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "selected"], 1],
            6.5,
            4.2,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 1.6,
          "circle-stroke-color": "#FFFFFF",
        },
      });

      // 8. High-detail 3D Articulated Subway Cars (ScanPaname signature multi-car extrusion!)
      map.addSource("trains-cars-3d", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "trains-cars-3d-body",
        type: "fill-extrusion",
        source: "trains-cars-3d",
        minzoom: 12.6,
        paint: {
          "fill-extrusion-color": ["get", "color"],
          "fill-extrusion-base": ["get", "baseZ"],
          "fill-extrusion-height": ["get", "topZ"],
          "fill-extrusion-opacity": 0.96,
        },
      });

      // 9. Floating Line Number Badge above every train (just like ScanPaname's circular badges!)
      map.addLayer({
        id: "trains-badge-bg",
        type: "circle",
        source: "trains-points",
        minzoom: 11.4,
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            11.4,
            7.5,
            14.5,
            10.5,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-width": [
            "case",
            ["==", ["get", "selected"], 1],
            2.8,
            1.6,
          ],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "selected"], 1],
            "#FDE047",
            "#FFFFFF",
          ],
          "circle-translate": [0, -10],
          "circle-translate-anchor": "viewport",
        },
      });

      map.addLayer({
        id: "trains-badge-text",
        type: "symbol",
        source: "trains-points",
        minzoom: 11.4,
        layout: {
          "text-field": ["get", "lineId"],
          "text-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            11.4,
            9,
            14.5,
            11,
          ],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": ["get", "textColor"],
          "text-translate": [0, -10],
          "text-translate-anchor": "viewport",
        },
      });

      // Interactive clicks on trains & stations
      const handleTrainClick = (e: maplibregl.MapLayerMouseEvent) => {
        const feat = e.features?.[0];
        if (!feat) return;
        const trainId = feat.properties?.id;
        const found =
          latestTrainsRef.current.find((t) => t.id === trainId) ?? null;
        if (found) {
          onSelectStation(null);
          onSelectTrain(found);
        }
      };

      for (const layerId of [
        "trains-badge-bg",
        "trains-lowzoom-dot",
        "trains-cars-3d-body",
      ]) {
        map.on("click", layerId, handleTrainClick);
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      map.on("click", "metro-stations-circle", (e) => {
        const feat = e.features?.[0];
        if (!feat) return;
        const lid = feat.properties?.lineId as LineId;
        const stId = feat.properties?.stationId as string;
        const ln = latestPropsRef.current.network.lines.find(
          (l) => l.id === lid
        );
        const st = ln?.directions["0"].stations.find(
          (s) => s.stationId === stId
        );
        if (ln && st) {
          onSelectTrain(null);
          onSelectStation({ lineId: lid, station: st });
        }
      });

      map.on("mouseenter", "metro-stations-circle", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "metro-stations-circle", () => {
        map.getCanvas().style.cursor = "";
      });

      mapLoadedRef.current = true;
    });

    return () => {
      mapLoadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update 2D/3D camera pitch
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({
      pitch: is3DPitch ? (isSubterraneanMode ? 64 : 56) : 0,
      duration: 650,
    });
  }, [is3DPitch, isSubterraneanMode]);

  // FlyTo handler
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyToTarget) return;
    map.flyTo({
      center: [flyToTarget.lon, flyToTarget.lat],
      zoom: flyToTarget.zoom ?? Math.max(map.getZoom(), 15.2),
      duration: 1100,
    });
  }, [flyToTarget]);

  // Update line filters, route highlight, and 3D subterranean ribbons/shafts
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;

    const activeIds = Array.from(enabledLines);
    const filterExpr: maplibregl.FilterSpecification = [
      "in",
      ["get", "lineId"],
      ["literal", activeIds],
    ];

    for (const lid of [
      "metro-tracks-glow",
      "metro-tracks-rail",
      "metro-stations-circle",
      "metro-stations-label",
      "station-exits-circle",
    ]) {
      if (map.getLayer(lid)) map.setFilter(lid, filterExpr);
    }

    // Dim 2D surface rails when in 3D subterranean mode so elevated/deep 3D ribbons stand out!
    map.setPaintProperty(
      "subterranean-veil-layer",
      "fill-opacity",
      isSubterraneanMode ? 0.78 : 0
    );
    map.setPaintProperty(
      "metro-tracks-rail",
      "line-opacity",
      isSubterraneanMode
        ? 0.22
        : highlightedRouteSlugs.size > 0
        ? 0.45
        : 0.9
    );

    const ribbonSource = map.getSource(
      "metro-ribbons-3d"
    ) as maplibregl.GeoJSONSource | undefined;
    if (ribbonSource) {
      ribbonSource.setData(
        buildTrackRibbonSegments(
          network,
          isSubterraneanMode,
          depthExaggeration,
          enabledLines
        )
      );
    }

    const shaftSource = map.getSource(
      "station-shafts-3d"
    ) as maplibregl.GeoJSONSource | undefined;
    if (shaftSource) {
      if (!isSubterraneanMode) {
        shaftSource.setData({ type: "FeatureCollection", features: [] });
      } else {
        const datumM = 42 * depthExaggeration;
        const shaftFeatures: GeoJSON.Feature[] = [];
        const seen = new Set<string>();
        for (const line of network.lines) {
          if (!enabledLines.has(line.id)) continue;
          for (const st of line.directions["0"].stations) {
            if (seen.has(st.stationId)) continue;
            seen.add(st.stationId);
            const zPlatform = Math.max(
              0,
              datumM + st.elevationM * depthExaggeration
            );
            const baseZ = Math.min(zPlatform, datumM);
            const topZ = Math.max(zPlatform, datumM);
            if (topZ - baseZ < 1.5) continue;

            shaftFeatures.push({
              type: "Feature",
              properties: { baseZ, topZ },
              geometry: {
                type: "Polygon",
                coordinates: [buildOctagonAroundPoint(st.lon, st.lat, 5.5)],
              },
            });
          }
        }
        shaftSource.setData({
          type: "FeatureCollection",
          features: shaftFeatures,
        });
      }
    }
  }, [
    network,
    enabledLines,
    isSubterraneanMode,
    depthExaggeration,
    highlightedRouteSlugs,
  ]);

  // 60 FPS Animation Loop driving live kinematic train interpolation & 3D articulated cars
  useEffect(() => {
    let rafId = 0;
    let lastStatsReportMs = 0;

    const animate = (perfNow: number) => {
      const map = mapRef.current;
      const p = latestPropsRef.current;

      if (map && mapLoadedRef.current && p.snapshot) {
        const simMs = p.simTimeGetter();
        const zoom = map.getZoom();
        const need3DCars = zoom >= 12.5;

        const trains = computeAllActiveTrains(
          p.network,
          p.snapshot,
          simMs,
          p.enabledLines,
          need3DCars
        );
        latestTrainsRef.current = trains;

        const datumShiftM = p.isSubterraneanMode ? 42 * p.depthExaggeration : 0;

        const pointFeatures: GeoJSON.Feature[] = new Array(trains.length);
        const carFeatures: GeoJSON.Feature[] = [];

        // Enlarge train width subtly at medium zoom (12.6..14.5) so miniature 3D cars look crisp like ScanPaname!
        const visualScale =
          zoom < 13.5 ? 2.1 : zoom < 14.8 ? 1.45 : 1.05;

        let selectedPose: ActiveTrainPose | null = null;

        for (let i = 0; i < trains.length; i++) {
          const t = trains[i];
          const isSel = t.id === p.selectedTrainId;
          if (isSel) selectedPose = t;

          const centerCar =
            t.cars.length > 0
              ? t.cars[Math.floor(t.cars.length / 2)]
              : { lon: t.lon, lat: t.lat };

          pointFeatures[i] = {
            type: "Feature",
            properties: {
              id: t.id,
              lineId: t.lineId,
              color: t.lineColor,
              textColor: t.lineTextColor,
              selected: isSel ? 1 : 0,
            },
            geometry: {
              type: "Point",
              coordinates: [centerCar.lon, centerCar.lat],
            },
          };

          if (need3DCars) {
            for (let c = 0; c < t.cars.length; c++) {
              const car = t.cars[c];
              const rawBaseZ = p.isSubterraneanMode
                ? datumShiftM + car.elevationM * p.depthExaggeration
                : Math.max(0.2, car.elevationM);
              const baseZ = Math.max(0.1, rawBaseZ);
              const carHeight = 3.8 * visualScale;

              // Highlight lead cab roof slightly brighter or yellow if selected
              const carColor = isSel
                ? "#FACC15"
                : car.isLead && t.rollingStock === "pneumatic"
                ? t.lineColor
                : t.lineColor;

              carFeatures.push({
                type: "Feature",
                properties: {
                  id: t.id,
                  color: carColor,
                  baseZ,
                  topZ: baseZ + carHeight,
                },
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    buildCarPolygon(
                      car.lon,
                      car.lat,
                      car.bearingDeg,
                      car.lengthM * Math.min(1.25, visualScale * 0.85),
                      2.75 * visualScale,
                      car.isLead,
                      car.isTail
                    ),
                  ],
                },
              });
            }
          }
        }

        const ptsSrc = map.getSource(
          "trains-points"
        ) as maplibregl.GeoJSONSource | undefined;
        if (ptsSrc) {
          ptsSrc.setData({
            type: "FeatureCollection",
            features: pointFeatures,
          });
        }

        const carsSrc = map.getSource(
          "trains-cars-3d"
        ) as maplibregl.GeoJSONSource | undefined;
        if (carsSrc) {
          carsSrc.setData({
            type: "FeatureCollection",
            features: carFeatures,
          });
        }

        // Onboard 3D Camera Tracking Mode!
        if (p.followSelectedTrain && selectedPose) {
          map.jumpTo({
            center: [selectedPose.lon, selectedPose.lat],
            bearing: selectedPose.bearingDeg,
          });
        }

        // Throttle React HUD counter/telemetry updates to ~5 Hz while WebGL runs at 60 FPS
        if (perfNow - lastStatsReportMs > 200) {
          lastStatsReportMs = perfNow;
          p.onTrainsTickStats(trains.length, selectedPose);
        }
      }

      rafId = window.requestAnimationFrame(animate);
    };

    rafId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#07090E]">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
