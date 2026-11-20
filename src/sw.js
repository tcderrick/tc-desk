// Shows TC Desk notifications when the app is closed.
import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
const app = initializeApp({
  apiKey: 'AIzaSyBj-SgpUHdzVjZQPDeTj-PxFdYgH6tvROo', authDomain: 'tc-desk.firebaseapp.com', projectId: 'tc-desk',
  storageBucket: 'tc-desk.firebasestorage.app', messagingSenderId: '836507322815', appId: '1:836507322815:web:8fd4240539c259ffe0390a'
});
const messaging = getMessaging(app);
onBackgroundMessage(messaging, () => { /* the notification in the message is shown automatically */ });
self.addEventListener('notificationclick', e => {
  const link = (e.notification && e.notification.data && e.notification.data.FCM_MSG && e.notification.data.FCM_MSG.fcmOptions && e.notification.data.FCM_MSG.fcmOptions.link) || '/';
  if (link === '/') { e.notification.close(); e.waitUntil(clients.openWindow('/')); }
});
