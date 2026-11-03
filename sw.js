/* Daily One Service Worker
   只缓存同源静态资源；entries.json 与图片位于 OSS（跨域），由 app.js 直接请求 */

const CACHE_NAME = 'dailyone-v1'
const CACHE_FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
]

// 安装：只缓存确定存在的文件
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CACHE_FILES))
      .then(() => self.skipWaiting())
  )
})

// 激活：清理旧版本缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  )
})

// 请求：同源 GET 走 cache-first，未命中走网络；跨域（OSS、CDN）直接放行网络
self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  )
})
