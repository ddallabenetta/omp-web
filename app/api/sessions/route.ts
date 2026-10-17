import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRpcSessionActivitySnapshot } from "@/lib/rpc-manager";
import { readArchivedIds } from "@/lib/session-archive";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const showArchived = new URL(req.url).searchParams.get("archived") === "1";
    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force }),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const archived = readArchivedIds();
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions)
      .filter((s) => (showArchived ? archived.has(s.id) : !archived.has(s.id)));
    return NextResponse.json(
      { sessions, ...getRpcSessionActivitySnapshot() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
