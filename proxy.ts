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
         font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 24px; }
  main { max-width: 34rem; width: 100%; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; letter-spacing: -.01em; }
  p { margin: 0 0 0.85rem; color: #a8adb4; }
  code { color: #e6e8ea; }
  a { color: #7aa2f7; }

  /* The Sign-in button is intentionally still while it sits there — it only
     animates on click, then redirects to /login. The animation is two short
     keyframe phases so a click feels like a confirmation, not a flourish. */
  .signin {
    display: block;
    width: 100%;
    height: 56px;
    margin: 1.25rem 0 0.5rem;
    padding: 0 1.25rem;
    border: 1px solid #2a313a;
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
  .signin:focus-visible { outline: 2px solid #7aa2f7; outline-offset: 2px; }
  .signin:active { transform: translateY(1px); }
  .signin.clicked { animation: signin-press 480ms ease-out forwards; }
  @keyframes signin-press {
    0%   { background: #1a1f26; border-color: #2a313a; transform: scale(1); }
    35%  { background: #2a3340; border-color: #4a5566; transform: scale(.98); }
    100% { background: #0082b3; border-color: #00b4ff; transform: scale(1); color: #ffffff; }
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
