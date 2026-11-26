import { NextRequest, NextResponse } from "next/server";
import {
  getRecentEmpiricalObservations,
  recordEmpiricalMeasurements,
} from "@/lib/server/db";
import type { EmpiricalMeasurementInput } from "@/types/metro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const isExport = req.nextUrl.searchParams.get("export") === "1";
    const data = await getRecentEmpiricalObservations(isExport ? 500 : 40);

    if (isExport) {
      return NextResponse.json(
        {
          license: "CC BY 4.0 — Datos Abiertos Ciudadanos MetroVivo CDMX (Sin fines de lucro)",
          exportedAt: new Date().toISOString(),
          ...data,
        },
        {
          headers: {
            "Content-Disposition": 'attachment; filename="metrovivo-cdmx-tiempos-comunidad.json"',
          },
        }
      );
    }

    return NextResponse.json(data);
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

    const result = await recordEmpiricalMeasurements(items, adminPin);
    const feed = await getRecentEmpiricalObservations(25);
    return NextResponse.json({
      ok: true,
      ...result,
      ...feed,
    });
  } catch (err) {
    console.error("Error in POST /api/observations:", err);
    return NextResponse.json(
      { error: "Failed to record observations" },
      { status: 500 }
    );
  }
}
