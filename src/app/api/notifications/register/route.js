import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { serverError } from '@/lib/routeError';

const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3000';
const NOTIFICATION_SERVICE_API_KEY = process.env.NOTIFICATION_SERVICE_API_KEY || '';

export async function POST(req) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { userId, fcmToken, platform } = await req.json();

    // Proxy to notification-service
    const res = await fetch(`${NOTIFICATION_SERVICE_URL}/api/v1/devices/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': NOTIFICATION_SERVICE_API_KEY,
        'x-tenant-id': user.tenantId,
      },
      body: JSON.stringify({
        userId: userId || user.id,
        fcmToken,
        platform: platform || 'web',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Notification service register error:', text);
      return NextResponse.json({ error: 'Registration failed' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error('Register device error:', error.message || error);
    
    // Gracefully handle connection errors if notification service isn't running
    if (error.code === 'ECONNREFUSED' || error.message?.includes('fetch failed')) {
      return NextResponse.json({ 
        success: false, 
        warning: 'Notification service is currently unavailable.' 
      }, { status: 200 }); // Return 200 so the frontend doesn't crash or show a console error
    }

    return serverError(error, 'registering this device for notifications');
  }
}
