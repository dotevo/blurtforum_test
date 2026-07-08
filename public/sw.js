(() => {
  "use strict";

  // ── BUFFER WINDOW CLAMP ──────────────────────────────────────────
  const bufferWindows = new Map();
  let cancelled = false;

  const SW_BUILD = "wtp-sw-4-fixed";
  console.log("[SW] script evaluated, build:", SW_BUILD);

  function getCleanUrlKey(url) {
    if (!url) return url;
    try {
      const u = new URL(url);
      const idx = u.pathname.indexOf('/webtorrent/');
      if (idx !== -1) {
        return u.pathname.slice(idx);
      }
    } catch (e) {}
    return url;
  }

  // ── REQUEST TELEMETRY ────────────────────────────────────────────
  // NOTE: this name AND the message "type" below must match what
  // torrent-lib.js's TorrentLibrary listens for (BroadcastChannel
  // 'wtp-stream-requests', message type 'wtp-range-requested') — they had
  // drifted apart, which meant the main thread's _onRangeRequested() never
  // fired and the 'range-requested' event (used to react to the real,
  // post-clamp byte range being fetched right now) was silently dead.
  let telemetryChannel = null;
  try {
    telemetryChannel = new BroadcastChannel("wtp-stream-requests");
  } catch (e) {
    console.warn("[SW] BroadcastChannel disabled or unsupported:", e);
  }

  function broadcastRange(url, headers, destination) {
    if (!telemetryChannel) return;
    try {
      let r = headers["range"] || headers["Range"] || "";
      let start = null, end = null;
      if (r) {
        const m = r.match(/bytes=(\d+)-(\d+)?/);
        if (m) {
          start = parseInt(m[1], 10);
          end = m[2] ? parseInt(m[2], 10) : null;
        }
      }
      telemetryChannel.postMessage({ type: "wtp-range-requested", url, start, end, destination, ts: Date.now() });
    } catch (e) {
      console.error("[SW] failed to post telemetry:", e);
    }
  }

  // ── HEADER CLAMP (TRIMMING WINDOW) ──────────────────────────────
  function clampRangeHeader(url, headers) {
    const cleanUrl = getCleanUrlKey(url);
    const maxByte = bufferWindows.get(cleanUrl);

    const cleanHeaders = {};
    if (headers && typeof headers.forEach === 'function') {
      headers.forEach((value, key) => {
        cleanHeaders[key.toLowerCase()] = value;
      });
    } else if (headers) {
      Object.keys(headers).forEach(key => {
        cleanHeaders[key.toLowerCase()] = headers[key];
      });
    }

    if (maxByte == null) return cleanHeaders;

    const rangeVal = cleanHeaders["range"];
    if (!rangeVal) return cleanHeaders;

    const match = rangeVal.match(/bytes=(\d+)-(\d+)?/);
    if (!match) return cleanHeaders;

    const start = parseInt(match[1], 10);
    let requestedEnd = match[2] ? parseInt(match[2], 10) : null;
    let end;

    // SAFEGUARD: If start exceeds maxByte (e.g. video seek), the SW's maxByte is stale.
    // Returning an unbounded header causes the client to download the rest of the file.
    // We strictly enforce a fallback 2MB window until the main thread syncs the maxByte.
    if (start > maxByte) {
      end = start + 2 * 1024 * 1024;
      if (requestedEnd !== null && end > requestedEnd) end = requestedEnd;
      console.warn(`[SW] Warning: start (${start}) > maxByte (${maxByte}). Enforcing 2MB fallback window (to ${end}).`);
    } else {
      end = maxByte;
      if (requestedEnd !== null && end > requestedEnd) end = requestedEnd;
    }

    cleanHeaders["range"] = `bytes=${start}-${end}`;
    return cleanHeaders;
  }

  // ── LIFECYCLE ────────────────────────────────────────────────────
  self.addEventListener("install", (e) => {
    console.log("[SW] installed, claiming immediately...");
    e.waitUntil(self.skipWaiting());
  });

  self.addEventListener("activate", (e) => {
    console.log("[SW] activated, taking control...");
    e.waitUntil(self.clients.claim());
  });

  self.addEventListener("message", ({ data }) => {
    if (!data || typeof data !== "object") return;

    if (data.type === "wtp-cancel-all") {
      cancelled = true;
      console.log("[SW] wtp-cancel-all received -> cutting downstream pipes");
      return;
    }

    if (data.type === "wtp-buffer-window") {
      const cleanUrl = getCleanUrlKey(data.url);
      if (data.endByte == null) {
        bufferWindows.delete(cleanUrl);
      } else {
        bufferWindows.set(cleanUrl, data.endByte);
      }
    }
  });

  // ── FETCH EVENT INTERCEPTION ─────────────────────────────────────
  self.addEventListener("fetch", (event) => {
    const { request } = event;
    const url = request.url;

    if (request.method !== "GET" || !url.includes("/webtorrent/")) {
      return;
    }

    event.respondWith(handleStreamRequest(request));
  });

  async function handleStreamRequest(request) {
    const url = request.url;
    const method = request.method;
    const destination = request.destination;

    const clampedHeaders = clampRangeHeader(url, request.headers);
    broadcastRange(url, clampedHeaders, destination);

    const winClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    
    // FIX: Avoid executing fetch(request) on virtual /webtorrent/ routes when no clients are available.
    // fetch() on virtual routes triggers a Promise rejection that crashes the Service Worker.
    if (!winClients || winClients.length === 0) {
      console.warn("[SW] No active window clients. Rejecting virtual request.");
      return new Response("No active window clients available", { status: 503 });
    }

    const [reply, port] = await new Promise(resolve => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve([null, null]);
        }
      }, 200);

      const client = winClients[0];
      const channel = new MessageChannel();
      const { port1, port2 } = channel;
      
      port1.onmessage = ({ data }) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve([data, port1]);
        }
      };

      client.postMessage({
        url, method, headers: clampedHeaders,
        scope: self.registration.scope, 
        destination: destination,
        type: "webtorrent",
      }, [port2]);
    });

    const finish = () => { 
      if (port) {
        try { port.postMessage(false); } catch(e){}
        port.onmessage = null; 
      }
    };

    if (!reply || reply.body !== "STREAM") { 
      finish(); 
      return new Response("Stream bridge bypass or timeout", { 
        status: 416,
        headers: { "Content-Range": "bytes */*", "Accept-Ranges": "bytes" }
      }); 
    }

    // ── FIREFOX HEADER NORMALIZATION ──
    const cleanResponseHeaders = new Headers();
    if (reply.headers) {
      Object.keys(reply.headers).forEach(key => {
        const val = reply.headers[key];
        // SAFEGUARD: Prevent undefined/null values from crashing Headers.set()
        if (val === undefined || val === null) return;
        
        const lowerKey = key.toLowerCase();
        if (lowerKey === "content-range") cleanResponseHeaders.set("Content-Range", val);
        else if (lowerKey === "content-length") cleanResponseHeaders.set("Content-Length", val);
        else if (lowerKey === "content-type") cleanResponseHeaders.set("Content-Type", val);
        else if (lowerKey === "accept-ranges") cleanResponseHeaders.set("Accept-Ranges", val);
        else cleanResponseHeaders.set(key, val);
      });
    }

    if (!cleanResponseHeaders.has("Accept-Ranges")) {
      cleanResponseHeaders.set("Accept-Ranges", "bytes");
    }

    try {
      return new Response(new ReadableStream({
        pull(controller) {
          return new Promise(resolveTick => {
            if (!port) { controller.close(); resolveTick(); return; }
            
            port.onmessage = ({ data: chunk }) => {
              try {
                if (chunk) {
                  controller.enqueue(chunk);
                } else {
                  finish();
                  controller.close();
                }
              } catch (e) {
                finish();
              }
              resolveTick();
            };
            port.postMessage(true);
          });
        },
        start(controller) {},
        cancel() { finish(); },
      }), {
        status: reply.status || 206,
        statusText: reply.statusText || "Partial Content",
        headers: cleanResponseHeaders
      });
    } catch (err) {
      console.error("[SW] Fatal crash generating Response:", err);
      finish();
      return new Response("Fatal Stream Error", { 
        status: 416, 
        headers: { "Content-Range": "bytes */*" } 
      });
    }
  }
})();