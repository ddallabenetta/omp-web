import {
  discoverAuthStorage,
  getAgentDir,
  ModelRegistry,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ensureTenantAgentDir } from "./tenant-config";
import type { WebIdentity } from "./request-identity";

/**
 * Process-wide omp services.
 *
 * The `omp` CLI builds `Settings` + `AuthStorage` + `ModelRegistry` once per
 * process and hands them to every session. omp-web serves many requests from
 * one process, so it builds them once too and re-scopes `Settings` per project
 * instead of re-opening SQLite for every route.
 *
 * Stored on `globalThis` so Next.js hot-reload does not leak a second SQLite
 * handle onto `~/.omp/agent/agent.db`.
 */

declare global {
  var __ompRuntimePromise: Promise<OmpRuntime> | undefined;
}

export interface OmpRuntime {
  agentDir: string;
  settings: Settings;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

async function createRuntime(): Promise<OmpRuntime> {
  const agentDir = getAgentDir();
  const settings = await Settings.init({ agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  // Pinning the registry to this exact AuthStorage keeps credential_disabled
  // events flowing to the same instance the routes read from.
  const modelRegistry = new ModelRegistry(authStorage);
  await modelRegistry.refresh("online-if-uncached");
  return { agentDir, settings, authStorage, modelRegistry };
}

export function getOmpRuntime(): Promise<OmpRuntime> {
  globalThis.__ompRuntimePromise ??= createRuntime().catch((error) => {
    globalThis.__ompRuntimePromise = undefined;
    throw error;
  });
  return globalThis.__ompRuntimePromise;
}

/**
 * Settings einer *bestimmten* Identitaet, ohne sie zu aendern.
 *
 * `Settings.init()` ist ein Prozess-Singleton: der erste Aufrufer gewinnt, alle
 * spaeteren bekommen dieselbe Instanz zurueck. Eine Mandanten-Installation
 * braucht pro Konto eine eigene `config.yml`, also pro Konto eine eigene
 * Instanz — und `Settings.init()` kann das nicht liefern.
 *
 * `Settings.loadIsolated()` ist genau die Fabrik dafuer: sie beruehrt das
 * globale Singleton nicht, nimmt aber einen `agentDir` und persistiert in
 * dessen `config.yml`. Der Admin laeuft weiter ueber das Singleton, weil sein
 * Verzeichnis das Prozess-Verzeichnis ist und dort die Werkzeuge und
 * `rpc-manager.ts` ihre Instanz erwarten.
 *
 * Der Cache haengt an der `globalThis`, aber **pro `agentDir`**, nicht pro
 * Prozess: das ist derselbe Unterschied wie in `lib/write-access.ts`. Eine
 * gemeinsame Instanz hiesse, dass Alice' `config.yml` in Bobs Requests gelesen
 * wird — und beim Schreiben in ihre Datei.
 */
declare global {
  var __ompTenantSettings: Map<string, Promise<Settings>> | undefined;
}

function tenantSettingsCache(): Map<string, Promise<Settings>> {
  globalThis.__ompTenantSettings ??= new Map();
  return globalThis.__ompTenantSettings;
}

/**
 * The `Settings` instance for `identity`, scoped to `cwd` when one is given.
 *
 * For an admin this is the shared process instance. For a tenant it is an
 * isolated instance over the tenant's own agent directory, which is what makes
 * `settings.set()` + `flush()` land in *their* `config.yml`.
 *
 * `null` returns the process instance's `Settings` **without** any identity
 * claim: callers that serve a request must establish the identity first (see
 * `lib/request-identity.ts`) and pass it. Accepting `null` keeps this function
 * callable from the read-only routes that already resolve an identity; it does
 * not widen access, because a `null` here yields the same global view the
 * caller had before the split.
 */
export async function getSettingsForIdentity(
  identity: WebIdentity | null,
  cwd: string | undefined,
): Promise<Settings> {
  const { settings, agentDir } = await getOmpRuntime();
  if (identity === null || identity.isAdmin) {
    if (!cwd || settings.getCwd() === cwd) return settings;
    return settings.cloneForCwd(cwd);
  }

  const tenantDir = ensureTenantAgentDir(identity);
  if (tenantDir === agentDir) {
    if (!cwd || settings.getCwd() === cwd) return settings;
    return settings.cloneForCwd(cwd);
  }

  const cache = tenantSettingsCache();
  const key = tenantDir;
  let instance = cache.get(key);
  if (!instance) {
    instance = Settings.loadIsolated({ agentDir: tenantDir });
    cache.set(key, instance);
    // A failed load must not be cached: the next request should retry rather
    // than replay a permanent failure for the life of the process.
    instance.catch(() => {
      if (cache.get(key) === instance) cache.delete(key);
    });
  }
  const base = await instance;
  if (!cwd || base.getCwd() === cwd) return base;
  return base.cloneForCwd(cwd);
}

/**
 * Settings scoped to `cwd`, so project-level `.omp/config.yml` overrides apply.
 *
 * Returns the shared instance when `cwd` is already the active scope; omp's
 * `cloneForCwd` reloads only the project layer, leaving global settings and
 * runtime overrides intact.
 */
export async function getSettingsForCwd(cwd: string | undefined): Promise<Settings> {
  const { settings } = await getOmpRuntime();
  if (!cwd || settings.getCwd() === cwd) return settings;
  return settings.cloneForCwd(cwd);
}

/** Drop the cached runtime so the next request rebuilds it (config/auth edits). */
export function invalidateOmpRuntime(): void {
  globalThis.__ompRuntimePromise = undefined;
}
