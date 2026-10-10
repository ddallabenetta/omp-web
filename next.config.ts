import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let ompVersion = "unknown";
try {
  const ompPkgPath = join(__dirname, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
  ompVersion = (JSON.parse(readFileSync(ompPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

/**
 * The omp SDK is published as TypeScript sources and imports `bun:` builtins,
 * so webpack must never try to parse it: every `@oh-my-pi/*` request stays a
 * runtime import that Bun resolves itself.
 *
 * `serverExternalPackages` alone is not enough — it leaves the SDK's own
 * transitive entry points (`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog/...`)
 * inside the bundle — so the rule below is applied unconditionally to the
 * whole scope.
 */
const OMP_SDK_REQUEST = /^@oh-my-pi\//;

const nextConfig: NextConfig = {
  // Desktop builds (scripts/stage-desktop.mjs) redirect the production build
  // into src-tauri/server/.next so packaging never touches the dev `.next/`.
  distDir: process.env.OMP_WEB_DIST_DIR || ".next",
  outputFileTracingRoot: __dirname,
  serverExternalPackages: [
    "undici",
    "@oh-my-pi/pi-coding-agent",
    "@oh-my-pi/pi-agent-core",
    "@oh-my-pi/pi-ai",
    "@oh-my-pi/pi-catalog",
    "@oh-my-pi/pi-tui",
    "@oh-my-pi/pi-utils",
  ],

  experimental: {
    /**
     * `proxy.ts` matches `/api/:path*`, so Next refuses oversized bodies with
     * its default 10 MB limit before any route handler runs.
     *
     * A chat prompt carries its images inline as base64, which inflates them
     * by 4/3, so the documented allowance of 10 images × 10 MB could never
     * actually be sent. This value covers `MAX_ATTACHED_IMAGES_TOTAL_BYTES`
     * plus that inflation and a margin for the JSON envelope — the transport
     * is sized to the server-side budget, not the other way round.
     *
     * Keep in sync with `MIN_PROXY_CLIENT_MAX_BODY_SIZE` in
     * `lib/image-attachments.ts`; a test asserts they agree.
     */
    proxyClientMaxBodySize: "32mb",
  },
  webpack: (config, { isServer, nextRuntime }) => {
    if (!isServer || nextRuntime === "edge") {
      // instrumentation.ts has a Node-only dynamic import guarded by
      // NEXT_RUNTIME. Webpack still traces it for the browser fallback unless
      // the server-only module is explicitly excluded.
      config.resolve.alias["@/lib/http-dispatcher"] = false;
      return config;
    }
    const externals = Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean);
    config.externals = [
      ({ request }: { request?: string }, callback: (error?: unknown, result?: string) => void) => {
        // `import`, not `commonjs`: the SDK's package exports declare only an
        // `import` condition, so a `require()` of it cannot resolve at all.
        if (request && OMP_SDK_REQUEST.test(request)) return callback(undefined, `import ${request}`);
        return callback();
      },
      ...externals,
    ];
    return config;
  },
  // Allow the dev server to be reached over the loopback interface (the
  // browser tab connects to http://127.0.0.1:30141) and from LAN devices.
  allowedDevOrigins: ["127.0.0.1", "192.168.*.*"],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_OMP_VERSION: ompVersion,
  },
};

export default nextConfig;
