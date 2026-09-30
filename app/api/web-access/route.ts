import { NextResponse } from "next/server";
import {
  clearWebPassword,
  getWebAuthStatus,
  setWebPassword,
  setWebPasswordEnabled,
  setWebUsername,
  validatePassword,
} from "@/bin/web-auth-store.js";
import { hasJsonContentType } from "@/lib/request-security";
import type { WebAccessStatus } from "@/lib/api-types";

/**
 * The password lock, as the settings panel drives it.
 *
 * Every request here has already passed `proxy.ts` — the host allow-list, the
 * cross-site rejection, and (once the lock is on) Basic Auth — so the route
 * itself only has to police the payload. Recovery is deliberately *not* here:
 * it is the one endpoint that answers without credentials, and it lives in
 * `./recovery`.
 */

export const dynamic = "force-dynamic";

type WebAccessAction = "set-password" | "set-username" | "enable" | "disable" | "clear";

const ACTIONS = new Set<WebAccessAction>(["set-password", "set-username", "enable", "disable", "clear"]);

function statusResponse(status: WebAccessStatus) {
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  return statusResponse(getWebAuthStatus());
}

export async function PUT(req: Request) {
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  let body: { action?: unknown; password?: unknown; username?: unknown };
  try {
    body = await req.json() as { action?: unknown; password?: unknown; username?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const action = body.action;
  if (typeof action !== "string" || !ACTIONS.has(action as WebAccessAction)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  // `OMP_WEB_PASSWORD` overrides the stored credential, so editing the store
  // while it is set would change nothing a user could observe. The same guard
  // covers `set-username`: an environment-managed lock owns the entire
  // credential pair, not just the password half.
  if (getWebAuthStatus().managedByEnvironment) {
    return NextResponse.json(
      { error: "Password access is managed by the OMP_WEB_PASSWORD environment variable. Unset it to manage the password here." },
      { status: 409 },
    );
  }

  try {
    switch (action as WebAccessAction) {
      case "set-password": {
        const invalid = validatePassword(body.password);
        if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
        // Carry `username` in the same atomic write so the panel can keep the
        // stored username in sync with the freshly-validated one. Omitting it
        // leaves any previously-stored username alone.
        //
        // The narrowing is deliberate: `body` is `unknown` all the way from
        // `req.json()`, and the store option is `string | undefined`. A
        // non-string is dropped rather than forwarded — `setWebPassword` treats
        // `undefined` as "keep what is stored", so a client that sends a number
        // gets the existing username back instead of a stored `"42"`.
        const username = typeof body.username === "string" ? body.username : undefined;
        return statusResponse(setWebPassword(body.password, { username }));
      }
      case "set-username":
        // `setWebUsername` throws on validation failure with a useful message,
        // and the catch below turns it into a 400.
        return statusResponse(setWebUsername(body.username));
      case "enable":
        return statusResponse(setWebPasswordEnabled(true));
      case "disable":
        return statusResponse(setWebPasswordEnabled(false));
      case "clear":
        return statusResponse(clearWebPassword());
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
