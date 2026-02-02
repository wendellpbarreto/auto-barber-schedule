import { NextResponse } from "next/server";
import { runBooking } from "@/lib/cashbarber";

export async function POST() {
  try {
    const result = await runBooking();
    return NextResponse.json(
      {
        ok: true,
        scheduled: true,
        results: result.results,
      },
      { status: 200 }
    );
  } catch (err) {
    const status = err.status || (err.message?.includes("Auth") ? 401 : 400);
    return NextResponse.json(
      {
        ok: false,
        error: err.message,
        ...(err.response && { response: err.response }),
      },
      { status: typeof status === "number" ? status : 400 }
    );
  }
}
