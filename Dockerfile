# omp-web serves its API on Bun, not Node: the omp SDK (`@oh-my-pi/pi-*`) is
# published as TypeScript sources that import `bun:` builtins, so both stages
# start from the Bun release that package.json's `engines.bun` floor requires.
ARG BUN_VERSION=1.3.14

# ---------------------------------------------------------------------------
# Build: install dependencies and produce the Next.js production build.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS build

WORKDIR /app

# Manifests first, so the dependency layer is reused until they actually change.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ---------------------------------------------------------------------------
# Runtime: the built app, its dependencies, and the CLI that launches them.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-debian AS runtime

# git is a runtime dependency, not a build-time one: the worktree switcher, the
# diff view and skill updates all shell out to it (lib/worktree.ts,
# lib/git-changes.ts, lib/skill-updates.ts).
#
# bubblewrap is one too, for the same reason: without it every terminal in the
# container takes the `bwrap-missing` branch of lib/sandbox.ts and runs
# unisolated with nothing but a `console.warn`. Measured on the base image:
# `command -v bwrap` prints nothing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Bind mounts keep their host ownership, so the container user has to match the
# user that owns `~/.omp` and the project checkouts on the host. 1000 is the
# usual first human account on Linux; override for anything else:
#   docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g) .
# Docker Desktop on macOS and Windows remaps ownership itself and needs neither.
ARG UID=1000
ARG GID=1000
RUN groupadd --gid "${GID}" omp \
 && useradd --uid "${UID}" --gid "${GID}" --create-home --home-dir /home/omp omp \
 && mkdir -p /home/omp/.omp/agent /workspace \
 && chown -R omp:omp /home/omp /workspace

WORKDIR /app

# node_modules ships as-is rather than being pruned: `serverExternalPackages`
# and the webpack externals rule in next.config.ts deliberately keep every
# `@oh-my-pi/*` import out of the bundle, so the SDK must exist on disk when
# the API routes run.
COPY --from=build --chown=omp:omp /app/node_modules ./node_modules
COPY --from=build --chown=omp:omp /app/.next ./.next
COPY --from=build --chown=omp:omp /app/public ./public
COPY --from=build --chown=omp:omp /app/bin ./bin
COPY --from=build --chown=omp:omp /app/next.config.ts /app/package.json ./

# OMP_WEB_HOSTNAME binds every interface because a container is only reachable
# from outside when it does; publish the port to 127.0.0.1 on the host to keep
# it local. OMP_WEB_NO_OPEN because there is no browser in here to open.
ENV HOME=/home/omp \
    NODE_ENV=production \
    PORT=30141 \
    OMP_WEB_HOSTNAME=0.0.0.0 \
    OMP_WEB_NO_OPEN=1

# `~/.omp/agent` is the directory the omp CLI writes: mount the host's copy here
# and a terminal session continues in the browser. `/workspace` is the default
# project root, and is where relative project paths resolve.
VOLUME ["/home/omp/.omp"]
EXPOSE 30141

USER omp
# Not /app: the launcher records its own cwd as OMP_WEB_LAUNCH_CWD so relative
# project paths in the browser resolve against it.
WORKDIR /workspace

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD bun --eval 'const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 30141}/`); process.exit(r.status < 500 ? 0 : 1)'

# The published CLI, so the container honours the same flags and environment
# variables as a local `omp-web` — including `--authenticated`.
ENTRYPOINT ["bun", "/app/bin/omp-web.js"]
