export const dynamic = 'force-dynamic';
import { NextRequest,  NextResponse } from 'next/server';
import { serverError } from '@/lib/routeError';

export async function GET(req: NextRequest) {
  try {
    // Access all parameters as an object
    const queryParams = Object.fromEntries(req.nextUrl.searchParams.entries());
    console.log("Webhook verification request:", queryParams);
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    const mode = req.nextUrl.searchParams.get("hub.mode");
    const token = req.nextUrl.searchParams.get("hub.verify_token");
    const challenge = req.nextUrl.searchParams.get("hub.challenge");

    console.log("Webhook verification request:", { mode, token, challenge });
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return NextResponse.json({ challenge });
    }

    return NextResponse.json(
      { error: 'Forbidden: Invalid or missing token' },
      { status: 403 }
    );

  } catch (error) {
    // See the note in auth/verify-otp: `details` was the raw throw message.
    return serverError(error, 'Invalid request to WhatsApp webhook verification endpoint');
  }
}
