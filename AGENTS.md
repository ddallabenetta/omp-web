# omp-web - Development Notes

## Quick Start

```bash
bun install
bun run dev   # port 30141
```

Typecheck: `bun run typecheck`
Lint: `bun run lint`
Tests: `bun test`
**Never run `bun run build` during dev** — pollutes `.next/` and breaks `bun run dev`.
Exception: `bun run desktop:build` (via `scripts/stage-desktop.mjs`) is safe — it builds
into `src-tauri/server/.next` through `OMP_WEB_DIST_DIR` and never touches the dev `.next/`.

### Everything runs on Bun

`@oh-my-pi/pi-*` is published as **TypeScript sources** and imports `bun:sqlite`,
so Node cannot load it at all (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
The server half of omp-web therefore only runs on Bun; `bin/omp-web.js` finds a
Bun binary and re-executes `next start` through it.

Two consequences worth remembering:

- `next.config.ts` externalizes **every** `@oh-my-pi/*` request as an ESM
  `import`, not `commonjs`. The SDK's `exports` map declares only an `import`
  condition, so a `require()` of it cannot resolve — that is what
  "Cannot find module '@oh-my-pi/pi-coding-agent'" during *Collecting page data*
  means. `serverExternalPackages` alone is not sufficient: it misses the SDK's
  own transitive entry points.
- `bun test`, not `node --test`. The test files are `node:test`-based and Bun
  runs them; Node cannot import the SDK the tests exercise.

---

## Architecture

```
Browser                Next.js Server (Bun)        AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/  │  ← filtered by owner, see below
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │  ← filtered by owner, see below
  ├─ GET /api/agent/running ───────▶ running id snapshot   │  ← filtered by owner, see below
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK helpers and
`lib/session-reader.ts` — no AgentSession created.
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an
AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  model-roles/route.ts            GET/PUT omp's modelRoles record
  models/route.ts                 GET { models, modelList, defaultModel, roles }
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST omp plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  web-access/route.ts             GET/PUT the password lock (settings -> Access)
  web-access/recovery/route.ts    POST recovery code request/redeem (unauthenticated)
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  model-roles.ts       omp's model roles, read/written for the browser
  model-scope.ts       enabledModels resolution shared by UI and startup
  npx.ts               npx runner used by skill install
  omp-runtime.ts       shared Settings + AuthStorage + ModelRegistry
  omp-types.ts         structural view of omp's AgentSession
  project-trust.ts     gates a project's executable resources
  rpc-manager.ts       AgentSessionWrapper + registry + startRpcSession
  session-reader.ts    session listing + path cache + buildSessionContext adapter
  session-system-prompt.ts  SYSTEM.md / APPEND_SYSTEM.md resolution per session cwd
  session-title.ts     thin wrapper over omp's own title generator
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AccessConfig.tsx    password lock panel inside the settings modal
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/role/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for providers/auth (opened from sidebar bottom)
  ModelRolesPanel.tsx per-role model assignment inside that modal
  PluginsConfig.tsx   modal for installed omp plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__ompSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__ompStartLocks`)
- Extensions are bound with omp's own `initializeExtensions()` from
  `@oh-my-pi/pi-coding-agent/modes/runtime-init` — the same wiring `omp --mode rpc`
  uses — with a browser-backed `ExtensionUIContext` layered on top. Do not
  reimplement the action set; a mismatch shows up as extensions silently doing
  nothing.

### One runtime, many requests (`lib/omp-runtime.ts`)
omp's CLI builds `Settings` + `AuthStorage` + `ModelRegistry` once per process.
omp-web does the same and caches them on `globalThis`; a second `AuthStorage`
would open a second SQLite handle on `~/.omp/agent/agent.db` and split
`credential_disabled` events. Per-project settings come from
`settings.cloneForCwd(cwd)`, never from a second `Settings.init()`.

Anything that mutates credentials or `models.yml` must call
`invalidateOmpRuntime()` as well as `invalidateModelsCache()`.

