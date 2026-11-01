// Shared by the dedicated messaging worker. No app-shell caching or answer keys.
(function (scope) {
  const DB_NAME = 'tatani-push-answers';
  const STORE = 'answers';
  let database;
  function openDatabase() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { database = undefined; reject(request.error); };
    });
    return database;
  }
  async function transaction(mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const storage = {
    // add (not put): the first answer wins even when clicks race.
    async add(entry) {
      try { await transaction('readwrite', store => store.add(entry)); }
      catch (error) { if (error?.name !== 'ConstraintError') throw error; }
    },
    list: () => transaction('readonly', store => store.getAll()),
    remove: id => transaction('readwrite', store => store.delete(id)),
  };
  function createOutbox(store = storage, send = fetch) {
    let flushing;
    return {
      async enqueue(data, answer) {
        await store.add({ id: data.delivery_id, data, answer, createdAt: Date.now() });
      },
      flush(onResult, onRejected) {
        if (flushing) return flushing;
        flushing = (async () => {
          let retry = false;
          for (const entry of await store.list()) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            try {
              const response = await send(entry.data.api, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                body: JSON.stringify({ action: 'quiz_answer', delivery_id: entry.id, token: entry.data.token, answer: entry.answer }),
              });
              if (!response.ok) {
                // Only terminal authorization/missing/invalid-card failures leave the queue.
                if ([400, 401, 403, 404, 410].includes(response.status)) {
                  await onRejected(entry);
                  await store.remove(entry.id);
                } else retry = true;
                continue;
              }
              const result = await response.json();
              await onResult(entry, result);
              await store.remove(entry.id);
            } catch { retry = true; }
            finally { clearTimeout(timeout); }
          }
          if (retry) throw new Error('Answers still awaiting sync');
        })().finally(() => { flushing = undefined; });
        return flushing;
      },
    };
  }
  scope.TataniPushOutbox = { createOutbox };
})(self);