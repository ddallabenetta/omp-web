import { NextResponse, type NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { isApiRequestAllowed } from "@/lib/request-security";
import { filePathFromSegments } from "@/lib/file-paths";
import {
  authorizeTransfer,
  destinationExists,
  isSameOrBelow,
  isWritePathAllowed,
} from "@/lib/write-access";
import { getRequestIdentity } from "@/lib/request-identity";

export const dynamic = "force-dynamic";

/**
 * Destructive file operations: move, copy, mkdir, rename, delete.
 *
 * These live in their own route rather than as more `type=` values on
 * `app/api/files/[...path]`, for two reasons. That file is already 700 lines and
 * carries the read and upload contracts; a destructive module that is easy to
 * read end to end is worth more than the shared prefix. And a separate module
 * makes the write boundary auditable in one place — every handler that can
 * destroy something is in this file, and every one of them opens with the same
 * two checks.
 *
 * The sibling path is a deliberate workaround: Next.js rejects a segment after
 * a catch-all, so `/api/files/[...path]/actions` will not build. Splitting the
 * prefix keeps the catch-all last in both routes.
 *
 * The path segment addresses the *source*. The destination arrives in the body
 * as an absolute path, because a move target is a directory the user picked,
 * not a relative step from the source.
 *
 * Every handler is refused unless the path is inside a *writable* root, which
 * is a strictly narrower set than the read allowlist — see lib/write-access.ts
 * for why reusing the read set here would be a hole rather than a shortcut.
 */

const MAX_COPY_BYTES = 512 * 1024 * 1024;

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

function isAbsolute(target: string): boolean {
  return path.isAbsolute(target);
}

/** An absolute destination under `targetDir`, named `name`. */
function destinationIn(targetDir: string, name: string): string {
  return path.join(targetDir, name);
}

/** The final path segment, rejecting "." and "..". */
function safeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (trimmed.includes("\0")) return null;
  return trimmed;
}

/** Total bytes a directory tree occupies, for the copy size guard. */
function treeSize(target: string): number {
  const stat = fs.lstatSync(target);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(target)) {
    total += treeSize(path.join(target, entry));
  }
  return total;
}

/**
 * Recursive copy. Deliberately does not follow symlinks: a symlink inside the
 * source is copied as a symlink, so a link pointing outside the project cannot
 * pull foreign content in through the copy.
 */
