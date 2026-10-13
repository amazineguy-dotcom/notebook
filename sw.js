var PREFIX = "notebook-", CACHE = PREFIX + "v13";
var SHELL = ["./", "index.html", "theme-init.js", "app.js", "diary.js", "books.js", "movies.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];
// GitHub Pages lets browsers keep files for 10 minutes. Always revalidate, so a page never mixes
// a new index.html with an old script (an old app.js crashes on missing elements).
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: "reload" }); }));
  }).then(function () { return self.skipWaiting(); }));
});
// Other apps share this github.io origin and its cache storage: only remove our own old caches.
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // A navigation Request cannot be re-used with options, so rebuild it from its URL.
  var fresh = req.mode === "navigate" ? new Request(req.url, { cache: "no-cache" }) : new Request(req, { cache: "no-cache" });
  e.respondWith(fetch(fresh).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.open(CACHE).then(function (c) {
      return c.match(req, { ignoreSearch: true }).then(function (hit) { return hit || c.match("index.html"); });
    });
  }));
});
