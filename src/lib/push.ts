import { getApps, initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';
import { db } from './db';
import { userDevices } from '../db/schema';
import { eq } from 'drizzle-orm';

export function getFirebaseAdmin() {
  if (!getApps().length) {
    try {
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({
          credential: cert(serviceAccount)
        });
      } else {
        // Fallback for default environment credentials (e.g. Google Cloud)
        initializeApp({
          credential: applicationDefault()
        });
      }
    } catch (error) {
      console.warn("Failed to initialize Firebase Admin SDK. Push notifications will not work.", error);
    }
  }
  return true;
}

export async function sendPushNotification(userId: string, title: string, body: string, url?: string) {
  try {
    getFirebaseAdmin();
    if (!getApps().length) {
      console.warn('Firebase Admin not initialized, skipping push notification.');
      return;
    }

    // Fetch user's registered devices
    const devices = await db.select().from(userDevices).where(eq(userDevices.userId, userId));
    if (devices.length === 0) return;

    const tokens = devices.map(d => d.fcmToken);

    const message: MulticastMessage = {
      tokens,
      notification: {
        title,
        body,
      },
      data: {
        url: url || '/dashboard'
      },
      // Webpush specific options can be added here if needed
      webpush: {
        notification: {
          icon: '/icon-192.png',
        }
      }
    };

    const response = await getMessaging().sendEachForMulticast(message);
    
    // Clean up stale tokens
    if (response.failureCount > 0) {
      const failedTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          if (
            resp.error.code === 'messaging/invalid-registration-token' ||
            resp.error.code === 'messaging/registration-token-not-registered'
          ) {
            failedTokens.push(tokens[idx]);
          }
        }
      });

      if (failedTokens.length > 0) {
        // Delete stale tokens
        for (const token of failedTokens) {
          await db.delete(userDevices).where(eq(userDevices.fcmToken, token));
        }
        console.log(`Cleaned up ${failedTokens.length} stale FCM tokens.`);
      }
    }
  } catch (error) {
    console.error("Error sending push notification:", error);
  }
}
