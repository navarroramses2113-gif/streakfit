// A service worker is a small script the browser runs in the background,
// separate from the page itself. It can intercept network requests -
// which is what lets an app keep working offline.

// v6: earlier versions also saved Supabase's replies (workouts, friends,
// profiles) here, where they outlived signing out. The new name makes the
// "activate" step below delete that old cache with everything in it.
const CACHE_NAME = "streakfit-v6";

// The files needed to run the app at all. These get saved into the
// browser's cache during "install", so they're available even offline.
const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./i18n.js",
  "./i18n-guide-es.js",
  "./i18n-es.js",
  "./home-screen-guide.js",
  "./style.css",
  "./script.js",
  "./supabase/functions/_shared/game-rules.js",
  "./supabase/functions/_shared/exercise-counter.js",
  "./setup-scenes.js",
  "./camera-verify.js",
  "./onboarding.js",
  "./challenges.js",
  "./celebrations.js",
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
          // The Feed's map pictures (script.js) outlive app updates.
          .filter((key) => key !== CACHE_NAME && !key.startsWith("forja-route-maps"))
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
// Two strategies:
//  - CACHE-FIRST for files whose address names their version: our own
//    "?v=" files and libraries pinned to one version (supabase-js@2.117.2,
//    leaflet@1.9.4, font files). They can never change at that address -
//    a new version is a new address - so the saved copy is always right
//    and the app doesn't wait on the network for them.
//  - NETWORK-FIRST for everything else (the page itself, the manifest...),
//    so a new version shows up as soon as it's published. On a slow
//    connection the saved copy is used after 3 seconds instead of waiting.
//
// Left alone (the browser handles them as if there were no service worker):
//  - anything that isn't a plain GET (those can't be cached)
//  - Supabase: people's data, logins and server replies must never be
//    kept on the device, where they'd outlive signing out
//  - map pieces (the Feed's route maps and the live walk map): thousands
//    of small files that would only pile up here
const LEFT_ALONE_HOSTS = ["tiles.openfreemap.org", "tile.openstreetmap.org"];
// Hosts that only ever serve pinned versions (the address has "@1.2.3").
const VERSIONED_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "fonts.gstatic.com"];

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const host = url.hostname;
  if (host.endsWith(".supabase.co")) return;
  if (LEFT_ALONE_HOSTS.some((h) => host === h || host.endsWith("." + h))) return;
  const versioned = url.origin === self.location.origin ? url.searchParams.has("v") : VERSIONED_HOSTS.includes(host);
  event.respondWith(versioned ? cacheFirst(event.request) : networkFirst(event.request));
});

// Keeps a copy of a good reply for next time.
function saveCopy(request, response) {
  if (!response.ok) return;
  const copy = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
}

function cacheFirst(request) {
  return caches.match(request).then(
    (cached) =>
      cached ||
      fetch(request)
        .then((response) => {
          saveCopy(request, response);
          return response;
        })
        // Offline before this version was ever saved: the copy saved at
        // install (same file, address without "?v=") is the next best.
        .catch(() => caches.match(request, { ignoreSearch: true }))
  );
}

function networkFirst(request) {
  const fromNetwork = fetch(request).then((response) => {
    saveCopy(request, response);
    return response;
  });
  // A slow connection: after 3 seconds, the saved copy if there is one.
  const slow = new Promise((resolve) => setTimeout(resolve, 3000)).then(() => caches.match(request));
  return Promise.race([fromNetwork, slow.then((cached) => cached || fromNetwork)]).catch(() => caches.match(request));
}

// "push" fires when a push message arrives from the server, even if no tab
// has the app open. This is the part that actually puts a notification on
// the screen - everything else (permission, subscribing) just sets this up.
self.addEventListener("push", (event) => {
  let payload = { title: "Forja", body: "Don't lose your streak today!" };
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (err) {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
    })
  );
});

// Tapping the notification should bring an existing tab to the front
// instead of always opening a fresh one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./index.html");
    })
  );
});
