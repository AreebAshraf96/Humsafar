importScripts(
  "https://www.gstatic.com/firebasejs/12.4.0/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/12.4.0/firebase-messaging-compat.js"
);

firebase.initializeApp({
  apiKey: "AIzaSyD97NZtSNT0tuiTQzcKh_ngScx4RPAsP7g",
  authDomain: "humsafar-9e750.firebaseapp.com",
  projectId: "humsafar-9e750",
  storageBucket: "humsafar-9e750.firebasestorage.app",
  messagingSenderId: "446094268846",
  appId: "1:446094268846:web:599adc1890bca01a83503f",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title =
    payload.notification?.title ||
    "Humsafar";

  const options = {
    body:
      payload.notification?.body ||
      "You have a new Humsafar update.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: payload.data || {},
  };

  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target =
    event.notification.data?.url || "/";

  event.waitUntil(
    clients.openWindow(target)
  );
});