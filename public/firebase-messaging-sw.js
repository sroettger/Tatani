importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
firebase.initializeApp(Object.fromEntries(new URL(self.location).searchParams));
const messaging = firebase.messaging();

// Flashcards arrive as data-only messages so the whole review happens inside the notification.
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  if (!d.delivery_id) return;
  return self.registration.showNotification(`Tatani · ${d.word}`, {
    body: [d.prompt, ...JSON.parse(d.quiz_options || '[]').map((option, i) => `${i === 0 ? 'A' : 'B'}. ${option}`)].join('\n'),
    tag: d.delivery_id, icon: '/icon-192.png', renotify: true, requireInteraction: true,
    data: { ...d, stage: d.quiz_options ? 'quiz' : 'prompt' },
    actions: d.quiz_options ? [{ action: 'answer_0', title: `A. ${JSON.parse(d.quiz_options)[0]}` }, { action: 'answer_1', title: `B. ${JSON.parse(d.quiz_options)[1]}` }] : [{ action: 'reveal', title: d.l_reveal }],
  });
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  if (!d.delivery_id) return;
  n.close();
  if (d.stage === 'quiz') {
    if (event.action !== 'answer_0' && event.action !== 'answer_1') return event.waitUntil(self.clients.openWindow(d.path));
    event.waitUntil((async () => {
      try {
        const response = await fetch(d.api, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'quiz_answer', delivery_id: d.delivery_id, token: d.token, answer: Number(event.action.slice(-1)) }),
        });
        if (!response.ok) throw new Error('Review failed');
        const result = await response.json();
        // Same notification tag, silent feedback, no second review or grading step.
        await self.registration.showNotification(`Tatani · ${result.correct ? d.l_correct : d.l_incorrect}`, {
          body: `${d.word} — ${result.meaning}`, tag: d.delivery_id, icon: '/icon-192.png', renotify: false,
          data: { ...d, stage: 'done' },
        });
      } catch {
        await self.clients.openWindow(d.path);
      }
    })());
    return;
  }
  if (d.stage === 'done') return;
  const showAnswer = () => self.registration.showNotification(`${d.word}${d.reading && d.reading !== d.word ? ` (${d.reading})` : ''}`, {
    body: [d.meaning, d.example].filter(Boolean).join('\n'), tag: d.delivery_id, icon: '/icon-192.png', requireInteraction: true,
    data: { ...d, stage: 'answer' },
    actions: [{ action: 'yes', title: d.l_yes }, { action: 'no', title: d.l_no }],
  });
  const review = (remembered) => fetch(d.api, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'notification_review', delivery_id: d.delivery_id, token: d.token, remembered }),
  }).then(response => { if (!response.ok) throw new Error('Review failed'); }).catch(() => self.clients.openWindow(d.path));
  if (event.action === 'yes' || event.action === 'no') return event.waitUntil(review(event.action === 'yes'));
  // Body tap or Reveal: reveal in place; tapping a revealed card opens the full review page.
  if (d.stage === 'prompt') return event.waitUntil(showAnswer());
  event.waitUntil(self.clients.openWindow(d.path));
});
