import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import type { Subprocess } from "bun";

export type TerminalStatus = "running" | "exited";

export interface TerminalInfo {
  id: string;
  cwd: string;
  pid: number;
  status: TerminalStatus;
  exitCode: number | null;
  shell: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
}

interface TerminalRecord {
  info: TerminalInfo;
  child: Subprocess;
  streams: Set<WritableStreamDefaultWriter<Uint8Array>>;
  pendingData: Buffer[];
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

declare global {
  // Stored on globalThis so Next.js hot-reload in dev mode does not wipe
  // existing child processes (each module reload otherwise restarts the
  // manager and leaves orphan shells behind).
  var __ompTerminalManager: TerminalManager | undefined;
}

export class TerminalManager {
  private terminals = new Map<string, TerminalRecord>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor() {
    if (!globalThis.__ompTerminalManager) {
      globalThis.__ompTerminalManager = this;
      const exitHandler = () => this.killAll();
      process.once("SIGTERM", exitHandler);
      process.once("SIGINT", exitHandler);
      process.once("exit", exitHandler);
    }
    this.scheduleIdleSweep();
    return globalThis.__ompTerminalManager!;
  }

  private scheduleIdleSweep(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, record] of this.terminals) {
        if (record.info.status !== "running") continue;
        if (now - record.info.lastActivityAt > IDLE_TIMEOUT_MS) {
          console.warn(`[terminal] killing idle session ${id}`);
          this.kill(id).catch(() => undefined);
        }
      }
    }, 60 * 1000);
    this.idleTimer.unref?.();
  }

  // Spawn a real PTY-backed shell via `script(1)`. `@lydell/node-pty`,
  // `node-pty`, and Bun.Terminal are all unusable from a Bun server process
  // today (SIGHUP on spawn, no Linux prebuilds, or no readable stream),
  // but `script` is a standard Linux util that allocates a PTY for its child
  // and pipes the master side through stdin/stdout. That gives bash proper
  // line discipline, prompts that re-render on resize, and nested shells.
  async spawn(cwd: string, cols = 80, rows = 24): Promise<TerminalInfo> {
    const isWindows = os.platform() === "win32";
    const shell = process.env.SHELL?.trim() || (isWindows ? "powershell.exe" : "bash");
    const id = randomUUID();
    const startedAt = Date.now();

    let cmd: string[];
    if (isWindows) {
      cmd = [shell];
    } else {
      // `script -qfc <cmd> /dev/null` runs <cmd> in a fresh PTY with the
      // typescript log discarded. The inner PS1 prints a one-line banner so
      // the user sees immediate feedback that the terminal is alive.
      const inner = `printf '\\033[36m[omp-web terminal]\\033[0m ready in %s (shell=%s pid=%s, %dx%d)\\n' "$PWD" "$0" "$$" "${cols}" "${rows}"; export PS1='\\[\\033[36m\\]\\$ \\[\\033[0m\\]'; exec ${shell} -i`;
      cmd = ["/usr/bin/script", "-qfc", inner, "/dev/null"];
    }

    const child = Bun.spawn({
      cmd,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        COLUMNS: String(cols),
        LINES: String(rows),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const info: TerminalInfo = {
      id,
      cwd,
      pid: child.pid,
      status: "running",
      exitCode: null,
      shell,
      cols,
      rows,
      createdAt: startedAt,
      lastActivityAt: startedAt,
    };

    const record: TerminalRecord = {
      info,
      child,
      streams: new Set(),
      pendingData: [],
    };
    this.terminals.set(id, record);

    const pipeOutput = async (stream: ReadableStream<Uint8Array>) => {
      try {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          record.info.lastActivityAt = Date.now();
          if (record.streams.size === 0) {
            record.pendingData.push(Buffer.from(value));
            let total = record.pendingData.reduce((sum, c) => sum + c.length, 0);
            while (total > 64 * 1024 && record.pendingData.length > 1) {
              total -= record.pendingData.shift()!.length;
            }
          } else {
            for (const writer of record.streams) {
              this.safeWrite(writer, Buffer.from(value));
            }
          }
        }
      } catch {
        // Stream closed; ignore.
      }
    };

    void pipeOutput(child.stdout);
    void pipeOutput(child.stderr);

    child.exited.then((exitCode) => {
      record.info.status = "exited";
      record.info.exitCode = exitCode;
      record.info.lastActivityAt = Date.now();
      const exitMsg = Buffer.from(
        `\n[Process exited with code ${exitCode}]\n`,
        "utf-8",
      );
      for (const writer of record.streams) {
        this.safeWrite(writer, exitMsg);
        try { writer.close().catch(() => undefined); } catch { /* ignore */ }
      }
      record.streams.clear();
    });

    return info;
  }

  list(): TerminalInfo[] {
    return Array.from(this.terminals.values())
      .map((r) => r.info)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): TerminalInfo | null {
    return this.terminals.get(id)?.info ?? null;
  }

  async write(id: string, data: string): Promise<void> {
    const record = this.requireRecord(id);
    if (record.info.status !== "running") {
      throw new Error(`Terminal ${id} has exited`);
    }
    const stdin = record.child.stdin as unknown as WritableStreamDefaultWriter<Uint8Array>;
    await stdin.write(new TextEncoder().encode(data));
    record.info.lastActivityAt = Date.now();
  }

  async resize(_id: string, cols: number, rows: number): Promise<void> {
    if (cols < 2 || rows < 1) throw new Error("Invalid terminal size");
    // Non-PTY runs ignore SIGWINCH; we keep the values for the UI's sake
    // and so future PTY implementations can wire through.
    void cols; void rows;
  }

  async kill(id: string): Promise<void> {
    const record = this.terminals.get(id);
    if (!record) return;
    if (record.info.status === "running") {
      try { record.child.kill(); } catch { /* may have already exited */ }
    }
    this.terminals.delete(id);
  }

  private killAll(): void {
    for (const id of Array.from(this.terminals.keys())) {
      try { this.kill(id); } catch { /* ignore */ }
    }
  }

  attach(id: string, writer: WritableStreamDefaultWriter<Uint8Array>): () => void {
    const record = this.requireRecord(id);
    record.streams.add(writer);
    if (record.pendingData.length > 0) {
      for (const chunk of record.pendingData) this.safeWrite(writer, chunk);
      record.pendingData.length = 0;
    }
    return () => {
      record.streams.delete(writer);
    };
  }

  private requireRecord(id: string): TerminalRecord {
    const record = this.terminals.get(id);
    if (!record) throw new Error(`Unknown terminal session: ${id}`);
    return record;
  }

  private safeWrite(writer: WritableStreamDefaultWriter<Uint8Array>, data: Buffer): void {
    try {
      writer.write(new Uint8Array(data)).catch(() => {
        // Client disconnected.
      });
    } catch {
      // Stream closed.
    }
  }
}

let _manager: TerminalManager | null = null;
export function getTerminalManager(): TerminalManager {
  if (!_manager) _manager = new TerminalManager();
  return _manager;
}

export function resolveDefaultShellCwd(cwd: string): string {
  return path.isAbsolute(cwd) ? cwd : process.cwd();
}
