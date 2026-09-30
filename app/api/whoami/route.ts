import { NextResponse } from "next/server";
import { getRequestIdentity, getUserHome } from "@/lib/request-identity";

/**
 * Wer ist angemeldet?
 *
 * Die Route liest die Identitaet, die `proxy.ts` an den Request gehaengt hat —
 * sonst nirgends. Sie ist damit der Nachweis, dass Schritt 1 verdrahtet ist:
 * gibt es diese Route nicht oder liefert sie `null`, dann ist die ganze Kette
 * aus Anmeldung, Cookie-Signatur und Proxy-Header nirgends angekommen.
 *
 * Sie steht bewusst nicht unter `/api/web-access/`. Der Bereich dort ist der
 * Passwort-Store, den man auch bedienen muss, wenn man noch gar nicht weiss,
 * wer man ist; diese Route ist eine reine Leseabfrage ueber die Identitaet und
 * gehoert deshalb nicht in die Verwaltung.
 */

export const dynamic = "force-dynamic";

export interface WhoAmIResponse {
  /** `null`, wenn der Request keine Identitaet trug. */
  user: { username: string; isAdmin: boolean; home: string } | null;
}

export async function GET(request: Request) {
  const identity = getRequestIdentity(request.headers);
  return NextResponse.json(
    { user: identity === null ? null : { ...identity, home: getUserHome(identity) } } satisfies WhoAmIResponse,
    { headers: { "Cache-Control": "no-store" } },
  );
}
