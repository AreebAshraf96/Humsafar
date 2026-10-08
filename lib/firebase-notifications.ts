import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, deleteToken, isSupported } from 'firebase/messaging';

export async function messaging() {
  if (typeof window === 'undefined' || !await isSupported()) return null;
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
  if (!config.projectId || !config.apiKey) throw new Error('Notifications are not configured yet.');
  return getMessaging(getApps()[0] || initializeApp(config));
}

export async function setPushAccount(userId: string | null) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration?.active) return;
  // Upgrade the previous worker (which did not understand account logout).
  await registration.update().catch(() => undefined);
  const installing = registration.installing || registration.waiting;
  if (installing && installing.state !== 'activated') await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Notification update is still installing. Please retry.')), 8000);
    installing.addEventListener('statechange', () => {
      if (installing.state === 'activated') { clearTimeout(timer); resolve(); }
      if (installing.state === 'redundant') { clearTimeout(timer); reject(new Error('Could not update notifications.')); }
    });
  });
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not update device notification privacy. Please retry.')), 5000);
    channel.port1.onmessage = () => { clearTimeout(timer); resolve(); };
    registration.active!.postMessage({ type: 'HUMSAFAR_ACCOUNT', userId }, [channel.port2]);
  });
  channel.port1.close();
}

export async function enablePushNotifications() {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) throw new Error('This browser does not support notifications.');
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notification permission was not granted.');
  const instance = await messaging();
  if (!instance) throw new Error('Notifications are not supported on this device.');
  await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  const registration = await navigator.serviceWorker.ready;
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY?.trim();
  if (!vapidKey || !/^[A-Za-z0-9_-]{87}$/.test(vapidKey)) throw new Error('Firebase VAPID key is missing or invalid.');
  const token = await getToken(instance, { vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error('Could not register notifications.');
  return token;
}

export async function removePushToken() {
  const instance = await messaging();
  if (instance) await deleteToken(instance);
}
