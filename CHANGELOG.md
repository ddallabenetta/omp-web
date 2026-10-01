# Changelog

All notable changes to this distribution. Versions are independent of the
upstream line — see the Provenance section in the README.

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
