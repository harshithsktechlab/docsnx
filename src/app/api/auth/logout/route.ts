import { NextResponse } from 'next/server';
import { serverError } from '@/lib/routeError';

export async function POST(req: Request) {
  try {
    const response = NextResponse.json({ success: true });
    
    response.cookies.delete('auth_token');
    return response;
  } catch (error) {
    return serverError(error, 'signing out');
  }
}
