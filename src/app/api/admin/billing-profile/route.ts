import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const configRecords = await db.select().from(systemConfigs).limit(1);
    const config = configRecords[0] || ({} as any);

    return NextResponse.json({
      platformName: config.platformName || '',
      platformGstin: config.platformGstin || '',
      platformAddress: config.platformAddress || '',
    });
  } catch (error) {
    return serverError(error, 'fetching billing profile');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const { platformName, platformGstin, platformAddress } = await req.json();

    const configRecords = await db.select().from(systemConfigs).limit(1);
    
    if (configRecords.length > 0) {
      await db.update(systemConfigs).set({
        platformName,
        platformGstin,
        platformAddress
      });
    } else {
      await db.insert(systemConfigs).values({
        platformName,
        platformGstin,
        platformAddress,
        smtpHost: '',
        smtpPort: 0,
        smtpUser: '',
        smtpPassword: '',
        smtpFrom: '',
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'updating billing profile');
  }
}