### Model roles are the model selector
omp assigns a model per scope of work (`default`, `smol`, `slow`, `vision`,
`plan`, `designer`, `commit`, `tiny`, `task`, `advisor`), stored in the
`modelRoles` record in `config.yml`. `lib/model-roles.ts` reads and writes that
record; `GET /api/models` ships the resolved table so `ChatInput` can list roles
above the flat model list, and `set_role_model` switches the session **and
records the role** so the transcript matches what `/model` writes in the TUI.

An explicit model pick in the browser is persisted as `modelRoles.default`
(`lib/startup-preferences.ts`), which is the same slot the TUI writes.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (omp does this itself during migrations). Used when cascade-reparenting children on delete.

### `SessionManager.open()` is async
Every omp `SessionManager.open()` / `forkFrom()` / `continueRecent()` returns a
Promise, and `setSessionName()` / `newSession()` / `flush()` do too. Forgetting
an `await` yields `Property 'getEntries' does not exist on type 'Promise<…>'`.

### Transcript ordering follows omp, not the LLM context
`buildSessionContext()` in `lib/session-reader.ts` mirrors omp's live-chat
transcript (`{ transcript: true, collapseCompactedHistory: true }`): history
replaced by the latest compaction is elided, and the summary renders **at the
chronological compaction point** — after the kept messages, before the
post-compaction turns. It is not the LLM context, where the summary comes first.
`entryIds` is a parallel array to `messages` and is walked locally because omp's
`buildSessionContext` does not return entry ids.

### ToolCall field normalization
omp stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes `toolNames: []` with `restrictToolNames: true` and forces `agent.state.systemPrompt = []` after startup and reloads.

### `enabledModels` scoping
The `enabledModels` setting uses omp's `--models` syntax: globs against
`provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and
an optional `:thinkingLevel` suffix. Never compare those patterns as literal
strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScope()` so
omp-web and the TUI agree on the visible model list, and falls back to all
available models when patterns resolve to nothing. Diagnostics are produced by
re-resolving each pattern alone, because omp's resolver drops unmatched patterns
silently.

### Project trust is omp-web's own
omp has no trust store — it runs a repository's extensions because you ran it
there. A browser tab is not that decision, so `lib/project-trust.ts` keeps a
store in `~/.omp/agent/omp-web-trusted-projects.json` and, for an untrusted
project, filters project-local entries out of omp's discovered extension and
custom-tool paths and disables MCP. Skills and rules are data and always load.
See `docs/project-trust.md`.

