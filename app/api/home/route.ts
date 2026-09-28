import { NextResponse } from "next/server";
import os from "os";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ home: os.homedir() });
}