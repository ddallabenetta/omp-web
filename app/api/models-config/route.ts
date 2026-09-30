import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { invalidateModelsCache } from "@/lib/models-cache";
import { invalidateOmpRuntime } from "@/lib/omp-runtime";
import { getRequestIdentity, type WebIdentity } from "@/lib/request-identity";
import { resolveTenantAgentDir } from "@/lib/tenant-config";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
export const dynamic = "force-dynamic";

/**
 * Custom provider config lives in `<agentDir>/models.yml`.
 *
 * omp reads `models.yml` first and falls back to `models.yaml`; a legacy
 * `models.json` is migrated to YAML on first load. Read whichever exists, but
 * always write back to `models.yml` so the CLI and omp-web agree on one file.
 *
 * `<agentDir>` is **pro Konto** (`lib/tenant-config.ts`), nicht mehr das
 * globale des Prozesses. Das ist hier das groesste Kostenleck der Anwendung:
 * `models.yml` traegt die API-Keys der Provider. Ein gemeinsamer Provider-Satz
 * heisst, dass Nutzer B sich Zugang zu den Credits von Nutzer A einrichtet,
 * indem er einen Provider eintragt — das ist keine Unbequemlichkeit, das ist
 * ein Zugriff auf fremdes Guthaben mit einem Klick. Der Key eines Mandanten
 * darf nicht im Verzeichnis eines anderen Mandanten liegen.
 */
const CANONICAL_FILE = "models.yml";
const READ_CANDIDATES = ["models.yml", "models.yaml", "models.json"] as const;

function getModelsPath(agentDir: string): string {
  for (const candidate of READ_CANDIDATES) {
    const path = join(agentDir, candidate);
    if (existsSync(path)) return path;
  }
  return join(agentDir, CANONICAL_FILE);
}

function getWritePath(agentDir: string): string {
  return join(agentDir, CANONICAL_FILE);
}

function readModelsConfig(agentDir: string): Record<string, unknown> {
  const path = getModelsPath(agentDir);
  if (!existsSync(path)) return { providers: {} };
  try {
    // `parse` handles JSON too — it is a subset of YAML — so a not-yet-migrated
    // `models.json` still loads.
    const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { providers: {} };
    return parsed as Record<string, unknown>;
  } catch {
    return { providers: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Drop blank model rows (empty/whitespace string ids) before persisting, but
// keep non-string ids and non-object entries so schema errors elsewhere stay
// visible to the user instead of being silently rewritten.
function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

function writeModelsConfig(agentDir: string, data: Record<string, unknown>): void {
  const path = getWritePath(agentDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, stringifyYaml(sanitizeModelsConfig(data), { lineWidth: 0 }));
}

/**
 * Die Identitaet, oder `null` — und `null` ist hier 403.
 *
 * Bewusst als eigene Funktion und nicht als Default-Parameter: ein
 * `resolveTenantAgentDir(identity = ...)`-Default waere die Mandantengrenze an
 * einer Stelle, die man beim Aufruf uebersieht. `null` heisst "niemand
 * angemeldet", und das einzige Ergebnis, das daraus folgen darf, ist Ablehnung.
 */
function requireIdentity(req: Request): WebIdentity | null {
  return getRequestIdentity(req.headers);
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return NextResponse.json(readModelsConfig(resolveTenantAgentDir(identity)));
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireIdentity(req);
  if (identity === null) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "models config must be an object" }, { status: 400 });
    }
    const config = body as Record<string, unknown>;
    if (
      "providers" in config
      && (typeof config.providers !== "object" || config.providers === null || Array.isArray(config.providers))
    ) {
      return NextResponse.json({ error: "providers must be an object" }, { status: 400 });
    }
    writeModelsConfig(resolveTenantAgentDir(identity), config);
    invalidateModelsCache();
    // The registry caches models.yml at construction; drop it so the next
    // request rebuilds against the edited providers.
    invalidateOmpRuntime();
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Unable to save models config" }, { status: 500 });
  }
}
