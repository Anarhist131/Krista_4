// sw.js — Service Worker для Кристы 4.1
// Поддерживает: офлайн-кеш, фоновую синхронизацию, периодическую синхронизацию, push-уведомления

const CACHE_NAME = 'krista-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/client.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ================== Установка: кешируем основные файлы ==================
self.addEventListener('install', (event) => {
  console.log('[SW] Установка');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(console.warn);
    })
  );
  // Активируем новый SW сразу, минуя ожидание
  self.skipWaiting();
});

// ================== Активация: удаляем старые кеши ==================
self.addEventListener('activate', (event) => {
  console.log('[SW] Активация');
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    })
  );
  // Захватываем все открытые страницы под новый SW
  self.clients.claim();
});

// ================== Запросы: кеш, потом сеть ==================
self.addEventListener('fetch', (event) => {
  // Пропускаем запросы к socket.io (они должны идти напрямую)
  if (event.request.url.includes('/socket.io/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networked = fetch(event.request)
        .then((response) => {
          // Кешируем свежий ответ, если это статика
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // если сеть недоступна, отдаём кеш
      return cached || networked;
    })
  );
});

// ================== Фоновая синхронизация (Background Sync) ==================
self.addEventListener('sync', (event) => {
  console.log('[SW] Sync событие:', event.tag);
  if (event.tag === 'sync-messages') {
    event.waitUntil(
      // Здесь можно отправить накопленные сообщения или получить свежие данные с сервера
      fetch('/')
        .then(() => console.log('[SW] Фоновая синхронизация выполнена'))
        .catch(err => console.warn('[SW] Ошибка синхронизации:', err))
    );
  }
  // Добавляй другие теги при необходимости
});

// ================== Периодическая синхронизация (Periodic Background Sync) ==================
self.addEventListener('periodicsync', (event) => {
  console.log('[SW] Periodic Sync событие:', event.tag);
  if (event.tag === 'check-updates') {
    event.waitUntil(
      // Периодически опрашиваем сервер для получения обновлений
      fetch('/')
        .then(res => res.text())
        .then(() => console.log('[SW] Периодическая синхронизация успешна'))
        .catch(err => console.warn('[SW] Ошибка периодической синхронизации:', err))
    );
  }
});

// ================== Push-уведомления ==================
self.addEventListener('push', (event) => {
  console.log('[SW] Push событие получено');
  let data = { title: 'Криста 4.1', body: 'Новое сообщение' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ================== Клик по уведомлению ==================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        if (clientList.length > 0) {
          let client = clientList[0];
          return client.focus();
        }
        return clients.openWindow('/');
      })
  );
});
