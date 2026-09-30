import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { join } from "path";
import { isPathWithinRoots } from "@/lib/path-security";
import { allowFileRoot } from "@/lib/allowed-roots";
import { getRequestIdentity, getUserHome, isAdminIdentity } from "@/lib/request-identity";

// POST /api/default-cwd
// Creates ~/omp-cwd-<YYYYMMDD> if it doesn't exist and returns the path.
export async function POST(req: Request) {
  try {
    // Ohne Header ist niemand angemeldet — 403, nicht Admin, nicht "/".
    const identity = getRequestIdentity(req.headers);
    if (!identity) {
      return NextResponse.json({ error: "Unknown user" }, { status: 403 });
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    // Die Home des angemeldeten Nutzers, nicht homedir() des Prozessbenutzers.
    // Sonst legte jeder Bediener sein Verzeichnis unter /home/pi an.
    const home = getUserHome(identity);
    const dir = join(home, `omp-cwd-${date}`);

    // Die Grenze wird VOR dem mkdir geprueft. Umgekehrt erzeugt der alte
    // Ablauf ein Verzeichnis und fragt erst danach: jeder, der diese Route
    // erreicht, hat dann schon ein `omp-cwd-*` in fremder Home angelegt.
    //
    // Die Pruefung ist lexikalisch, und das ist hier richtig. `isPathInUserHome`
    // loest mit `realpathSync` auf und kann nur bestehen, wenn die Home bereits
    // existiert. Eine Home existiert aber nicht fuer jedes Konto: sie wird in
    // `normalizeAccountEntry` (bin/web-auth-store.js) rein rechnerisch gesetzt,
    // und nur `createWebAccount` legt das Verzeichnis an. Jeder Datensatz, der
    // von Hand, aus einer Migration oder aus einem Backup stammt, kann sich
    // einloggen, ohne dass sein Home je existiert hat — fuer genau diese
    // Konten waere die aufloesende Variante ein 403 beim ersten `omp-cwd`, und
    // dieser Aufruf ist der allererste, den die Oberflaeche stellt. Der
    // Lexikalisierungs-Rueckfall in `isPathInUserHome` deckt den Fall inzwischen
    // ab; hier ist er trotzdem die richtige Wahl, weil der Zielpfad ein Kind der
    // gerade erst zu erzeugenden Home ist und es hier um `join()` geht, nicht um
    // einen Symlink-Ausbruch. Die eigentliche Grenze ist `getUserHome(identity)`
    // statt `homedir()`; diese Zeile ist die zweite Schicht darueber.
    if (!isPathWithinRoots(dir, new Set([home]))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    mkdirSync(dir, { recursive: true });

    if (isAdminIdentity(identity)) {
      // Ohne Identitaet: das ist eine Betreiberfreigabe, kein Nutzerwunsch,
      // und der unclaimed Bucket ist genau dafuer da — sichtbar nur fuer Admins.
      allowFileRoot(dir);
    }
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
