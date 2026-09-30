import { NextResponse } from "next/server";
import { realpathSync, statSync } from "fs";
import { isPathInUserHome } from "@/lib/path-security";
import { normalizeDirectory } from "@/lib/directory-browser";
import { allowFileRoot } from "@/lib/allowed-roots";
import { getRequestIdentity, isAdminIdentity } from "@/lib/request-identity";


// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    // Ohne Header ist niemand angemeldet — 403, nicht Admin, nicht "/".
    const identity = getRequestIdentity(req.headers);
    if (!identity) {
      return NextResponse.json({ error: "Unknown user" }, { status: 403 });
    }

    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const normalizedCwd = normalizeDirectory(cwd);
    let canonicalCwd: string;
    try {
      const stat = statSync(normalizedCwd);
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
      }
      canonicalCwd = realpathSync(normalizedCwd);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (isAdminIdentity(identity)) {
      // Nur der Admin verweitert die globale Menge — das bleibt eine bewusste,
      // lebenslange Freigabe durch einen Betreiber, kein Nebeneffekt einer
      // Nutzeranfrage.
      allowFileRoot(canonicalCwd);
      return NextResponse.json({ success: true, cwd: canonicalCwd });
    }

    // Fuer jeden anderen ist die eigene Home die Grenze, und die Pruefung hat
    // keinen Seiteneffekt.
    //
    // allowFileRoot() waere hier der gefaehrlichste Hebel im ganzen Bestand: die
    // Funktion mutiert eine prozess-globale Menge auf globalThis, aus der Read-
    // UND Write-Roots gelesen werden. Ein Prozess bedient alle Bediener, also
    // wuerde ein Nutzer die Menge fuer alle anderen mitvergroessern — und
    // `/etc` waere ab da fuer die gesamte Lebensdauer des Prozesses erlaubt,
    // nicht nur fuer die eine Anfrage. Ersatz: reine Pruefung, nichts wird
    // gemerkt. Sie loest auf beiden Seiten auf, ein `~/link -> /etc` passt also
    // nicht, nur weil der Link in der Home liegt.
    if (!isPathInUserHome(identity, canonicalCwd)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json({ success: true, cwd: canonicalCwd });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
