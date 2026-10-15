/**
 * The sign-in cookie, set exactly as /api/auth/verify-otp sets it — shared so
 * member activation (0071) signs the member in the same way rather than with
 * a second copy that drifts.
 */
import type { NextResponse } from 'next/server';
import { signToken } from '@/lib/auth';

export function setSessionCookie(
  response: NextResponse,
  req: Request,
  user: { id: string; role: string },
): NextResponse {
  response.cookies.set({
    name: 'auth_token',
    value: signToken({ userId: user.id, role: user.role }),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
      && (req.url.startsWith('https://') || req.headers.get('x-forwarded-proto') === 'https'),
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  });
  return response;
}
