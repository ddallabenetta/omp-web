# Changelog

All notable changes to this distribution. Versions are independent of the
upstream line — see the Provenance section in the README.

## Unreleased

**Not verified in this release.** Stated plainly, because a release note that
claims more than was tested is worse than one that admits the gap:

- The sandbox was exercised on one host, on Linux, with `bubblewrap` present
  and unprivileged user namespaces enabled. The `userns-disabled` and
  Windows branches are covered by type and by the refusal contract, not by a
  run.
- The Docker image was built and `command -v bwrap` was confirmed inside it.
  The container was not started against a real multi-account setup.
- A working directory outside the account's home is now refused. If a
  deployment relied on opening a terminal in such a directory — an
  `~/omp-cwd-*` grant, for instance — that terminal will now be refused with a
  remediation instead of opening. Bind it deliberately rather than expecting it
  to keep working.

### Terminal

**Tenant shells run in a user namespace.** `lib/sandbox.ts` builds a
`bubblewrap` argv whose only bind is the account's own home, and
`lib/terminal-manager.ts` replaces the shell command with it. Measured: a
foreign home answers `No such file or directory` rather than `Permission
denied`, `/etc/shadow` stays unreadable, and `uid=0` inside the namespace is
not host root. The OS-user-per-account route was measured and is unavailable
on the target host — no root, no sudo, `setpriv` answers `setresuid failed` —
and the namespace has the property that route would have broken: an
unprivileged namespace maps the fake uid back onto the service account, so the
service can still read and clean up after a tenant.

- `sandboxed` is now part of `GET /api/terminal` and `GET /api/terminal/<id>`.
  Without `bubblewrap` or with user namespaces disabled the shell still opens,
  unconfined, and the flag is `false` — the key is always present, never
  absent, so a client does not have to tell "not isolated" from "unknown".
- A working directory outside the account's home is refused as
  `cwd-outside-home` with a remediation, rather than passed through to fail
  later as `[Process exited with code 1]` in the SSE stream. A username that
  would escape its path segment is refused as `bad-username` instead of
  borrowing the unrelated `no-home` reason.
- Bind sources that the host does not have are skipped. `bwrap` aborts on a
  missing `--ro-bind` source rather than ignoring it, so a host without
  `/lib64` previously lost the terminal entirely.
- The Docker image installs `bubblewrap`. It is the one host where every
  terminal otherwise took the `bwrap-missing` branch.

### Quick phrases

**Saved texts are one click deep in the composer.** A phrase carries a button
label and, separately, the text to insert. Each configured phrase renders as a
button row above the input field; one click inserts its text **at the cursor
position**, keeping the text to the left and right of the caret untouched. The
full text is the button's tooltip, so a short caption can carry a long or
multi-line insertion.

- Managed in Settings → Quick phrases. The list is the button order; there is
  no separate sorting, grouping or shortcut layer, by design.
- **The list is stored on the server, one file per account.**
  `app/api/quick-phrases/route.ts` (GET/PUT) follows the `models-config` route:
  `requireIdentity`, `403` in both handlers, `415` without a JSON content type.
  The file is `omp-web-quick-phrases.json` inside
  `resolveTenantAgentDir(identity)` — the same directory the trust store uses —
  written with `writePrivateFileAtomicSync` (`0o600`, temp file plus rename).
  The path is checked with `isPathWithinRoots` **before** the directory is
  created, so a refused request leaves nothing behind in a foreign home.
  A `localStorage` list followed the browser, not the account: a second browser,
  a private window or a different workstation showed a different set, and
  changing machine lost it silently. The agent never reads these phrases, so
  they still do **not** go through `/api/settings` — that endpoint projects a
  schema owned by a pinned package, and extending it would mean patching
  `node_modules`.
- **Existing phrases migrate without loss.** At the first server fetch, if no
  file exists yet, the phrases from `omp-quick-phrases` move to the file. The
  defaults are seeded only when *both* legacy keys are absent — the same rule
  the old seed used, and for the same reason: overwriting a list the user
  wrote, at the moment of the first read, before they ever see it, is the worst
  thing a seed can do. The legacy keys are cleared after the `PUT` succeeds, so
  a server that goes down in between leaves the phrases in the browser to be
  offered again.
- A phrase without a non-empty `text` is dropped on read and on write: a button
  that inserts nothing is a silent malfunction. An empty label is allowed and
  falls back to the text, shortened to one line.
- The row does not wrap. On a 390 px screen with twenty phrases it stays a
  single 18 px-tall line that scrolls horizontally (measured: `scrollWidth`
  1540 vs `clientWidth` 330), so every phrase remains one click deep instead of
  costing three rows of transcript height.
- **Typing writes once, not once per letter.** The settings section debounces
  400 ms and additionally writes on field blur and on dialog close, so closing
  without touching anything else still persists. Delete and Add bypass the
  timer: a delete that waits for a debounce window looks to the user like the
  row came back.
- A failing server does not clear or freeze the view. The last list the user
  saw stays on screen and the settings section says what went wrong; a failed
  request is retried on the next load. The first fetch is single-flight, so
  composer and dialog mounted together cause one request, not two.
