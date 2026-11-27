import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getRecentEmpiricalObservations,
  recordEmpiricalMeasurements,
} from "@/lib/server/db";
import type { EmpiricalMeasurementInput } from "@/types/metro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractAnonymizedVoterHash(req: NextRequest): string {
  const rawIp =
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  return crypto
    .createHash("sha256")
    .update(`mvcdmx:${rawIp}`)
    .digest("hex")
    .slice(0, 12);
}

export async function GET(req: NextRequest) {
  try {
    const isExport = req.nextUrl.searchParams.get("export") === "1";
    const data = await getRecentEmpiricalObservations(isExport ? 500 : 40);

    if (isExport) {
      return NextResponse.json(
        {
          license:
            "CC BY 4.0 — Datos Abiertos Ciudadanos MetroVivo CDMX (Sin fines de lucro)",
          exportedAt: new Date().toISOString(),
          ...data,
        },
        {
          headers: {
            "Content-Disposition":
              'attachment; filename="metrovivo-cdmx-tiempos-comunidad.json"',
          },
        }
      );
    }

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=15, s-maxage=30",
        "Netlify-CDN-Cache-Control": "public, durable, s-maxage=30",
      },
    });
  } catch (err) {
    console.error("Error in GET /api/observations:", err);
    return NextResponse.json(
      { error: "Failed to load observations" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const items: EmpiricalMeasurementInput[] = Array.isArray(body?.items)
      ? body.items
      : body?.type
      ? [body as EmpiricalMeasurementInput]
      : [];
    const adminPin =
      typeof body?.adminPin === "string" ? body.adminPin : undefined;

    if (items.length === 0) {
      return NextResponse.json(
        { error: "No valid measurement items supplied" },
        { status: 400 }
      );
    }

    const voterHash = extractAnonymizedVoterHash(req);
    const result = await recordEmpiricalMeasurements(items, adminPin, voterHash);
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error("Error in POST /api/observations:", err);
    return NextResponse.json(
      { error: "Failed to record observations" },
      { status: 500 }
    );
  }
}
