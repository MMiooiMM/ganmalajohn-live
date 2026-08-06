/**
 * 乾麻辣將 Service Worker（SPEC §21.3 – §21.5）。
 *
 * Cache 名稱必須與 App 版本一致。修改版本時要同步更新：
 *   1. package.json 的 version
 *   2. src/version.ts 的 APP_VERSION
 *   3. 這裡的 APP_VERSION
 * tests/pwa.test.ts 會驗證三者一致。
 *
 * 啟用新 Worker 時只刪除本 App 前綴下的舊 Cache，不得刪除同來源其他應用的 Cache。
 */

const APP_PREFIX = 'ganmalajohn-'
const APP_VERSION = '0.13.0'
const CACHE = `${APP_PREFIX}v${APP_VERSION}`

/**
 * 從 Cache Storage 回傳時必須移除的 headers。
 *
 * 快取存的是「已解壓」的內容，若把原始的 content-encoding 一起帶回去，
 * 瀏覽器會嘗試二次解壓而導致 JS/CSS 模組載入失敗。
 */
const STRIPPED_HEADERS = ['content-encoding', 'content-length', 'etag', 'last-modified', 'vary']

function rootUrl() {
  return new URL('./', self.registration.scope).href
}

/** 移除 HTML 資源標籤的 crossorigin，避免離線快取回應的相容問題。 */
function stripCrossorigin(html) {
  return html.replace(/\scrossorigin(=(["'])[^"']*\2|=[^\s>]*)?/gi, '')
}

/** 解析根 HTML 中所有同源的 src／href。 */
function sameOriginAssets(html, base) {
  const out = new Set()
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const raw = m[1]
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue
    try {
      const url = new URL(raw, base)
      if (url.origin !== self.location.origin) continue
      if (url.href === base) continue
      out.add(url.href)
    } catch {
      // 無法解析的位址直接略過
    }
  }
  return out
}

async function install() {
  const cache = await caches.open(CACHE)
  const base = rootUrl()

  const res = await fetch(base, { cache: 'reload' })
  const html = await res.text()
  await cache.put(
    base,
    new Response(stripCrossorigin(html), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  )

  const assets = sameOriginAssets(html, base)
  for (const name of ['manifest.webmanifest', 'icon.svg', 'icon-maskable.svg']) {
    assets.add(new URL(name, base).href)
  }

  await Promise.all(
    [...assets].map(async (href) => {
      try {
        const r = await fetch(href, { cache: 'reload' })
        if (r.ok) await cache.put(href, r)
      } catch {
        // 個別資源抓不到不應讓整個安裝失敗
      }
    }),
  )
  // 刻意不呼叫 skipWaiting：等使用者按下「立即更新」再切換（SPEC §21.6）
}

async function activate() {
  const names = await caches.keys()
  await Promise.all(
    names
      .filter((n) => n.startsWith(APP_PREFIX) && n !== CACHE)
      .map((n) => caches.delete(n)),
  )
  await self.clients.claim()
}

function fromCache(res) {
  const headers = new Headers(res.headers)
  for (const h of STRIPPED_HEADERS) headers.delete(h)
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/** 導航：network-first。成功時更新快取，失敗時回傳快取或 scope 根頁。 */
async function navigateFirst(request) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(request)
    if (res.ok) cache.put(request, res.clone())
    return res
  } catch {
    const hit = await cache.match(request)
    if (hit) return fromCache(hit)
    const root = await cache.match(rootUrl())
    if (root) return fromCache(root)
    return new Response('離線，且尚未完成應用程式殼層的首次安裝。', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}

/** 靜態資源：cache-first。未命中才走網路並在成功時寫入快取。 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return fromCache(hit)
  const res = await fetch(request)
  if (res.ok) cache.put(request, res.clone())
  return res
}

self.addEventListener('install', (event) => {
  event.waitUntil(install())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(activate())
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  // 只攔截同源 GET
  if (request.method !== 'GET') return
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(navigateFirst(request))
    return
  }
  event.respondWith(cacheFirst(request))
})
