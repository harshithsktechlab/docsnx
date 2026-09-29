import { getMessagingInstance } from './firebase';
import { getToken } from 'firebase/messaging';

const getApiUrl = () => {
  if (typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_NOTIFICATION_API_URL) {
    return process.env.NEXT_PUBLIC_NOTIFICATION_API_URL;
  }
  return '/api/v1/devices/register';
};

const extractTenantId = (explicitId?: string) => {
  if (explicitId && explicitId !== 'default') return explicitId;
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.startsWith('192.168.')) {
      const parts = hostname.split('.');
      if (parts.length >= 3) return parts[0];
    }
  }
  return explicitId || 'docsnx';
};

export const usePushNotifications = () => {
  const registerDevice = async (userId: string, tenantId?: string) => {
    const messaging = await getMessagingInstance();
    if (!messaging) return;
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const swRegistration = await navigator.serviceWorker.ready;
        const token = await getToken(messaging, { 
          vapidKey: "BE5XvrW7JSiboo3sB3ix0cnzXfvytDql2N5RwmpL4wJKpoaP1nznvWS0cqXTgY3NwpRp1Wx-FdxDRWtlvSdL0RQ",
          serviceWorkerRegistration: swRegistration
        });
        
        if (token) {
          await fetch(getApiUrl(), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': 'supersecretkey',
              'x-tenant-id': extractTenantId(tenantId)
            },
            body: JSON.stringify({ userId, fcmToken: token, platform: 'web' })
          });
          console.log('Push notifications enabled and token registered.');
        }
      } else {
        console.warn('Notification permission denied.');
      }
    } catch (err) {
      console.error('Failed to enable push notifications:', err);
    }
  };
  return { registerDevice };
};
