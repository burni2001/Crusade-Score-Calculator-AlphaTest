const CACHE_NAME = "mission-debrief-v4.5 Alpha3"; // Increment this version number when you make changes to cached assets
const urlsToCache = [
    "./", // Caches the root, i.e., index.html
    "./index.html",
    "./style.css",
    "./script.js",
    "./manifest.json",
    "./attached_assets/FFFvLV2Ld6_crt_frei.png",
    "./service-worker.js", // It's good practice to cache the service worker itself
    "https://fonts.googleapis.com/css2?family=VT323&display=swap", // Cache the Google Font CSS
    // --- Add your PWA icons here ---
    "icons/icon-192x192.png",
    "icons/icon-512x512.png",
    "icons/icon-maskable-192x192.png",
    "icons/icon-maskable-512x512.png",
    // -------------------------------
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log("Opened cache: " + CACHE_NAME);
            return cache.addAll(urlsToCache);
        }),
    );
    // Force this worker to become active immediately
    self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            // Cache hit - return response
            if (response) {
                return response;
            }
            // No cache hit - fetch from network
            return fetch(event.request).then((response) => {
                // Check if we received a valid response
                if (
                    !response ||
                    response.status !== 200 ||
                    response.type !== "basic"
                ) {
                    return response;
                }

                // IMPORTANT: Clone the response. A response is a stream
                // and can only be consumed once. We need to consume it
                // once to cache it and once for the browser to use it.
                const responseToCache = response.clone();

                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache);
                });

                return response;
            });
        }),
    );
});

self.addEventListener("activate", (event) => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            console.log("Current caches:", cacheNames);
            console.log("Keeping only:", CACHE_NAME);
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        console.log("Deleting old cache:", cacheName);
                        return caches.delete(cacheName);
                    }
                }),
            );
        }),
    );
    // Claim all clients immediately
    self.clients.claim();
});
