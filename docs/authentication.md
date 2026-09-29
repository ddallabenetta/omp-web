# Password access

omp-web drives a coding agent that reads and writes files, runs shell commands,
and spends provider credits. Anything that can reach the port can do all of
that. On loopback that is exactly the intent; the moment omp-web listens on a
LAN address or sits behind a tunnel, it needs a lock.

The lock covers every page and every API route. Two credentials are checked:
a username, defaulting to `omp`, and the password, which is the only secret
that has to be unpredictable. The browser shows a sign-in form; API clients
send HTTP Basic Auth. Both are accepted on the same routes.

## Turning it on

Three ways in, in the order most people reach for them:

**From the browser.** Settings → **Access**. Set a password, and password access
turns on with it. The same panel switches the lock off without forgetting the
password, and removes the password entirely.

**From the command line.**

```bash
omp-web --authenticated
```

Turns password access on for this run and for every later one. If no password
has ever been set, omp-web asks for one on the terminal before the server
starts, so a run that was told to be locked can never come up unlocked. If a
password is already stored, the flag just switches the lock back on.

`OMP_WEB_AUTHENTICATED=1` does the same thing from the environment.

Non-interactive launches — systemd, Docker, `omp-web &` — cannot answer a
prompt, so `--authenticated` fails there with a message instead of hanging. Set
the password once interactively, or use the environment variable below.

**From the environment.**

```bash
OMP_WEB_PASSWORD='[REDACTED:Env Secret Field]' omp-web
```

The variable overrides the stored credential completely: while it is set, the
settings panel is read-only and recovery has nothing to reset. Leaving it unset
or empty hands control back to the stored credential.

## The username

The username is not a secret, but it is part of the credential and is checked
as strictly as the password. It resolves in this order:

1. the `username` field in `omp-web-auth.json`, if the file has a non-empty one;
2. `OMP_WEB_USERNAME` from the environment, trimmed;
3. the built-in default `omp`.

Note the direction: the stored value wins over the environment. `OMP_WEB_PASSWORD`
overrides the stored credential, but `OMP_WEB_USERNAME` only fills in for a file
that has no username recorded — so setting the variable on a server that was
already configured through Settings will not rename it.

Settings → **Access** writes the field, so a server moved behind a reverse
proxy can be renamed without touching the environment. Because the session
cookie is signed over the username as well as the password, renaming the
account logs everyone out — which is the correct outcome, not a side effect to
work around.

Keep the username in mind when scripting: Basic Auth clients must send the
configured name, not a hard-coded `omp`.

## How the password is stored

In `<agentDir>/omp-web-auth.json` — normally `~/.omp/agent/omp-web-auth.json` —
created with mode `0600` and replaced atomically. The file holds a `scrypt`
digest, the random salt that produced it, and the cost parameters. **The
password itself is never written anywhere.**

That is the whole reason recovery exists rather than a "show password" button:
nothing on the machine can turn the file back into the password.

`OMP_WEB_AUTH_FILE` overrides the location. Set it if you have migrated omp's
state to XDG directories, or if you want the credential somewhere else entirely;
`bin/omp-web.js` resolves the path once and passes it to the server, so the two
halves can never disagree.

Verification is timing-safe. Because `proxy.ts` checks credentials on every
request and scrypt is deliberately slow, successful verifications are cached in
memory for five minutes, keyed by the digest that accepted them — changing or
clearing the password invalidates the cache immediately.

If the credential file exists but cannot be parsed while the lock is on, omp-web
answers `503` to everything rather than assuming it should unlock. Use
`--reset-password` to get out of that state.

## Recovering a forgotten password

Both paths prove access to the machine running the server. Neither can hand the
old password back.

**From a shell on that machine:**

```bash
omp-web --reset-password
```

Asks for a new password, stores it, and starts the server.

**From a browser**, when you have a terminal but not a shell prompt on the
server — a tmux pane, a service log, a Docker `logs` stream:

1. Open `/recover`. The page is reachable without credentials; it is the only
   thing that is.
2. Ask for a recovery code. omp-web prints it **on its own console** — the
   terminal running the server — and never returns it over HTTP.
3. Type the code and a new password into the page.

Recovery codes carry 60 bits of entropy, expire after 10 minutes, allow five
wrong attempts before being discarded, are single-use, and are themselves stored
only as a digest. A new code can be minted at most once every 30 seconds.

This means an unauthenticated caller who finds `/recover` on a scan can make the
server print codes on a console they cannot see. That is the entire extent of
what they gain.

## What this does not protect

Basic Auth authenticates; it does not encrypt. The password crosses the network
in a reversible encoding, so on plain HTTP over an untrusted path it can be read
in transit — and a password read in transit is a password lost.

Put omp-web behind HTTPS through a trusted reverse proxy, or inside a trusted
VPN, before exposing it beyond loopback. The password stops a port scanner. It
does not stop someone reading the wire.

Separately from the password, API requests are accepted only for loopback names,
IP literals, the bind hostname, and the names listed in
`OMP_WEB_ALLOWED_HOSTS` (exact names, or wildcard patterns like
`*.example.com`); cross-site browser requests are rejected outright. Those
checks run before authentication and apply to `/recover` too.

## Sessions and what ends them

A successful sign-in sets an `omp_session` cookie instead of asking for the
credential on every request. The cookie is signed over the username, the
password, and a random salt generated at server start. That binds it to both
halves of the credential *and* to the running process, so a session ends when:

- the password changes, or the username changes;
- the server restarts, because the boot salt is new;
- the TTL of 8 hours expires, or the cookie is dropped.

A restart is therefore a logout. During a redeploy every open tab has to sign in
again — that is the intended trade for a cookie that cannot outlive the process
that minted it. There is no session list and no manual revocation: the shortest
lifetime is a restart.

Two details worth knowing when reading a bug report: the secret is derived per
mode, so switching between the environment variable and the stored file
invalidates cookies even if the password is identical, and a server with no
password configured has no session to issue at all.
