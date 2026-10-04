import { initializeApp, getApps } from "firebase/app";
import {
  getMessaging,
  getToken,
  isSupported,
  type Messaging,
} from "firebase/messaging";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

async function getFirebaseMessaging(): Promise<Messaging | null> {
  if (typeof window === "undefined") return null;

  const supported = await isSupported();
  if (!supported) return null;

  return getMessaging(app);
}

export async function enablePushNotifications() {
  if (typeof window === "undefined") {
    throw new Error("Notifications are only available in the browser.");
  }

  if (!("Notification" in window)) {
    throw new Error("This browser does not support notifications.");
  }

  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser does not support service workers.");
  }

  const permission = await Notification.requestPermission();

  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const messaging = await getFirebaseMessaging();

  if (!messaging) {
    throw new Error("Firebase notifications are not supported on this device.");
  }

  const registration = await navigator.serviceWorker.register(
    "/firebase-messaging-sw.js"
  );

 const vapidKey =
  process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY?.trim();

if (!vapidKey) {
  throw new Error("Firebase VAPID key is missing.");
}

if (!/^[A-Za-z0-9_-]{87}$/.test(vapidKey)) {
  throw new Error(
    `Firebase VAPID key is invalid. Length received: ${vapidKey.length}`
  );
}
  const token = await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: registration,
  });

  if (!token) {
    throw new Error("Firebase could not create a notification token.");
  }

  return token;
}