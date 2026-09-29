import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { userDevices } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getUserFromRequest } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { fcmToken, platform } = body;

    if (!fcmToken) {
      return NextResponse.json({ error: "FCM token is required" }, { status: 400 });
    }

    const tenantId = user.tenantId;
    const userId = user.id;

    // Check if token already exists
    const existingDevice = await db.select().from(userDevices).where(eq(userDevices.fcmToken, fcmToken)).limit(1);

    if (existingDevice.length > 0) {
      // Update last active if it belongs to same user
      if (existingDevice[0].userId === userId) {
        await db.update(userDevices)
          .set({ lastActiveAt: new Date() })
          .where(eq(userDevices.fcmToken, fcmToken));
      } else {
        // If it belongs to a different user, reassign it
        await db.update(userDevices)
          .set({ userId, tenantId, lastActiveAt: new Date(), platform: platform || 'web' })
          .where(eq(userDevices.fcmToken, fcmToken));
      }
    } else {
      // Insert new device
      await db.insert(userDevices).values({
        tenantId,
        userId,
        fcmToken,
        platform: platform || 'web',
      });
    }

    return NextResponse.json({ success: true, message: "Device registered for push notifications." });
  } catch (error: any) {
    console.error("Device registration error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