function copyTree(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.copyFileSync(source, destination);
  // copyFileSync does not carry the mode across on every platform, and an
  // executable losing +x is a real regression for a project the agent runs.
  fs.chmodSync(destination, stat.mode);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return errorResponse("Untrusted API request", 403);
  }

  try {
    const { path: segments } = await params;
    // Resolved once, before any path from the URL or the body is looked at.
    // Every handler below reaches `isWritePathAllowed`/`authorizeTransfer` with
    // this value and nothing else, so the source path and the destination in
    // the body cannot influence who is being authorized.
    const identity = getRequestIdentity(request.headers);
    if (!identity) return errorResponse("Access denied", 403);

    const source = filePathFromSegments(segments);
    const type = request.nextUrl.searchParams.get("type");
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return errorResponse("Request body must be a JSON object", 400);

    if (type === "mkdir") {
      const name = safeName(body.name);
      if (!name) return errorResponse("name must be a single path segment", 400);
      const target = destinationIn(source, name);
      if (destinationExists(target)) {
        return errorResponse(`"${name}" already exists here`, 409);
      }
      if (!(await isWritePathAllowed(target, { mustExist: false }, identity))) {
        return errorResponse("Access denied", 403);
      }
      fs.mkdirSync(target);
      return NextResponse.json({ ok: true, path: target });
    }

    if (type === "rename") {
      const name = safeName(body.name);
      if (!name) return errorResponse("name must be a single path segment", 400);
      const destination = destinationIn(path.dirname(source), name);
      if (source === destination) return NextResponse.json({ ok: true, path: source });
      if (destinationExists(destination)) {
        return errorResponse(`"${name}" already exists in this folder`, 409);
      }
      const auth = await authorizeTransfer(source, destination, "move", identity);
      if (!auth.ok) return errorResponse("Access denied", 403, { reason: auth.reason });
      // A directory cannot be renamed into itself or a descendant; the kernel
      // would reject it, but with an error the user cannot act on.
      if (isSameOrBelow(source, destination)) {
        return errorResponse("Cannot move a folder into itself", 400);
      }
      fs.renameSync(source, destination);
      return NextResponse.json({ ok: true, path: destination, previousPath: source });
    }

    if (type === "move" || type === "copy") {
      const targetDir = body.destination;
      if (typeof targetDir !== "string" || !isAbsolute(targetDir)) {
        return errorResponse("destination must be an absolute path", 400);
      }
      const destination = destinationIn(path.resolve(targetDir), path.basename(source));
      if (destination === source) {
        return NextResponse.json({ ok: true, path: source });
      }
      if (destinationExists(destination)) {
        return errorResponse(`"${path.basename(source)}" already exists at the destination`, 409);
      }

      const auth = await authorizeTransfer(source, destination, type, identity);
      if (!auth.ok) return errorResponse("Access denied", 403, { reason: auth.reason });

      // Copying or moving a folder into itself recurses until the disk is
      // full, and the size guard below would only notice after the writes
      // started.
      if (isSameOrBelow(source, destination)) {
        return errorResponse("Cannot copy or move a folder into itself", 400);
      }

      if (type === "copy") {
        const size = treeSize(source);
        if (size > MAX_COPY_BYTES) {
          return errorResponse(
            `Refusing to copy ${(size / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_COPY_BYTES / 1024 / 1024} MB`,
            413,
          );
        }
        copyTree(source, destination);
      } else {
        // renameSync is atomic within a filesystem and throws EXDEV across
        // one. A copy-then-delete fallback would leave a half-moved tree if the
        // process died in between, so a cross-device move is reported rather
        // than attempted.
        try {
          fs.renameSync(source, destination);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EXDEV") {
            return errorResponse(
              "Source and destination are on different filesystems, which a move cannot span",
              409,
            );
          }
          throw error;
        }
      }
      return NextResponse.json({ ok: true, path: destination, previousPath: type === "move" ? source : undefined });
    }

    return errorResponse(`Unknown action "${type ?? ""}"`, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return errorResponse("Not found", 404);
    if (code === "ENOTEMPTY") return errorResponse("Target folder is not empty", 409);
    if (code === "EACCES" || code === "EPERM") return errorResponse("Permission denied by the operating system", 403);
    return errorResponse(message, 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return errorResponse("Untrusted API request", 403);
  }

  try {
    const { path: segments } = await params;
    const target = filePathFromSegments(segments);

    // Same rule as POST: the identity is the only input to the decision, the
    // URL segment is only ever the thing being judged.
    const identity = getRequestIdentity(request.headers);
    if (!identity) return errorResponse("Access denied", 403);

    if (!(await isWritePathAllowed(target, { mustExist: true }, identity))) {
      return errorResponse("Access denied", 403);
    }

    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      // rmSync without recursive would fail on a populated folder. Recursive
      // deletion is the user's explicit action, and the writable-root check
      // above is what bounds it — but refuse the filesystem root outright,
      // because a root that somehow entered the writable set must not be
      // removable with one request.
      if (path.resolve(target) === path.parse(path.resolve(target)).root) {
        return errorResponse("Refusing to delete a filesystem root", 400);
      }
      fs.rmSync(target, { recursive: true, force: false });
    } else {
      fs.unlinkSync(target);
    }
    return NextResponse.json({ ok: true, path: target });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return errorResponse("Not found", 404);
    if (code === "ENOTEMPTY") return errorResponse("Target folder is not empty", 409);
    if (code === "EACCES" || code === "EPERM") return errorResponse("Permission denied by the operating system", 403);
    return errorResponse(message, 500);
  }
}
