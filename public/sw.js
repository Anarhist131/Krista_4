// sw.js — Service Worker для Кристы 8
const CACHE_NAME = 'krista-v8';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/screen/icon1.png',
  '/screen/icon2.png'
];

// Установка: кешируем основные файлы
self.addEventListener('install', (event) => {
  console.log('[SW] Установка Кристы 8');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(err => {
        console.warn('[SW] Не удалось закешировать некоторые ресурсы:', err);
      });
    })
  );
  self.skipWaiting();
});

// Активация: удаляем старые кеши
self.addEventListener('activate', (event) => {
  console.log('[SW] Активация Кристы 8');
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Запросы: кеш, потом сеть (для статики), сетевая стратегия для API и сокетов
self.addEventListener('fetch', (event) => {
  // Не кешируем запросы к socket.io и API
  if (event.request.url.includes('/socket.io/') || 
      event.request.url.includes('/api/') ||
      event.request.url.includes('/upload/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networked = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networked;
    })
  );
});

// Push-уведомления
self.addEventListener('push', (event) => {
  let data = { title: 'Криста 8', body: 'Новое сообщение' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/screen/icon1.png',
      badge: '/screen/icon1.png',
      vibrate: [200, 100, 200],
      data: { url: data.url || '/' }
    })
  );
});

// Клик по уведомлению
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        if (clientList.length > 0) {
          return clientList[0].focus();
        }
        return clients.openWindow('/');
      })
  );
});
