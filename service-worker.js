// A service worker is a small script the browser runs in the background,
// separate from the page itself. It can intercept network requests -
// which is what lets an app keep working offline.

const CACHE_NAME = "streakfit-v1";

// The files needed to run the app at all. These get saved into the
// browser's cache during "install", so they're available even offline.
const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
];

// "install" fires once, the first time the service worker is registered
// (or whenever CACHE_NAME changes, signaling a new version).
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
});

// "activate" fires after install - this is a good place to clean up
// old caches left over from a previous version of the app.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
});

// "fetch" fires for every network request the page makes (loading the
// HTML, CSS, JS, etc). We try the cache first; if it's not there, fall
// back to an actual network request.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