- The button label is user content and is never translated; only the settings
  section's own strings are.
- Seven defaults are seeded on the first fetch when there is nothing to
  migrate: `Research`, `Compare`, `Verify`, `Explain`, `Review`, `Tests`,
  `Fix`. The first three reach outward — they research a topic or compare
  options instead of talking about the code in the window, which is why they
  work with an empty input field. **Seen once, never again:** the existence of
  the file is what decides, not the list contents. Delete all seven and they
  stay gone, on every tab, every browser and across reloads. A file that exists
  but is empty is a decision, and an unreadable file counts as existing too —
  neither is topped up.

### Accounts

- Uploads in the file explorer land in the directory the user is looking at,
  not in the project root. `cwd` was passed down the upload chain where the
  current browse position was meant.
- Account creation checks `OMP_WEB_HOME_ROOT` before it creates anything, so a
  failure names the variable to set instead of surfacing a raw `EACCES` from
  `mkdir`. An existing, writable root is accepted even when its parent is
  read-only, and a root writable through group ownership is no longer
  refused.

## v0.9.0

The first release of the independent distribution. 98 files, +13,793/−352,
43 commits. Everything below exists only here.

### Security

**A client-supplied header granted full admin access.** `proxy.ts` set the
identity headers on a path that only ran when an identity already existed, so
on an unlocked server — the default, and the state of the machine this was
found on — the client-supplied `x-omp-admin: 1` survived into the route and
`owner-guard.ts` let it through without an ownership check. A forged header
plus an arbitrary username gave arbitrary write via another account's shell.
Found by execution, not by reading: `curl -H 'x-omp-user: root' -H 'x-omp-admin: 1'`
listed `/etc` with status 200.

**A refusal that had two causes.** The write boundary that keeps an admin from
writing `/etc` was verified by mutation, not by watching refusals. Such a file
is refused for two independent reasons — the root filter and the fact that it
sits in no project — so a test that only checks the refusal sees neither. The
coverage asserts the filtered *set* instead.

**Account names are validated before any directory is created**, so `../etc`
never becomes a path segment.

### Accounts

- Real per-account access replacing the single credential: an admin creates
  accounts, each gets its own home, `models.yml`, `config.yml`, sessions, and
  terminals.
- File access is a per-account root set rather than one process-wide allowlist.
  `/` and `OMP_WEB_ALLOWED_ROOTS` are added in the admin branch only.
- Admins can read `/etc` but not write to it — the write boundary is
  deliberately narrower than the read one.
- A foreign session or terminal answers `404`, not `403`, so a probe learns
  nothing about whether the id exists. The `agent/running` snapshot and its SSE
  stream filter too; they publish the ids the rest of the API addresses things
  by.
- A new account's config starts empty on purpose. Copying the operator's
  `models.yml` would hand his API key to the first tenant.
- `OMP_WEB_HOME_ROOT` documented. It is the one variable account creation
  needs, and it was in no documentation at all — the default `/home` is not
  writable by a service account, and the mkdir has no permission check, so
  account creation failed with a raw system error naming the server's path.

### Files

- The explorer tree became a permanent first tab: never closable, files open
  beside it, a button hands the tree back. Previously the tree was a fixed
  column and a preview rendered as a layer underneath it.
- The window portal-renders out of the sidebar. The sidebar sets `overflow-x:
  hidden` on the explore container, and `position: fixed` does not escape a
  clipping ancestor — on a phone the panel was cut in half down the middle.
  `DirectoryPicker` and `FileContextMenu` had always portalled for this reason;
  the explorer was the one overlay that did not.
- Write operations behind a guard: create, rename, move, copy, delete, upload.
- Context menu on tree rows, with a reusable target-folder dialog.
- Image preview with zoom and grid/list modes.

### Terminal

- PTY-backed shell in a browser tab, session-scoped, with input, resize, and a
  stream. On mobile the layout switches to a 90vh overlay.

### Interface

- Live CPU and RAM badge with a sparkline popover, reporting the container's
  actual limits rather than what the host kernel advertises.
- Cookie sessions on top of Basic Auth, a login page with a looping entrance
  animation, and a recovery flow.
- Opening a new tab scrolls it into view. The strip could already scroll;
  nothing asked it to, so on a narrow window the tab you just opened hung past
  the edge and looked clipped.

### Fixes

- A refocused dialog could sit in the background with no focus, taking no
  keypresses: the focus effect ran once against a panel that was not mounted.
- The context menu rendered 84px off.
- Long session titles in a tab appeared mid-component, as if truncated.
- CPU percent read from `os.cpus()` counted idle as busy and pinned at 100%.

### Documentation

- `AGENTS.md` now carries the per-account rules, the owner filter, and the
  statement that none of it is containment. The architecture diagram described
  `/api/sessions` with no ownership condition, which reads as "the tree is
  everyone's" — and it is, one tree owned by the service account.
- `docs/authentication.md` gained a section on where account homes live.

### Provenance

The upstream remote has been removed. There is no merge path and no automatic
tracking; pulling upstream changes in is now a deliberate operation. The npm
publish workflow inherited from the fork is disabled. Releases are GitHub
releases only, installed from a checkout or a release tarball.
