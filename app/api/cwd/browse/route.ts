import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getRequestIdentity } from "@/lib/request-identity";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
export async function GET(request: NextRequest) {
  try {
    // Keine Identitaet, kein Verzeichnislisting. Ohne Header liefert
    // getAllowedFileRoots(identity) eine leere Menge, die Antwort waere dann ein
    // leerer Browser — eine 403 sagt dem Aufrufer, dass es hier nicht weitergeht.
    const identity = getRequestIdentity(request.headers);
    if (!identity) {
      return NextResponse.json({ error: "Unknown user" }, { status: 403 });
    }

    const requested = request.nextUrl.searchParams.get("path")?.trim();

    if (shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({
        path: "",
        parentPath: null,
        drives: identity.isAdmin ? await listWindowsDrives() : [],
        directories: [],
      });
    }

    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    // Der Verzeichniszugang geht ueber dieselbe Root-Menge wie der Dateizugriff.
    // Ohne diese Pruefung war der cwd-Browser ein unbeschraenkter Verzeichnis-
    // leser: `getBrowseStartDirectory` faellt auf homedir() zurueck und
    // resolveDirectory() loest alles auf, was der Prozess lesen kann.
    const allowedRoots = await getAllowedFileRoots(identity);
    if (!isExistingFilePathAllowed(resolved, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const directories = await listDirectories(resolved);

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
