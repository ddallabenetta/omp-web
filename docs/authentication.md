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

One consequence is worth stating plainly, because the failure is quiet: while
`OMP_WEB_PASSWORD` is set, **there is exactly one account** — the username
resolved below. Any other name is not a second user with a wrong password, it
is not an account at all, and it is refused the same way a wrong password is.
Measured against `authorizeWebRequest`: `omp` with the right password yields
`{decision: "allow", identity: {username: "omp", isAdmin: true}}`, while `pi`
and `bob` with that same password both yield `{decision: "unauthorized",
identity: null}`.

So `OMP_WEB_PASSWORD` is a single-credential door, not a multi-user
configuration. Several accounts require the accounts file instead.

### Where account homes live

Creating an account makes a directory for it, and that directory is the
boundary everything else in this document is measured against: the file
allow-list, session ownership, and the per-account `models.yml` all derive
from it. Its parent is `OMP_WEB_HOME_ROOT`, defaulting to `/home`.

The default is wrong for a service that does not run as root. Creating an
account calls `mkdirSync(home, { mode: 0o700 })` with no permission check and
no fallback, so an unprivileged service account cannot create accounts at all
and the API returns the raw system error — `EACCES: permission denied, mkdir
'/home/pi/newuser'` — with the server's own absolute path in it. Two ways out,
and they answer different questions:

```bash
# 1. Give the service a parent it can write. No code change.
OMP_WEB_HOME_ROOT=/home/pi/accounts

# 2. Or grant the service account write access to /home, which is a much
#    larger grant than account creation needs.
```

Check the service account before assuming either: `systemctl show omp-web.service
-p User`, then `sudo -u pi mkdir -p <root>/probe`. The UI shows the configured
root, so `/home` appearing in Settings means the variable is not set.

Setting this changes where homes are looked for, not where they already are.
An existing account keeps the home its own session files name, so the two must
be decided together rather than one after the other.

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

And once several accounts exist, the terminal is the one boundary that is
enforced by the kernel rather than by a check in this code. The shell for an
account runs inside a [`bubblewrap`](https://github.com/containers/bubblewrap)
user namespace: it binds exactly one directory — that account's own home, at
`/home/<name>` — and nothing else. Another account's home is not mounted and
therefore does not exist inside; `cat /home/<someone-else>/secret` answers `No
such file or directory`, not `Permission denied`, because there is nothing
behind that path to open. `/etc/shadow` stays `Permission denied`, and the
`uid=0` inside the namespace is not the host's root: `sudo` reports that no new
privileges flag is set, and `su` fails on the token.

This is deliberately not an OS user per account. Measured on the host this was
built for, that route is unavailable: `sudo -n true` demands a password,
`setpriv --reuid=…` answers `setresuid failed: Operation not permitted`, and
`/home` is `root:root 0755`. The namespace needs neither root nor sudo, and it
does not cost the service its access to the files a tenant writes — an
unprivileged user namespace maps the fake uid back onto the service account, so
the service can still read and clean up after a tenant. A real `useradd` per
account would break exactly there.

The fallback is honest and visible. Without `bwrap`, or where the kernel
refuses unprivileged user namespaces, the shell opens unconfined and the API
says so: `sandboxed` is `false` in the `GET /api/terminal` response, and the
service logs a warning naming the reason. The key is always present, so a
client never has to distinguish "not isolated" from "field missing". A working
directory outside the account's home is refused outright rather than opened
somewhere else — the response carries `cwd-outside-home` and a remediation
instead of a shell that is quietly in the wrong place.

The other per-account boundaries keep the older, weaker shape. File access,
workspace validation, and session ownership are all **assignments, not
containment**: each is decided from data the service process itself can write — a
requested path, a `cwd` field inside a session file, a terminal id. The session
files are ordinary files in one shared tree owned by the account the service
runs as, and that account can write them. So whoever can write that data decides
what it points at: editing the `cwd` of someone else's session file moves that
session into your own home as far as the service is concerned.

Those checks stop accounts from seeing each other by accident and through the
routes the service exposes. They do not survive someone who edits the
underlying files, and closing that would mean giving each account its own OS
user, not sharpening a check. Read the per-account features as separation
between honest users of one service, with the terminal namespace as the
exception that the kernel backs up.

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
