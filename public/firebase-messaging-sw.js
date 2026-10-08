importScripts('https://www.gstatic.com/firebasejs/12.4.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.4.0/firebase-messaging-compat.js');
importScripts('/api/firebase-config');
firebase.initializeApp(self.HUMSAFAR_FIREBASE_CONFIG);

function account(write, value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('humsafar-push-privacy', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('settings', write ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('settings');
      const operation = write ? store.put(value, 'account') : store.get('account');
      transaction.oncomplete = () => { db.close(); resolve(write ? value : operation.result); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type === 'HUMSAFAR_ACCOUNT') {
    event.waitUntil(account(true, event.data.userId || null).then(async () => {
      const notifications = await self.registration.getNotifications();
      notifications.forEach(notification => notification.close());
      event.ports[0]?.postMessage({ ok: true });
    }));
  }
});
firebase.messaging().onBackgroundMessage(async payload => {
  // Data-only pushes never auto-display. Fail closed on logout or account switch.
  const active = await account(false).catch(() => null);
  if (!active || payload.data?.userId !== active) return;
  await self.registration.showNotification(payload.data.title || 'Humsafar', {
    body: payload.data.body || 'Your trip has an update.',
    icon: '/favicon.svg', tag: payload.messageId,
    data: { url: '/' },
  });
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