### `SYSTEM.md` / `APPEND_SYSTEM.md` are resolved per session cwd
`omp` resolves both files before it creates a session and passes them as
`customSystemPrompt` / `appendSystemPrompt`. `startRpcSession()` builds its own
options, so `lib/session-system-prompt.ts` does the same for the browser: omp's
`findConfigFile` (never a hand-rolled lookup) project-first then user-level,
`resolvePromptInput` to read it, and omp's `applyResolvedSystemPromptInputs` to
set the fields — so the text goes through the same templates the CLI renders it
with. Every lookup is bound to the session's cwd, because the CLI's default
(`getProjectDir()`) is the server's own directory here, not the project's.
Project-local prompt files load for untrusted projects too: they are data, like
skills and rules (`docs/project-trust.md`).

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer omp emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- The allow-list is **per account**, not per process. `getAllowedFileRoots(identity)` takes the caller's `WebIdentity`; a missing identity yields the empty set, and it does not even reach `listAllSessions` there, because an unfiltered scan would rebuild the set the identity is there to narrow. Roots live in a `Map` keyed by identity. `"/"` and `OMP_WEB_ALLOWED_ROOTS` are added in the **admin branch only** — a non-admin never sees them.
- Admins are `pi`, `omp`, `steimerbyte` by default, overridable through `OMP_WEB_ADMINS`. The exemption is deliberate and covers writes: a compromised admin password is host compromise, not just a stolen tenant. The write boundary is narrower than the read one — `isWritePathAllowed` filters the filesystem root out of the writable set even for an admin, so `/etc` is readable and not writable.
- Writes are guarded by `isWritePathAllowed` / `authorizeTransfer`, which take an identity with no default. A route that writes and does not call one is a hole; `grep -c isWritePathAllowed 'app/api/files/[...path]/route.ts'` returning 0 used to mean exactly that.
- The identity arrives in the `x-omp-user` / `x-omp-admin` request headers, and `proxy.ts` is the only thing that may set them. It deletes both before it sets them, on **every** path that lets a request through, including the anonymous one. A delete that a branch never reaches is not a protection: on an unlocked server `identity` is null, and a client-supplied `x-omp-admin: 1` used to survive into the route and grant full admin access.
- Accounts live in a separate `omp-web-accounts.json` beside the credential file, with its own schema version, lifetime and ownership. `validateAccountName` rejects anything that is not `/^[a-z_][a-z0-9_-]{0,31}$/`, checked before any `mkdir`, so `../etc` never becomes a directory. With `OMP_WEB_PASSWORD` set there is exactly one account; several accounts need the account file.
- `models.yml` and `config.yml` are per account under that account's agent directory. Skills stay globally readable as shared tooling, and writing them — global installs and updates included — is admin-only. Nothing is migrated: a new account starts empty on purpose, because copying the operator's `models.yml` would hand his API key to the first tenant.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable — but only for an admin. For any other account the candidate is checked against the account's own home with `isPathInUserHome()` and nothing is granted, because the allowlist lives in one process serving every operator: a grant made by one user would widen the filesystem for all of them, permanently.
- `allowFileRoot()` buckets grants per identity. A call without an identity lands in the unattributed bucket, which only admins can see.
- `/api/sessions` and `/api/terminal` filter by owner, and so do the `agent/running` snapshot and its event stream — the ids those two publish are what the rest of the API addresses things by, so leaving them unfiltered leaks through an open SSE channel. A foreign session or shell answers **404, not 403**: a 403 would confirm that the id exists, and the point of the filter is that another account's work is not merely unreadable but undiscoverable. Session ownership comes from the `cwd` in the session file, which means the sessions live in one shared tree owned by the account the service runs as — see the containment note below.
- `lib/sandbox.ts` is the one boundary here that the kernel enforces rather than this code: a tenant shell runs in a `bubblewrap` user namespace, and **exactly one `--bind`**, the tenant's own home, is the whole invariant. Everything else is either a read-only system directory or absent. Measured on the build host: a foreign home answers `No such file or directory` (not `Permission denied` — it is not mounted at all), `/etc/shadow` is `Permission denied`, `sudo -n true` reports that no new privileges flag is set, `su nobody` fails on the token, and `uid=0` in the namespace is not host root. Without root, sudo or `setpriv` the OS-user-per-account route is unavailable, which is why this exists.
- The sandbox refuses rather than guesses: a username that would escape its path segment is `bad-username`, a working directory outside the home is `cwd-outside-home`, and both come back with a remediation. Passing such a cwd through verbatim would only surface later as `[Process exited with code 1]` in the SSE stream. Missing `bwrap` or disabled user namespaces are **not** fatal — the shell opens unconfined, `sandboxed: false` in `GET /api/terminal` says so, and the key is never absent.
- None of the others are containment. Every one is an assignment decided from data the service process can write, so they stop an account from seeing another's work by accident and through the routes that exist, not against someone who edits the underlying files. `docs/authentication.md` says so in the place a reader of this file is pointed at.

### Plugins and skills
- `/api/plugins` drives omp's `PluginManager` (`~/.omp/plugins`): install, uninstall, enable/disable, plus `doctor()` output as diagnostics. omp has no in-place update, so "update" reinstalls the spec with `force`.
- `/api/skills` uses omp's own `loadSkills()`, so `.omp/skills`, `~/.omp/agent/skills`, `.claude/skills`, plugin skills and `.agents/skills` are listed exactly as a session sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent claude-code`. The `skills` CLI has no `omp` agent, and its `pi` agent writes `~/.pi/agent/skills`, which omp does **not** read; the Claude layout is discovered by default.

