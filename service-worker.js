// A service worker is a small script the browser runs in the background,
// separate from the page itself. It can intercept network requests -
// which is what lets an app keep working offline.

const CACHE_NAME = "streakfit-v2";

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
// (or whenever this file's contents change, signaling a new version).
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );

  // By default, a new service worker waits until every open tab using the
  // old one is closed before taking over. skipWaiting() makes the new
  // version activate immediately on the next page load instead.
  self.skipWaiting();
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

  // Take control of any already-open tabs immediately, instead of only
  // controlling pages loaded after this point.
  self.clients.claim();
});

// "fetch" fires for every network request the page makes (loading the
// HTML, CSS, JS, etc).
//
// Strategy: NETWORK-FIRST. Always try to fetch the latest version from
// the internet first, and only fall back to the saved cache copy if that
// fails (e.g. you're offline). This is the opposite of "cache-first" -
// it means you always see the newest version when you have a connection,
// and offline support is purely a fallback rather than the default.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Save a copy of the fresh response into the cache for next time
        // you're offline, then return the fresh response to the page.
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
