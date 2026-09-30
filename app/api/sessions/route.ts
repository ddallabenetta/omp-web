import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { readArchivedIds } from "@/lib/session-archive";
import { getRequestIdentity } from "@/lib/request-identity";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    // Diese Route nannte bis eben ungefiltert JEDE Session des Prozesses und
    // hatte nicht einmal `isApiRequestAllowed`. Beides gehoert hier behoben:
    // eine Session-Id aus dieser Liste adressiert prompt, Kontext, Export und
    // DELETE — sie ist ein Schluessel, kein Anzeigename.
    const identity = getRequestIdentity(req.headers);
    if (!identity) {
      return NextResponse.json(
        { error: "Unknown user" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    const force = new URL(req.url).searchParams.get("force") === "1";
    const showArchived = new URL(req.url).searchParams.get("archived") === "1";
    const [persistedSessions, runtimeSessions] = await Promise.all([
      // Beide Quellen filtern auf dieselbe Identitaet. Nur die Platte zu
      // filtern waere nutzlos: eine laufende Session taucht genau dann auf,
      // wenn ihre Datei noch fehlt.
      listAllSessions({ force, identity }),
      attachSessionProjectInfo(getRpcSessionInfos(identity)),
    ]);
    const archived = readArchivedIds();
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions)
      .filter((s) => (showArchived ? archived.has(s.id) : !archived.has(s.id)));
    return NextResponse.json(
      { sessions, runningSessionIds: getRunningRpcSessionIds(identity) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
