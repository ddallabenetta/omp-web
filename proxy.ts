import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import { authorizeWebRequest } from "@/lib/web-auth";
import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/web-auth-session";

/**
 * The surfaces that answer without credentials.
 *
 * `proxy.ts` hands a locked-out browser to `/login`, and the recovery page is
 * what that page links to — so both, and the API that backs them, have to be
 * reachable or the redirect would loop. Neither can let anyone in on its own:
 * `/recover` mints a code it prints on the server's own console, and the login
 * API answers with a session cookie only for a correct password.
 */
const RECOVERY_PAGE = "/recover";
const RECOVERY_API = "/api/web-access/recovery";
const LOGIN_PAGE = "/login";
const LOGIN_API = "/api/web-access/login";

const AUTHENTICATE_HEADERS = {
  "Cache-Control": "no-store",
  "WWW-Authenticate": 'Basic realm="omp-web", charset="UTF-8"',
};

function unauthorizedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omp-web · authentication required</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #14161a; color: #e6e8ea;
         font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  p { margin: 0 0 0.85rem; color: #a8adb4; }
  code { color: #e6e8ea; }
  a { color: #7aa2f7; }
</style>
</head>
<body>
<main>
  <h1>Authentication required</h1>
  <p>omp-web is locked. Reload the page and sign in with the username <code>omp</code> and your password.</p>
  <p>Forgot it? <a href="${RECOVERY_PAGE}">Recover access</a> — you will need to read a one-time code off the console
     of the machine running omp-web.</p>
</main>
</body>
</html>
`;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // Recovery and login stay reachable while locked out — they are the way out —
  // but only after the host and cross-site checks above have run.
  if (
    pathname === RECOVERY_PAGE || pathname === RECOVERY_API
    || pathname === LOGIN_PAGE || pathname === LOGIN_API
  ) {
    return NextResponse.next();
  }

  // Basic Auth still stands: curl, the reverse proxy, and existing clients all
  // send it. A session cookie is the browser's second door, signed by the same
  // credential — so changing the password kills both at once.
  const decision = authorizeWebRequest(request.headers.get("authorization"));
  if (decision === "unauthorized" && verifySessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  if (decision === "unavailable") {
    const message = "Password access is enabled but the omp-web credential file could not be read."
      + " Run `omp-web --reset-password` on the server to set a new password.";
    return isApiRequest
      ? NextResponse.json({ error: message }, { status: 503, headers: { "Cache-Control": "no-store" } })
      : new NextResponse(message, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  if (decision === "unauthorized") {
    if (isApiRequest) {
      return NextResponse.json(
        { error: "Authentication required", recoveryPath: RECOVERY_PAGE, loginPath: LOGIN_PAGE },
        { status: 401, headers: AUTHENTICATE_HEADERS },
      );
    }

    // A browser navigation gets the login page instead of a 401 with a
    // `WWW-Authenticate`, because that header is what raises the native Basic
    // dialog — and a page whose only action is "reload" is a worse way in than
    // a form. A `fetch`/XHR is not a navigation, so it keeps the 401 JSON.
    if (isBrowserNavigation(request)) {
      return NextResponse.redirect(new URL(LOGIN_PAGE, request.url), { status: 302 });
    }

    return new NextResponse(unauthorizedPage(), {
      status: 401,
      headers: { ...AUTHENTICATE_HEADERS, "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return NextResponse.next();
}

/**
 * Whether this is a person typing a URL, as opposed to script asking for data.
 * Only a real navigation can be handed the login page; a client call has to
 * stay on the 401 so its caller can react to it.
 */
function isBrowserNavigation(request: NextRequest): boolean {
  if (request.headers.get("x-requested-with")) return false;
  if (request.headers.has("sec-fetch-mode")) {
    return request.headers.get("sec-fetch-mode") === "navigate";
  }
  // No fetch metadata: a plain navigation from an address bar, a link, or a
  // form post. Browsers always send `Sec-Fetch-Mode`; this is curl.
  return true;
}

export const config = { matcher: ["/", "/login", "/recover", "/api/:path*"] };
