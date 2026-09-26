#!/usr/bin/env node
"use strict";

const {
  getMissingBunMessage,
  getUnsupportedBunVersionMessage,
  getUnsupportedNodeVersionMessage,
  isBunVersionSupported,
  isNodeVersionSupported,
  resolveBunPath,
  withLoopbackNoProxy,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./runtime");

if (process.versions.bun && !isBunVersionSupported(process.versions.bun)) {
  console.error(getUnsupportedBunVersionMessage(process.versions.bun));
  process.exit(1);
}

if (!process.versions.bun && !isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./omp-web-options");
const {
  getWebAuthStatus,
  resolveWebAuthFile,
  setWebPassword,
  setWebPasswordEnabled,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./web-auth-store");
const {
  PromptAbortedError,
  isInteractive,
  readNewPassword,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./password-prompt");

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

// Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
// may not exist when installed via npx/bunx).
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  // Fallback: locate next package root and derive the bin path manually.
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}


const { port, hostname, openBrowser, authenticated, resetPassword } = parseLaunchOptions();
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// Resolved once here and handed to the server through the environment, so the
// launcher and the Next.js process can never disagree about which credential
// file is in force.
const webAuthFile = resolveWebAuthFile();

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please report this issue.");
  process.exit(1);
}

const bunPath = resolveBunPath();
if (!bunPath) {
  console.error(getMissingBunMessage());
  process.exit(1);
}

/** Refuse to hang on a password prompt nobody is there to answer. */
function requireTerminal(flag) {
  if (isInteractive()) return;
  throw new Error([
    `${flag} has to ask for a password, but omp-web is not attached to a terminal.`,
    "Run omp-web once interactively to set the password, or pass OMP_WEB_PASSWORD in the environment.",
  ].join("\n"));
}

async function setPasswordInteractively(intro) {
  console.log(intro);
  console.log(`It is stored as a scrypt hash in ${webAuthFile} — omp-web never keeps the password itself.`);
  const password = await readNewPassword();
  const status = setWebPassword(password, { file: webAuthFile });
  console.log(`Password saved. omp-web now asks for the username "${status.username}" and this password.`);
}

/**
 * Settle password access before the server starts.
 *
 * A run that was asked to be locked must never come up unlocked, so the
 * credential is written first and `next start` is spawned afterwards.
 */
async function configurePasswordAccess() {
  const status = getWebAuthStatus({ file: webAuthFile });

  if (resetPassword) {
    if (status.managedByEnvironment) {
      console.warn(
        "Warning: OMP_WEB_PASSWORD is set and takes precedence over the stored password. Unset it for this reset to have any effect.",
      );
    }
    requireTerminal("--reset-password");
    await setPasswordInteractively("Setting a new omp-web password.");
    return;
  }

  if (!authenticated) return;

  if (status.managedByEnvironment) {
    console.log("Password access is already required: OMP_WEB_PASSWORD is set.");
    return;
  }
  if (status.stored) {
    if (!status.enabled) {
      setWebPasswordEnabled(true, { file: webAuthFile });
      console.log("Password access enabled with the password already stored on this machine.");
    }
    return;
  }

  requireTerminal("--authenticated");
  await setPasswordInteractively("--authenticated was requested and no omp-web password has been set yet.");
}

function warnAboutExposure() {
  if (loopbackHostnames.has(hostname)) return;
  if (getWebAuthStatus({ file: webAuthFile }).enabled) {
    console.warn(
      `Warning: omp-web is listening on ${hostname} with Basic Auth over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
    );
  } else {
    console.warn(
      `Warning: omp-web is listening on ${hostname} without authentication. Only use this on a trusted network, or start it with --authenticated.`,
    );
  }
}

function startServer() {
  warnAboutExposure();

  // `--bun` forces Bun's own runtime for next's CLI entry (it would otherwise
  // hand shebang'd scripts to node). The omp SDK ships TypeScript sources and
  // `bun:` builtins, so the API routes only resolve under Bun.
  const child = spawn(bunPath, ["--bun", nextBin, "start", "-p", port, "-H", hostname], {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: {
      ...withLoopbackNoProxy(process.env),
      OMP_WEB_HOSTNAME: hostname,
      OMP_WEB_AUTH_FILE: webAuthFile,
      // Preserve the directory from which `omp-web` was launched so relative
      // project paths in the browser resolve against the user's shell cwd.
      OMP_WEB_LAUNCH_CWD: process.cwd(),
    },
  });

  child.on("error", (error) => {
    console.error(`Failed to launch omp-web through Bun (${bunPath}): ${error.message}`);
    process.exit(1);
  });

  let browserOpened = false;
  const url = `http://${hostname}:${port}`;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (openBrowser && !browserOpened && text.includes("Ready")) {
      browserOpened = true;
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";
      const openCmd = isWindows ? "start" : isMac ? "open" : "xdg-open";
      const opener = spawn(openCmd, [url], {
        shell: isWindows,
        stdio: "ignore",
        detached: true,
      });

      opener.on("error", (error) => {
        console.warn(`Could not open browser automatically: ${error.message}`);
      });

      opener.unref();
    }
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

configurePasswordAccess().then(startServer, (error) => {
  if (error instanceof PromptAbortedError) process.exit(130);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
