importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
importScripts('./push-answer-outbox.js');
firebase.initializeApp(Object.fromEntries(new URL(self.location).searchParams));
const messaging = firebase.messaging();
const outbox = self.TataniPushOutbox.createOutbox();
const SYNC_TAG = 'tatani-push-answers';
const ICON_URL = new URL('./icon-192.png', self.location).pathname;
// Activate updated notification handling right away instead of waiting for the old worker to idle.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// Show the hiragana reading next to the word when it differs (kanji words).
const wordLabel = (d) => `${d.word}${d.reading && d.reading !== d.word ? ` (${d.reading})` : ''}`;
const feedback = (entry, result) => self.registration.showNotification(`${result.correct ? entry.data.l_correct : entry.data.l_incorrect}`, {
  // Re-alert after the silent local acknowledgement so Android surfaces the translation.
  body: `${wordLabel(entry.data)} — ${result.meaning}`, tag: entry.id, icon: ICON_URL, renotify: true, requireInteraction: true,
  data: { ...entry.data, stage: 'done' },
});
const rejected = (entry) => self.registration.showNotification(`${entry.data.word}`, {
  body: entry.data.l_failed, tag: entry.id, icon: ICON_URL, renotify: false,
  data: { ...entry.data, stage: 'failed' },
});
const flushAnswers = () => outbox.flush(feedback, rejected);
async function requestRetry() {
  try { await self.registration.sync?.register(SYNC_TAG); } catch { /* Retry on the next push or app visit. */ }
}
self.addEventListener('sync', event => { if (event.tag === SYNC_TAG) event.waitUntil(flushAnswers()); });
self.addEventListener('message', event => {
  if (event.data?.type === 'FLUSH_PUSH_ANSWERS') event.waitUntil(flushAnswers().catch(requestRetry));
  if (event.data?.type === 'SHOW_PUSH_QUIZ') event.waitUntil(showPushQuiz({ data: event.data.data }));
});

// Flashcards arrive as data-only messages so the whole review happens inside the notification.
function showPushQuiz(payload) {
  const d = payload.data || {};
  if (!d.delivery_id) return;
  const options = {
    tag: d.delivery_id, icon: ICON_URL, renotify: true, requireInteraction: true,
    data: { ...d, stage: d.l_know || d.quiz_options ? 'quiz' : 'prompt' },
    // New cards are self-reported ("I know" / "I don't know"); older deliveries keep the meaning quiz.
    actions: d.l_know ? [{ action: 'answer_0', title: d.l_know }, { action: 'answer_1', title: d.l_dont_know }]
      : d.quiz_options ? [{ action: 'answer_0', title: `A. ${JSON.parse(d.quiz_options)[0]}` }, { action: 'answer_1', title: `B. ${JSON.parse(d.quiz_options)[1]}` }, { action: 'answer_dk', title: d.l_dont_know }]
      : [{ action: 'reveal', title: d.l_reveal }],
  };
  if (d.example) options.body = d.example;
  const shown = self.registration.showNotification(`${wordLabel(d)}`, options);
  return Promise.all([shown, flushAnswers().catch(requestRetry)]);
}
messaging.onBackgroundMessage(showPushQuiz);

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  if (!d.delivery_id) return;
  n.close();
  // Recognize self-check payloads even on notifications created by an older worker.
  if (d.stage === 'quiz' || (d.l_know && d.stage === 'prompt')) {
    if (event.action !== 'answer_0' && event.action !== 'answer_1' && event.action !== 'answer_dk') return event.waitUntil(self.clients.openWindow(d.path));
    event.waitUntil((async () => {
      try {
        const answer = event.action === 'answer_dk' ? -1 : Number(event.action.slice(-1));
        await outbox.enqueue(d, answer);
        // Acknowledge the durable local save before any network request.
        await self.registration.showNotification(`${wordLabel(d)}`, {
          body: d.l_know ? (answer === 0 ? d.l_know : d.l_dont_know) : (answer === -1 ? d.l_dont_know : JSON.parse(d.quiz_options)[answer]),
          tag: d.delivery_id, icon: ICON_URL, renotify: false,
          data: { ...d, stage: 'queued' },
        });
      } catch {
        await self.clients.openWindow(d.path);
        return;
      }
      await requestRetry();
      await flushAnswers().catch(requestRetry);
    })());
    return;
  }
  if (d.stage === 'done') return;
  if (d.stage === 'queued') return event.waitUntil(flushAnswers().catch(requestRetry));
  if (d.stage === 'failed') return event.waitUntil(self.clients.openWindow(d.path));
  const showAnswer = () => self.registration.showNotification(`${d.word}${d.reading && d.reading !== d.word ? ` (${d.reading})` : ''}`, {
    body: [d.meaning, d.example].filter(Boolean).join('\n'), tag: d.delivery_id, icon: ICON_URL, requireInteraction: true,
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
