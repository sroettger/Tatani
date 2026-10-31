importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
firebase.initializeApp(Object.fromEntries(new URL(self.location).searchParams));
const messaging = firebase.messaging();

// Flashcards arrive as data-only messages so the whole review happens inside the notification.
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  if (!d.delivery_id) return;
  return self.registration.showNotification(`Tatani · ${d.word}`, {
    body: d.prompt, tag: d.delivery_id, icon: '/icon-192.png', renotify: true, requireInteraction: true,
    data: { ...d, stage: 'prompt' },
    actions: [{ action: 'reveal', title: d.l_reveal }],
  });
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  if (!d.delivery_id) return;
  n.close();
  const showAnswer = () => self.registration.showNotification(`${d.word}${d.reading && d.reading !== d.word ? ` (${d.reading})` : ''}`, {
    body: [d.meaning, d.example].filter(Boolean).join('\n'), tag: d.delivery_id, icon: '/icon-192.png', requireInteraction: true,
    data: { ...d, stage: 'answer' },
    actions: [{ action: 'yes', title: d.l_yes }, { action: 'no', title: d.l_no }],
  });
  const review = (remembered) => fetch(d.api, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'notification_review', delivery_id: d.delivery_id, token: d.token, remembered }),
  }).catch(() => self.clients.openWindow(d.path));
  if (event.action === 'yes' || event.action === 'no') return event.waitUntil(review(event.action === 'yes'));
  // Body tap or Reveal: reveal in place; tapping a revealed card opens the full review page.
  if (d.stage === 'prompt') return event.waitUntil(showAnswer());
  event.waitUntil(self.clients.openWindow(d.path));
});
