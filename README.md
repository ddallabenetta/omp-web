<p align="center">
  <img src="./docs/hero.png" alt="omp-web — Browser workspace for omp" width="100%">
</p>

<p align="center">
  <a href="https://github.com/steimerbyte/omp-web/releases"><img src="https://img.shields.io/github/v/release/steimerbyte/omp-web?style=flat&colorA=222222&colorB=58A6FF" alt="Release"></a>
  <a href="https://github.com/steimerbyte/omp-web/blob/main/LICENSE"><img src="https://img.shields.io/github/license/steimerbyte/omp-web?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

<p align="center">
  Originally forked from <a href="https://github.com/agegr/pi-web">pi-web</a> and omp-web.
  This is an independent distribution now — see <a href="#provenance">Provenance</a>.
</p>

The web view for [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi). omp-web reads the sessions the `omp` CLI already writes and gives you a browser workspace for session browsing, real-time chat, model roles, provider configuration, skill management, and project file preview.

It is not a separate agent: omp-web runs omp's own SDK in-process, against the same `~/.omp/agent` directory, so a session started in the terminal continues in the browser and back again.

## What this distribution adds

The upstream project tracks omp closely. Everything below is work that exists only
here — either new surface, or a defect in the inherited code that had to be found
before it could be fixed.

**Multiple accounts, not one password.** Upstream has a single credential that
locks the whole interface. This distribution has real accounts: an admin creates
them, each gets its own home directory, its own `models.yml` and `config.yml`,
its own terminal sessions, and its own view of which sessions and shells exist.
File access is a per-account root set rather than one process-wide allowlist, and
an admin can read `/etc` but not write to it. Full threat model, including what
this deliberately does *not* protect against: [docs/authentication.md](./docs/authentication.md).

**A file explorer you can work in.** The tree became a tab in its own right: a
permanent first tab you cannot close, files open beside it, and a button that
hands the tree back. The window portals out of the sidebar so it is a real
overlay instead of a panel clipped to half the screen on a phone. Write
operations — create, rename, move, copy, delete, upload — go through a guard
that was not there before.

**A terminal next to the chat.** A PTY-backed shell in a browser tab, session-scoped,
with input, resize, and a stream. On mobile the layout switches to a 90vh overlay
instead of a cramped side panel.

**Live machine stats.** A CPU and RAM badge in the top bar with a sparkline
popover, reporting what the container actually has rather than what the host
kernel advertises.

**A browser you can sign in to.** Cookie sessions on top of Basic Auth, a proper
login page, and a recovery flow — plus a documented `OMP_WEB_HOME_ROOT` variable
that is the one thing account creation needs and which no release before this
had documented.


## Quick Start

omp-web serves its API on **Bun**, because that is what the omp SDK requires (it is published as TypeScript sources and imports `bun:` builtins). Install Bun 1.3.14 or newer:

```bash
curl -fsSL https://bun.sh/install | bash        # macOS / Linux
powershell -c "irm bun.sh/install.ps1 | iex"    # Windows
```

**From a release:**

```bash
git clone https://github.com/steimerbyte/omp-web.git
cd omp-web
bun install
bun run build
bunx omp-web
```

