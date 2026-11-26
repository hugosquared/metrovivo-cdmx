import { NextRequest, NextResponse } from "next/server";
import { buildLiveSystemSnapshot } from "@/lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const atParam = req.nextUrl.searchParams.get("at");
    const refreshParam = req.nextUrl.searchParams.get("refresh") === "1";
    const refMs = atParam ? Number(atParam) : undefined;

    const snapshot = await buildLiveSystemSnapshot(
      refMs && Number.isFinite(refMs) ? refMs : undefined,
      refreshParam
    );

    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (err) {
    console.error("Error in /api/live:", err);
    return NextResponse.json(
      { error: "Failed to build live Metro CDMX snapshot" },
      { status: 500 }
    );
  }
}