### Auth and model config
- Credentials live in omp's SQLite `agent.db` via `AuthStorage`, not in `auth.json`. Writes go through `authStorage.set()` / `remove()` / `logout()` so the CLI and omp-web share one store and one lock.
- Provider listing is capability-driven: `lib/provider-listing-runtime.ts` folds the catalog (`@oh-my-pi/pi-catalog`), the OAuth registry (`@oh-my-pi/pi-ai/oauth`) and stored credential types into the flat shape `lib/provider-listing.ts` expects, so a dual-auth provider appears exactly once. An OAuth login whose `storeCredentialsAs` differs from its id is keyed by the id the catalog uses.
- OAuth flows are streamed by `GET /api/auth/login/[provider]` through `authStorage.login()`; `onAuth`/`onPrompt`/`onManualCodeInput` become browser input requests with short-lived tokens stored in `globalThis.__ompLoginCallbacks`.
- API-key status endpoints must never return the raw key.
- `models.yml` is YAML: `/api/models-config` parses whichever of `models.yml` / `models.yaml` / `models.json` exists and always writes back `models.yml`.
- A header value in `models.yml` that names an environment variable is written as the **bare name** (`X-Token: MY_VAR`), not `$MY_VAR`.

### Password access is verified in the proxy, stored hashed, and shared with `bin/`
`bin/web-auth-store.js` is the single source of truth for the password lock, and
it is CommonJS in `bin/` on purpose: the launcher needs it before Bun is even
resolved, and `bin/` is the only directory (besides `.next`) in the published
npm `files` list, so `lib/` cannot hold it. `bin/web-auth-store.d.ts` is what the
TypeScript half type-checks against — keep the two in sync.

- The password is stored **only** as a scrypt digest in
  `<agentDir>/omp-web-auth.json` (`0600`, atomic replace). Nothing can read it
  back, which is why `/recover` and `--reset-password` exist.
- `proxy.ts` runs on Next.js 16's Node.js runtime (proxy always does), so
  `node:fs` and `node:crypto` are available there. Do **not** import the omp SDK
  into it — `next.config.ts` only externalizes `@oh-my-pi/*` for the server
  build, and the SDK cannot be bundled. That is why the store re-derives the
  agent directory instead of calling `getAgentDir()`.
- `resolveWebAuthPolicy()` distinguishes a missing credential file (unlocked)
  from an unreadable one (`unavailable` -> 503). Never collapse those: the
  second one failing open would silently unlock the server.
- Successful verifications are cached for five minutes keyed by the digest that
  accepted them, because scrypt runs on every request otherwise. The key
  includes the digest, so a password change invalidates the cache across
  bundles.
- `/recover` and `POST /api/web-access/recovery` are the only unauthenticated
  paths. They still go through the host allow-list and cross-site checks, and
  the recovery code is printed on the server's stdout, never returned in the
  response.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `omp-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to omp's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

### HTTP proxying
Bun's `fetch` reads `HTTP_PROXY` / `HTTPS_PROXY` **once at process start** and
never proxies loopback — which is what local providers need. It ignores
`NO_PROXY`. `lib/http-dispatcher.ts` is therefore a no-op under Bun; its undici
`EnvHttpProxyAgent` path only exists for a dev server run on Node, because Bun
resolves `undici` to its own shim where `setGlobalDispatcher` does not affect
`fetch` and `install` does not exist.

## omp Session File Format

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"model":"anthropic/claude-sonnet-5","role":"default","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`model_change` carries a `provider/modelId` string plus the **role** it came
from; `SessionContext.models` is a role → selector record, and `models.default`
is what the UI shows as the session's model.

---

## CSS Variables (`app/globals.css`)

Both themes come from omp's own theme files — `titanium` (omp's default dark
theme) and `light` — so the browser and the TUI read as one product.

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --accent-hover --user-bg --assistant-bg --tool-bg --bg-subtle
--success --danger --warning
--font-mono
```

`--font-mono` is a system stack on purpose: a local-first tool must not fetch a
font from a CDN at build or at runtime.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **omp-web** (2786 symbols, 7305 relationships, 233 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/omp-web/context` | Codebase overview, check index freshness |
| `gitnexus://repo/omp-web/clusters` | All functional areas |
| `gitnexus://repo/omp-web/processes` | All execution flows |
| `gitnexus://repo/omp-web/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
