/* خزانتي — Service Worker: يخلّي التطبيق يفتح بدون إنترنت.
   غيّر رقم VERSION عند كل تحديث للملفات عشان تتحدّث النسخة المخزّنة. */
const VERSION = "v2";
const SHELL = `khizanati-shell-${VERSION}`;
const RUNTIME = `khizanati-runtime-${VERSION}`;
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // الصفحة نفسها: الشبكة أولًا عشان توصل التحديثات، والنسخة المخزّنة لو ما فيه نت
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(SHELL).then(c => c.put("./index.html", copy)); return res; })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // ملفات التطبيق: من المخزّن أولًا
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
    return;
  }

  // الخط (Google Fonts): من المخزّن مع تحديث بالخلفية
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.open(RUNTIME).then(c => c.match(req).then(hit => {
        const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      }))
    );
  }
  // باقي الطلبات (مثل الطقس) تروح للشبكة مباشرة
});
