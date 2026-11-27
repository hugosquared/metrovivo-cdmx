import { NextRequest, NextResponse } from "next/server";
import { buildLiveSystemSnapshot } from "@/lib/server/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const atParam = req.nextUrl.searchParams.get("at");
    const refreshParam = req.nextUrl.searchParams.get("refresh") === "1";
    const refMs = atParam ? Number(atParam) : undefined;
    const isCustomScrub = Boolean(refMs && Number.isFinite(refMs));

    const snapshot = await buildLiveSystemSnapshot(
      isCustomScrub ? refMs : undefined,
      refreshParam
    );

    // Edge-cache default live snapshot for 75s on Netlify CDN so thousands of concurrent visitors cost ~0 serverless credits!
    const cacheHeaders: Record<string, string> =
      isCustomScrub || refreshParam
        ? { "Cache-Control": "private, no-store, max-age=0" }
        : {
            "Cache-Control": "public, max-age=20, s-maxage=75, stale-while-revalidate=180",
            "Netlify-CDN-Cache-Control":
              "public, durable, s-maxage=75, stale-while-revalidate=180",
          };

    return NextResponse.json(snapshot, { headers: cacheHeaders });
  } catch (err) {
    console.error("Error in /api/live:", err);
    return NextResponse.json(
      { error: "Failed to build live Metro CDMX snapshot" },
      { status: 500 }
    );
  }
}
