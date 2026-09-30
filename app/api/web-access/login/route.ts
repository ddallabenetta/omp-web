import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, issueSessionCookie } from "@/lib/web-auth-session";
import { getExpectedUsername, verifyCredential } from "@/lib/web-auth";

/**
 * Exchange a web password for a session cookie.
 *
 * This is the browser door next to Basic Auth, not a replacement for it: curl,
 * the reverse proxy, and every existing client keep sending `Authorization:
 * Basic`, and `proxy.ts` still accepts that. What a cookie buys is a login page
 * instead of a native auth dialog.
 *
 * The username is optional. Omitting it means the configured single-user name,
 * which is how every existing deployment signs in and why the login page still
 * comes pre-filled. Supplying one selects an account from `omp-web-accounts.json`.
 */

export const dynamic = "force-dynamic";

/**
 * One message for every failure. Whether the password was wrong, the store was
 * missing, or the lock is off is exactly what an attacker wants to learn, and
 * none of it helps a person who mistyped their password.
 */
const REJECTED = "Sign-in failed. Check the password and try again.";

/**
 * Roughly the cost of one scrypt verification, paid on every rejected attempt
 * so that a wrong password, a missing store, and a correct one are
 * indistinguishable over the wire.
 */
const FAILURE_DELAY_MS = 150;

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

function rejected(): NextResponse {
  return NextResponse.json({ error: REJECTED }, { status: 401, headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json() as { username?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  if (typeof body.password !== "string" || body.password.length === 0) {
    await pause(FAILURE_DELAY_MS);
    return rejected();
  }

  // A browser with more than one account has to say which one it means. The
  // field is optional: a client that omits it gets the configured single-user
  // name, which is how every existing deployment has always signed in.
  const requested = typeof body.username === "string" ? body.username.trim() : "";
  const username = requested.length > 0 ? requested : getExpectedUsername();

  const identity = verifyCredential(username, body.password);
  if (identity === null) {
    await pause(FAILURE_DELAY_MS);
    return rejected();
  }

  // The name goes into the signed cookie, so `proxy.ts` can rebuild the identity
  // on the next request without asking the store again.
  const session = issueSessionCookie({ username: identity.username });
  if (session === null) {
    await pause(FAILURE_DELAY_MS);
    return rejected();
  }

  const response = NextResponse.json({ ok: true, user: identity }, { headers: NO_STORE });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: session,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    // omp-web is served over plain HTTP on :8788, and a `secure` cookie would be
    // dropped by the browser on every request. Set this to `true` once the
    // server sits behind TLS termination. Never `domain`-scoped: a host-only
    // cookie cannot be widened by a hostile parent domain.
    secure: false,
  });
  return response;
}

/** Sign out: clear the cookie. The Basic Auth path cannot be signed out of. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
    secure: false,
  });
  return response;
}