Or download a release tarball from the [releases page](https://github.com/steimerbyte/omp-web/releases)
and run the same three commands in the extracted directory.

**Install globally from a checkout:**

```bash
bun add -g ./omp-web    # or: npm install -g ./omp-web
omp-web
```

This distribution is not published to the npm registry — the publish workflow
that came with the fork is disabled here. Install from a checkout or a release
tarball, as above. If you have a `pi-web` or `omp-web` package from the registry
installed, it is a different build; remove it first so the entrypoints do not
shadow each other.

On Windows, if `bunx` fails before startup with `EPERM: Operation not permitted (NtSetInformationFile())` while moving a package to the Bun cache, the failure is in Bun's Windows cache rename, not in omp-web. Update Bun and retry with a fresh cache:

```powershell
bun upgrade
bun pm cache rm
$env:BUN_INSTALL_CACHE_DIR = "$env:LOCALAPPDATA\omp-web-bun-cache"
New-Item -ItemType Directory -Force $env:BUN_INSTALL_CACHE_DIR | Out-Null
bunx omp-web
```

If an antivirus or endpoint-security process still holds the extracted directory open, use npm for dependency installation; the `omp-web` launcher still starts the server through Bun:

```powershell
npm install
omp-web
```

Then open [http://127.0.0.1:30141](http://127.0.0.1:30141). The CLI opens the browser automatically once the server is ready, and listens on `127.0.0.1` by default.

The `omp-web` entrypoint itself runs under Node or Bun; it locates Bun and re-executes the server there. Point it at a specific build with `OMP_WEB_BUN=/path/to/bun`.

**Options:**

```bash
omp-web --port 8080              # custom port
omp-web --hostname 0.0.0.0       # expose on a trusted network
omp-web -p 8080 -H 0.0.0.0       # combine options
omp-web --no-open                # do not open the browser automatically
omp-web --authenticated          # require a password (asks for one if none is set)
omp-web --reset-password         # set a new password when the old one is lost

PORT=8080 omp-web                 # environment variable is also supported
OMP_WEB_HOSTNAME=0.0.0.0 omp-web  # explicit network exposure
OMP_WEB_ALLOWED_HOSTS=omp.internal omp-web  # allow an exact proxy/custom hostname
OMP_WEB_AUTHENTICATED=1 omp-web   # same as --authenticated
OMP_WEB_PASSWORD='a-long-random-password' omp-web  # override the stored password
OMP_WEB_NO_OPEN=1 omp-web         # useful when running as a background service
```

## Docker

A `Dockerfile` builds omp-web from source and runs it under Bun in the
container. It still needs the omp home the CLI writes, so mount it:

```bash
OMP_WEB_PASSWORD='a-long-random-password' \
OMP_UID=$(id -u) OMP_GID=$(id -g) docker compose up --build
```

That publishes <http://127.0.0.1:30141> with the password lock on, sharing
`$HOME/.omp` with the container so terminal sessions continue in the browser.
Volume layout, UID/GID matching and reverse-proxy notes: [docs/docker.md](./docs/docker.md).

## Accounts

A password locks the web interface and every API endpoint behind authentication. Sign in through the browser form, or send HTTP Basic Auth — both accept the same credential. Turn the lock on wherever suits you:

- **Settings → Access** in the browser, to set the password and switch the lock on or off.
- **`omp-web --authenticated`**, which turns it on for this run and every later one, and asks for a password on the terminal if none has been set yet.
- **`OMP_WEB_PASSWORD`**, which overrides the stored credential for as long as it is set.

The username defaults to `omp` and is changeable in the same **Settings → Access** panel, or through `OMP_WEB_USERNAME`. Both halves of the credential matter: the session cookie is signed over the username *and* the password, so changing either one invalidates the sessions that were minted with the old pair.

The password is stored as a `scrypt` hash in `~/.omp/agent/omp-web-auth.json` (mode `0600`) — never in plaintext, and never recoverable from the file. Forgotten it? Run `omp-web --reset-password` on the server, or open `/recover` and enter the one-time code omp-web prints on its own console.

Session cookies are additionally bound to the server process: the signing key is salted with a random value generated at each cold start, so a cookie stops verifying after a restart even though the credential itself did not change. Sign in again after a redeploy.

### Several accounts

`OMP_WEB_PASSWORD` is a single-credential door, not a multi-user configuration. With
it set there is exactly one account — the configured username. Any other name is
refused the same way a wrong password is, which is deliberate: it keeps the
question "is that a second user or a typo" from becoming something the caller can
probe.

Real accounts come from an accounts file. An admin creates them under
**Settings → Accounts**, and each one gets:

- a home directory, which is the boundary for file access, session ownership, and
  its own `models.yml` and `config.yml`;
- its own sessions and terminals — another account's session answers `404`, not
  `403`, so a probe learns nothing about whether the id exists;
- a config that starts empty on purpose, because copying the operator's
  `models.yml` would hand his API key to the first tenant.

Admins are `omp`, `pi`, and `steimerbyte` by default, overridable through
`OMP_WEB_ADMINS`. The exemption is deliberate and covers writes: a compromised
admin password is host compromise, not just a stolen tenant.

**One setting decides whether account creation works at all.** Creating an account
makes a directory for it, and the default parent is `/home`. An unprivileged
service account cannot write there, and because the call has no permission check
and no fallback, account creation fails outright with a raw system error naming
the server's own path. Set `OMP_WEB_HOME_ROOT` to somewhere the service can
write:

```bash
mkdir -p /home/pi/accounts && chown pi:pi /home/pi/accounts
# in the service unit:
Environment=OMP_WEB_HOME_ROOT=/home/pi/accounts
```

The settings panel shows the configured root, so seeing `/home` there means the
variable is not set. It changes where homes are *looked for*, not where they
already are — decide it together with any existing account rather than one after
the other.

Stated plainly, because it is easy to read the above as more than it is: none of
this is containment. Every boundary is an assignment decided from data the service
process can write, so it stops an account from seeing another's work by accident
and through the routes that exist — not against someone who edits the underlying
files. Session ownership itself comes from a `cwd` field in a file the service
account owns. Closing that gap needs an OS user per account, not a stricter check.

The terminal is the one exception. Its shell runs in a `bubblewrap` user
namespace with exactly one bind — the account's own home — so another account's
home does not exist inside rather than merely being unreadable, and `uid=0`
there is not the host's root. It does not need an OS user, so the gap above does
not have to stay open. Where `bwrap` or user namespaces are unavailable the shell
opens unconfined and says so: `sandboxed` is `false` in `GET /api/terminal`.

Full details, including the recovery threat model: [docs/authentication.md](./docs/authentication.md).

omp-web can invoke a high-privilege agent. Password access does not encrypt the credential in transit, so do not expose plain HTTP to the internet. Use HTTPS through a trusted reverse proxy or a trusted VPN for remote access.
API requests accept loopback names, IP literals, the selected bind hostname, exact comma-separated names in `OMP_WEB_ALLOWED_HOSTS`, and wildcard patterns such as `*.example.com`. Configure that variable when a trusted reverse proxy uses a different external hostname.

## Provenance

This began as a fork of [agegr/pi-web](https://github.com/agegr/pi-web) and was
carried forward through the omp-web line. It is now an independent distribution:
the upstream remote has been removed, so there is no merge path and no automatic
tracking. Pulling upstream changes in is a deliberate operation — re-add the
remote, fetch, and reconcile by hand.

The line of descent is still visible in the history and in the MIT license, which
is unchanged. What changed is who ships it and from where.

Releases are cut from this repository only. The npm publish workflow that came
with the fork is disabled here — this distribution is installed from source or a
release tarball, not from the registry.

## Model roles

omp does not have "the" model — it has a model per **scope of work**, and omp-web exposes the same roles the TUI's `/model` selector and `Ctrl+P` cycle use:

| Role | What it runs |
| --- | --- |
| `default` | ordinary turns |
| `smol` | cheap, fast subagent and background work |
| `slow` | deep reasoning on hard problems |
| `plan` | plan mode |
| `commit` | commit messages and changelogs |
| `task` | the model subagents spawn with |
| `advisor` | the second model that reviews every turn |
| `vision`, `designer`, `tiny` | image turns, design work, classification |

Two places surface them:

- **The model picker in the chat bar** lists the configured roles above the flat model list. Picking one switches the session onto that role's model *and records the role*, exactly like `/model` does, so the transcript and omp's retry fallbacks agree on which role is driving.
- **Models → Model roles** assigns a model to each role. Writes go to `modelRoles` in `~/.omp/agent/config.yml` (or `.omp/config.yml` when you pick **This project**), which is the same record the CLI reads — an assignment made in the browser is what your next terminal session starts with.

Session titles follow the same routing: omp-web asks omp to name a session, and omp resolves that through the `tiny` → `commit` → `smol` chain rather than the session's primary model.

The reasoning selector supports **Auto**, which lets omp select effort for each turn. The selector keeps Auto selected across reloads and shows the resolved effort separately, for example `auto (high)`. Selecting Auto explicitly also carries that preference into a new session.

## HTTP Proxy

omp-web reads the standard `HTTP_PROXY` and `HTTPS_PROXY` environment variables for server-side model and API requests. Bun reads them once at process start, so set them before launching:

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
bunx omp-web
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
bunx omp-web
```

Requests to loopback addresses are never proxied, so a local provider (Ollama, LM Studio, llama.cpp) keeps working with a proxy configured. Note that Bun does **not** currently honour `NO_PROXY` for other hosts.

## Features

- **Pick work back up**: browse previous omp conversations by project without digging through terminal history or session paths.
- **Share the server safely**: real per-account access — an admin creates accounts, each gets its own home, config, sessions, and terminals, and file access is a per-account root set rather than one process-wide allowlist.
- **Work in the files**: create, rename, move, copy, delete, and upload from the browser, each behind a write guard that is checked against the account, not just the path.
- **Open the tree in its own window**: the explorer portal-renders out of the sidebar as a real overlay, and the tree is the window's first tab rather than a fixed column.
- **Route by role**: assign and switch models per scope of work — the roles omp already uses for subagents, plan mode, and commits.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right while the agent works.
- **Edit files in the browser**: open a file, change it, and save with `Ctrl+S` — no round trip to the terminal.
- **Run a terminal next to the chat**: a real shell in a browser tab, session-scoped, with input and resize, so a failing command and its output sit next to the agent that produced them.
- **Watch the machine work**: a live CPU and RAM badge in the top bar, with a sparkline popover on click.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details are visible from the top bar.
- **Configure less from the terminal**: manage providers, logins/API keys, model tests, plugins, and skill switches from the web UI.
- **Lock it down properly**: browser sign-in with a configurable username, hashed-at-rest credentials, and a one-time console code for recovery.
- **Use the interface in your language**: switch between the supported UI languages from the top bar.

## Screenshots

**Session browsing + file explorer** — projects and past sessions on the left, the project's real file tree underneath, ready to preview or attach to a message.

![Sidebar with session browsing and the file explorer](./docs/screenshots/01-sidebar-and-explorer.png)

**Real-time chat with model roles** — the agent's tool calls, cost, context usage, and the active model role are all visible while it works.

![Chat view showing an agent run with tool calls, cost, and context usage](./docs/screenshots/02-chat-session.png)

**Chat beside the project** — browse and preview a file next to the conversation without losing your place.

![Chat pane next to a rendered Markdown file preview](./docs/screenshots/03-file-preview.png)

**Model roles, configured once, used everywhere** — assign a model per role (`default`, `smol`, `plan`, `commit`, …); both omp-web and the omp CLI read the same `models.yml`.

![Settings panel showing model role assignments](./docs/screenshots/04-settings.png)

**Full omp theme support** — omp-web reads omp's own dark/light palette mappings from `~/.omp/agent/config.yml` and applies them live, so the web view matches the terminal.

![Theme settings showing omp's dark and light palette mapping](./docs/screenshots/05-themes.png)

## Notes

- **Data directory**: omp-web reads `~/.omp/agent/sessions` by default. Set `PI_CODING_AGENT_DIR` to point at another omp agent directory (omp kept the variable name).
- **Session files**: files are stored as `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
- **Provider config**: the Models panel reads and writes `models.yml` in the omp agent directory. Credentials live in omp's `agent.db`, shared with the CLI. A header value that names an environment variable (bare name, no `$`) is substituted at request time.
- **Custom system prompts**: `SYSTEM.md` and `APPEND_SYSTEM.md` are picked up for browser sessions exactly as `omp` picks them up in a terminal — the project's `.omp/` (or `.claude/`, `.codex/`, `.gemini/`) first, then `~/.omp/agent/` — resolved against the session's own working directory.
- **Project trust**: opening a repository in a browser tab must not run its code, so omp-web gates a project's `.omp/extensions`, `.omp/hooks`, `.omp/tools` and `.mcp.json` behind an explicit trust decision. Skills and rules are data and load either way. See [Project trust](./docs/project-trust.md).
- **File access**: file browsing and preview are scoped to the selected project directory and working directories that appear in sessions.
- **Git worktrees**: see [Worktrees in omp-web](./docs/worktrees.md) for when the switcher appears, how new worktrees are created, and what removal does.
- **Forks vs in-session branches**: Fork creates a new `.jsonl` file. "Edit from here" creates another branch inside the same session file.
- **Skills**: the skill installer shells out to `npx skills add --agent claude-code`, which writes the `.claude/skills` layout omp discovers by default.
- **Internationalization**: see [Internationalization](./docs/i18n.md) for using translations and adding languages or UI text.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-web:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, omp-web preserves the
browser's native context menu. This hook is browser-side and independent of
Pi agent extensions.

## Development

```bash
bun install
bun run dev
```

The local dev server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141).

Common checks:

```bash
bun run typecheck
bun run lint
bun test
```

Avoid running `bun run build` during local development. It writes to `.next/` and can interfere with the dev server; leave builds for release work.

## Desktop (Tauri)

`src-tauri/` is a Tauri v2 shell that runs this same app as a desktop
application: the webview loads the Next.js server, which is started as a Bun
sidecar on a free loopback port. Desktop and CLI share `~/.omp`, so sessions,
credentials and model config are identical across both.

Requires a Rust toolchain in addition to Bun. Useful commands (all defined in
`package.json`):

```bash
bun run desktop:dev          # tauri dev — runs `bun run dev` and opens the webview
bun run desktop:build        # stages the payload (build + production deps) and bundles
bun run desktop:fetch-bun    # downloads pinned Bun binaries into src-tauri/resources/
bun run desktop:sync-version # aligns src-tauri/ versions with package.json
bun scripts/stage-desktop.mjs --skip-build  # re-stage without rebuilding next
bun scripts/build-updater-json.mjs <tag>  # (re)generates latest.json for a release
```

`desktop:build` stages the server payload into `src-tauri/server/` (gitignored):
a production `next` build via `OMP_WEB_DIST_DIR` (the dev `.next/` is never
touched), production-only dependencies, and the Bun runtime(s) for the host
platform. The CI stage step passes `--universal`, which also bundles both
macOS architectures' native runtimes (SWC + pi-natives) for the universal
app. The bundle stays lean: no devDependencies, no webpack cache, no optional
dependencies (onnxruntime/transformers.js for local embeddings — the
platform's native runtimes are kept: `next start` and the SDK's workspace
tree load them eagerly, and a missing SWC would otherwise trigger a
package-manager download that fails in a GUI app), no client-only stats UI —
while keeping the agent's PDF and browser tools (mupdf, puppeteer-core).
Payload ~700MB, dmg ~250MB.

Pushing a `v*` tag triggers `.github/workflows/publish-desktop.yml`: it builds
macOS (universal) and Windows bundles, uploads them to a GitHub release with
Ed25519 signatures, and generates the updater manifest (`latest.json`). The
updater fetches
`https://github.com/steimerbyte/omp-web/releases/latest/download/latest.json`.
To enable that, configure two repository secrets — `TAURI_SIGNING_PRIVATE_KEY`
(contents of `~/.omp/omp-web/omp-desktop-signing.key`, generated by
`bun run desktop:signer generate`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
macOS builds are unsigned: the first launch needs right-click → Open (Gatekeeper),
subsequent auto-updates are written by the app itself.

## Project Structure

```text
app/
  api/
    agent/          # creates/drives AgentSession and exposes SSE events
    auth/           # OAuth and API key management through omp's AuthStorage
    cwd/browse/     # browsable server directory listing
    cwd/validate/   # custom working directory validation
    default-cwd/    # omp default working directory lookup
    files/          # file listing, reading, preview, and watching
    file-actions/   # create, rename, move, copy, delete, upload
    home/           # current user home directory
    whoami/         # the caller's identity, as the proxy resolved it
    model-roles/    # read/write omp's modelRoles (default/smol/slow/plan/…)
    models/         # available models, default model, thinking levels, roles
    models-config/  # read/write models.yml and test models
    plugins/        # omp plugin install/remove/enable/disable
    sessions/       # session reads, rename, delete, context, HTML export
    settings/       # web settings, including the access panel
    skills/         # skill listing, search, install, enable/disable
    system-stats/   # live CPU, RAM and load readings
    terminal/       # PTY-backed shell sessions: create, stream, write input
    web-access/     # credential check, sign-in, and the recovery code
      login/        # POST sign-in, sets the session cookie
      recovery/     # trade a recovery code for a new password
      users/        # account management, admin only
    worktrees/      # Git worktree listing and switching
  login/            # sign-in page
  recover/          # forgotten-password page
components/
  AppShell.tsx        # main layout, URL state, top panels, file tabs
  SessionSidebar.tsx  # project selector, session tree, Explorer
  DirectoryPicker.tsx # browsable and editable working-directory picker
  ChatWindow.tsx      # messages, SSE, image drag/drop, minimap
  ChatInput.tsx       # input bar, model/role/tools/thinking/compact/slash controls
  MessageView.tsx     # message, thinking, tool call/result rendering
  ModelsConfig.tsx    # provider and auth configuration panel
  ModelRolesPanel.tsx # per-role model assignment
  SkillsConfig.tsx    # skill management panel
  FileExplorer.tsx    # file tree, with breadcrumb navigation, and the large window
  FileViewer.tsx      # source, diff, image, audio, PDF, DOCX preview, and editing
  FileImagePreview.tsx # image overlay with zoom and grid/list modes
  FileBrowserDialog.tsx # file picker for copy/move/upload targets
  FileContextMenu.tsx  # per-row actions, portalled to the body
  UsersConfig.tsx     # account management, admin only
  SystemStatsBadge.tsx # live CPU/RAM readout with a sparkline popover
  TerminalDropdown.tsx  # terminal tab selector in the top bar
  TerminalViewer.tsx    # xterm.js surface fed by the PTY stream
lib/
  directory-browser.ts # directory normalization and safe listing helpers
  file-access.ts      # file read safety boundary, scoped per account
  write-access.ts     # write boundary; refuses the filesystem root for admins too
  allowed-roots.ts    # allowed roots, bucketed per identity
  path-security.ts    # per-account home checks
  tenant-config.ts    # resolves each account's agent directory
  skill-lock.ts       # per-account skill install locks
  file-paths.ts       # path encoding and relative path helpers
  http-dispatcher.ts  # HTTP(S) proxy setup for server-side fetch
  markdown.ts         # Markdown/Mermaid/KaTeX plugin configuration
  model-roles.ts      # omp's model roles, read and written for the browser
  model-scope.ts      # enabledModels resolution shared by UI and startup
  normalize.ts        # normalizes toolCall field names
  omp-runtime.ts      # shared Settings + AuthStorage + ModelRegistry
  omp-types.ts        # structural view of omp's AgentSession
  project-trust.ts    # gates a project's executable resources
  request-security.ts # host allowlist and cross-site request rejection
  rpc-manager.ts      # AgentSessionWrapper lifecycle and global registry
  session-reader.ts   # parses .jsonl session files and branch contexts
  terminal-manager.ts # PTY lifetime + sandbox spawn, sessions kept alive on globalThis
  sandbox.ts          # the bwrap user namespace a tenant shell runs in
  web-auth.ts         # credential store, username resolution, scrypt hashing
  web-auth-session.ts # session cookie issue/verify, signed with a boot salt
hooks/
  useAgentSession.ts  # session loading, command sending, SSE state machine
  useAudio.ts         # completion sound
  useDragDrop.ts      # image drag/drop
  useTheme.ts         # theme switching
bin/
  omp-web.js          # CLI entrypoint; re-executes the server under Bun
  runtime.js          # Node/Bun version checks and Bun discovery
  web-auth-store.js   # credential and account store, scrypt-hashed
instrumentation.ts    # initializes the server HTTP dispatcher
```
