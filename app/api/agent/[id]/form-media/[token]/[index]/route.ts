import { getRpcSession } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/form-media/[token]/[index] - a picture of an open ask form.
// The model's <img>/<svg> sources stay on the server: it loads the picture with
// the SDK's own loader and serves the bytes, so the browser never contacts a
// host the model chose. The form's token only exists while its dialog is open.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; token: string; index: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted API request", { status: 403 });
  }
  const { id, token, index } = await params;
  const mediaIndex = Number(index);
  if (!Number.isSafeInteger(mediaIndex) || mediaIndex < 0) {
    return new Response("Bad picture index", { status: 400 });
  }

  const session = getRpcSession(id);
  if (!session || !session.isAlive()) {
    return new Response("Session not found", { status: 404 });
  }

  try {
    const media = await session.loadFormMedia(token, mediaIndex, req.signal);
    if (!media) return new Response("Picture not found", { status: 404 });
    return new Response(media.bytes as BodyInit, {
      headers: {
        "Content-Type": media.mime,
        "Cache-Control": "no-store",
        // A drawing is only ever shown through <img>; these keep it inert if opened directly.
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Picture failed to load", { status: 422 });
  }
}
