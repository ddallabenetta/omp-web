import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import { isAdminUsername, authorizeWebRequest, type WebIdentity } from "@/lib/web-auth";
import { REQUEST_ADMIN_HEADER, REQUEST_USER_HEADER } from "@/lib/request-identity";
import { SESSION_COOKIE_NAME, readSessionCookie } from "@/lib/web-auth-session";

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
         font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 24px; }
  main { max-width: 34rem; width: 100%; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; letter-spacing: -.01em; }
  p { margin: 0 0 0.85rem; color: #a8adb4; }
  code { color: #e6e8ea; }
  a { color: #7aa2f7; }

  /* The Sign-in button is intentionally still while it sits there — it only
     animates on click, then redirects to /login. The animation is two short
     keyframe phases so a click feels like a confirmation, not a flourish.
     Colour follows the theme: useTheme.applyOmpPalette rewrites every token
     from /api/theme at runtime, so the accent is whatever palette the operator
     picked, not the values baked into globals.css. The page is inline HTML
     served by the proxy, so it declares the same accent the login page uses
     and picks up the same runtime override through the token. */
  .signin {
    display: block;
    width: 100%;
    height: 56px;
    margin: 1.25rem 0 0.5rem;
    padding: 0 1.25rem;
    border: 1px solid var(--border, #2a313a);
    border-radius: 12px;
    background: #1a1f26;
    color: #e6e8ea;
    font: 700 14px/56px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: .04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
  }
  .signin:hover { background: #232a33; border-color: #3a4250; }
  .signin:focus-visible { outline: 2px solid var(--accent, #7aa2f7); outline-offset: 2px; }
  .signin:active { transform: translateY(1px); }
  .signin.clicked { animation: signin-press 480ms ease-out forwards; }
  @keyframes signin-press {
    0%   { background: #1a1f26; border-color: #2a313a; transform: scale(1); }
    35%  { background: color-mix(in srgb, var(--accent, #7aa2f7) 22%, #1a1f26); border-color: var(--accent, #7aa2f7); transform: scale(.98); }
    100% { background: var(--accent, #7aa2f7); border-color: var(--accent-hover, #7aa2f7); transform: scale(1); color: #ffffff; }
  }
  @media (prefers-reduced-motion: reduce) {
    .signin.clicked { animation-duration: 1ms; }
  }
</style>
</head>
<body>
<main>
  <h1>Authentication required</h1>
  <p>omp-web is locked. Sign in with your username and password.</p>
  <p>Forgot it? <a href="${RECOVERY_PAGE}">Recover access</a> — you will need to read a one-time code off the console
     of the machine running omp-web.</p>
  <button type="button" class="signin" id="omp-signin">Sign in</button>
</main>
<script>
  // The button animates first, then navigates. A 480ms delay lines up with
  // the keyframe end so the press feels intentional rather than a flicker.
  var btn = document.getElementById("omp-signin");
  btn.addEventListener("click", function () {
    btn.classList.add("clicked");
    btn.disabled = true;
    window.setTimeout(function () { window.location.replace(${JSON.stringify(LOGIN_PAGE)}); }, 460);
  });
</script>
</body>
</html>
`;
}

/**
 * Haenge die Identitaet an den Request an, damit die Route sie lesen kann.
 *
 * `request.headers.delete` zuerst ist nicht Kosmetik. Ein Request-Header ist
 * etwas, das jeder Client mitschickt — ohne das Loeschen koennte jeder Aufrufer
 * `x-omp-admin: 1` setzen und waere Admin. Der Proxy ist die einzige Stelle, an
 * der die Identitaet entsteht, also ist er auch die einzige, die den mitgelieferten
 * Wert entfernen darf.
 *
 * Der Weg geht ueber `NextResponse.next({ request: { headers } })`, weil ein
 * Header auf der `NextResponse` selbst nur in die Antwort zum Client ginge und
 * niemals im Handler ankommt. Ein duennes `return new NextResponse(...)` waere
 * die bequemere Form und waere falsch.
 */
/**
 * The identity headers, rewritten from what the request actually proved.
 *
 * `identity` is `null` for an anonymous request, and that case has to run
 * through here as well. Deleting the incoming headers is the only thing that
 * makes them trustworthy, and a delete that a branch never reaches is not a
 * protection but dead code: on an unlocked server (`policy.mode === "open"`,
 * no credential file) every request answers `allow` with `identity === null`,
 * so guarding this call on `identity !== null` let `x-omp-admin: 1` from the
 * client through untouched and handed out `/etc`.
 *
 * So the delete is unconditional and only the set is conditional. Measured
 * before the fix: `curl -H 'x-omp-user: root' -H 'x-omp-admin: 1'
 * .../api/files/etc?type=list` returned 200 and listed `/etc`.
 */
function withIdentity(request: NextRequest, identity: WebIdentity | null): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete(REQUEST_USER_HEADER);
  headers.delete(REQUEST_ADMIN_HEADER);
  if (identity !== null) {
    headers.set(REQUEST_USER_HEADER, identity.username);
    if (identity.isAdmin) headers.set(REQUEST_ADMIN_HEADER, "1");
  }
  return NextResponse.next({ request: { headers } });
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
  // but only after the host and cross-site checks above have run. They go
  // through `withIdentity` too, with a null identity: no header is set, and
  // whatever the client sent under those names is gone. Neither route reads
  // them today, but a rule with an exception grows a second exception at the
  // next refactor, and this one is the line that would be copied.
  if (
    pathname === RECOVERY_PAGE || pathname === RECOVERY_API
    || pathname === LOGIN_PAGE || pathname === LOGIN_API
  ) {
    return withIdentity(request, null);
  }

  // Basic Auth still stands: curl, the reverse proxy, and existing clients all
  // send it. A session cookie is the browser's second door, signed by the same
  // credential — so changing the password kills both at once.
  const { decision, identity: basicIdentity } = authorizeWebRequest(request.headers.get("authorization"));

  // The session cookie is the second door, and it is also where the identity
  // usually comes from: a browser never sends `Authorization`, only the cookie.
  //
  // It is read whenever Basic Auth did *not* already identify someone — not
  // only when the request was rejected. An unlocked server with accounts on it
  // answers `allow` to everyone, and a signed-in browser there still has to be
  // told who it is; otherwise the first account created through the admin panel
  // would sign in to a session nobody downstream can attribute.
  let identity = basicIdentity;
  if (identity === null) {
    const sessionUser = readSessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value);
    if (sessionUser !== null) identity = { username: sessionUser, isAdmin: isAdminUsername(sessionUser) };
  }

  // Every path that lets a request through goes out through `withIdentity`,
  // including the anonymous one. The early return below is only for the
  // identified case, where the headers get rewritten to the proven values.
  if (identity !== null) {
    return withIdentity(request, identity);
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

  // Unlocked server, no credentials on the request: the request is allowed, and
  // `identity` is null. It still has to pass through `withIdentity`, otherwise
  // a client-supplied `x-omp-admin: 1` survives into the route. No header is
  // set, so downstream sees no identity and answers 403 — which is the same
  // answer an anonymous request gets, and the one its own guards already gave.
  return withIdentity(request, null);
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
