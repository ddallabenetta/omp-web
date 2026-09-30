import { NextRequest, NextResponse } from "next/server";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { getRequestIdentity } from "@/lib/request-identity";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET(req: NextRequest) {
  // Gleiche Session-Ids wie /api/sessions, also gleiche Grenze: ohne
  // Identitaet 403 statt einer leeren Liste, die wie "nichts laeuft" aussieht.
  const identity = getRequestIdentity(req.headers);
  if (!identity) {
    return NextResponse.json(
      { error: "Unknown user" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { runningSessionIds: getRunningRpcSessionIds(identity) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
