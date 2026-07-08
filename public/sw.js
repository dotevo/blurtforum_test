(() => {
  "use strict";

  // ── BUFFER WINDOW CLAMP ──────────────────────────────────────────
  const bufferWindows = new Map();
  let cancelled = false;

  const SW_BUILD = "wtp-sw-3-fixed-verbose-en";
  console.log("[SW] Script evaluated, build:", SW_BUILD);

  function getCleanUrlKey(url) {
    if (!url) return url;
    try {
      const u = new URL(url);
      const idx = u.pathname.indexOf('/webtorrent/');
      if (idx !== -1) {
        return u.pathname.slice(idx);
      }
    } catch (e) {
      console.error("[SW] URL parsing error in getCleanUrlKey:", url, e);
    }
    return url;
  }

  // ── REQUEST TELEMETRY ────────────────────────────────────────────
  let telemetryChannel = null;
  try {
    telemetryChannel = new BroadcastChannel("wtp-sw-telemetry");
    console.log("[SW] Telemetry BroadcastChannel initialized successfully.");
  } catch (e) {
    console.warn("[SW] BroadcastChannel disabled or unsupported:", e);
  }

  function broadcastRange(url, headers, destination) {
    if (!telemetryChannel) {
      console.log("[SW] Telemetry skipped - no channel available.");
      return;
    }
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
      const msg = { type: "range-requested", url, start, end, destination };
      console.log("[SW] Sending telemetry:", msg);
      telemetryChannel.postMessage(msg);
    } catch (e) {
      console.error("[SW] Failed to post telemetry:", e);
    }
  }

  // ── HEADER CLAMP (TRIMMING WINDOW) ──────────────────────────────
  function clampRangeHeader(url, headers) {
    const cleanUrl = getCleanUrlKey(url);
    const maxByte = bufferWindows.get(cleanUrl);
    console.log(`[SW] clampRangeHeader for ${cleanUrl} | current maxByte:`, maxByte);

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

    if (maxByte == null) {
      console.log(`[SW] No maxByte for ${cleanUrl}, returning headers unchanged:`, cleanHeaders);
      return cleanHeaders;
    }

    const rangeVal = cleanHeaders["range"];
    if (!rangeVal) {
      console.log(`[SW] No Range header in request, returning unchanged:`, cleanHeaders);
      return cleanHeaders;
    }

    const match = rangeVal.match(/bytes=(\d+)-(\d+)?/);
    if (!match) {
      console.log(`[SW] Range header doesn't match regex: ${rangeVal}, returning unchanged.`);
      return cleanHeaders;
    }

    const start = parseInt(match[1], 10);
    let requestedEnd = match[2] ? parseInt(match[2], 10) : null;
    let end;

    console.log(`[SW] Range analysis: requested start=${start}, requested end=${requestedEnd}, buffered maxByte=${maxByte}`);

    // SAFEGUARD: If start exceeds maxByte (e.g. video seek)
    if (start > maxByte) {
      end = start + 2 * 1024 * 1024; // 2MB
      if (requestedEnd !== null && end > requestedEnd) end = requestedEnd;
      console.warn(`[SW] WARNING: start (${start}) > maxByte (${maxByte}). Enforcing 2MB fallback window (to ${end}).`);
    } else {
      end = maxByte;
      if (requestedEnd !== null && end > requestedEnd) end = requestedEnd;
    }

    cleanHeaders["range"] = `bytes=${start}-${end}`;
    console.log(`[SW] Headers after clamp applied:`, cleanHeaders["range"]);
    return cleanHeaders;
  }

  // ── LIFECYCLE ────────────────────────────────────────────────────
  self.addEventListener("install", (e) => {
    console.log("[SW] Installing... enforcing skipWaiting()");
    e.waitUntil(self.skipWaiting());
  });

  self.addEventListener("activate", (e) => {
    console.log("[SW] Activating... claiming clients (clients.claim())");
    e.waitUntil(self.clients.claim());
  });

  self.addEventListener("message", ({ data }) => {
    console.log("[SW] Message event received, data:", data);
    
    if (!data || typeof data !== "object") {
      console.warn("[SW] Ignoring message: missing data or invalid type.");
      return;
    }

    if (data.type === "wtp-cancel-all") {
      cancelled = true;
      console.log("[SW] wtp-cancel-all received -> closing downstream connections");
      return;
    }

    if (data.type === "wtp-buffer-window") {
      const cleanUrl = getCleanUrlKey(data.url);
      if (data.endByte == null) {
        console.log(`[SW] Deleting buffer window for URL: ${cleanUrl}`);
        bufferWindows.delete(cleanUrl);
      } else {
        console.log(`[SW] Setting buffer window for URL: ${cleanUrl} to endByte=${data.endByte}`);
        bufferWindows.set(cleanUrl, data.endByte);
      }
      return;
    }
    
    console.log("[SW] Unsupported message type:", data.type);
  });

  // ── FETCH EVENT INTERCEPTION ─────────────────────────────────────
  self.addEventListener("fetch", (event) => {
    const { request } = event;
    const url = request.url;

    console.log(`[SW] Fetch event: [${request.method}] ${url}`);

    if (request.method !== "GET" || !url.includes("/webtorrent/")) {
      console.log(`[SW] Ignoring fetch (not GET or not /webtorrent/): ${url}`);
      return;
    }

    console.log(`[SW] Stream request intercepted! Running handleStreamRequest for: ${url}`);
    event.respondWith(handleStreamRequest(request));
  });

  async function handleStreamRequest(request) {
    const url = request.url;
    const method = request.method;
    const destination = request.destination;

    console.log(`[SW] handleStreamRequest start. URL: ${url}, destination: ${destination}`);

    const clampedHeaders = clampRangeHeader(url, request.headers);
    broadcastRange(url, clampedHeaders, destination);

    const winClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    console.log(`[SW] Found window clients (winClients): ${winClients ? winClients.length : 0}`);
    
    if (!winClients || winClients.length === 0) {
      console.error("[SW] No active window clients. Rejecting virtual request.");
      return new Response("No active window clients available", { status: 503 });
    }

    console.log(`[SW] Communicating with main window for request: ${url}... timeout 200ms`);
    const [reply, port] = await new Promise(resolve => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          console.warn("[SW] 200ms TIMEOUT on response from main window! Resolving Promise with null.");
          resolved = true;
          resolve([null, null]);
        }
      }, 200);

      const client = winClients[0];
      const channel = new MessageChannel();
      const { port1, port2 } = channel;
      
      port1.onmessage = ({ data }) => {
        console.log("[SW] MessageChannel port1 received response from client:", data);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve([data, port1]);
        } else {
          console.warn("[SW] Received response on port1, but timeout already passed.");
        }
      };

      try {
        console.log(`[SW] Sending postMessage with type "webtorrent" to client ID: ${client.id}`);
        client.postMessage({
          url, method, headers: clampedHeaders,
          scope: self.registration.scope, 
          destination: destination,
          type: "webtorrent",
        }, [port2]);
      } catch (e) {
        console.error("[SW] Error sending postMessage to client:", e);
      }
    });

    const finish = () => { 
      if (port) {
        console.log("[SW] finish() - Closing communication port");
        try { port.postMessage(false); } catch(e){ console.error("[SW] Error sending 'false' to port:", e); }
        port.onmessage = null; 
      }
    };

    if (!reply || reply.body !== "STREAM") { 
      console.error("[SW] Bad bridge response (timeout or body !== STREAM). Aborting, returning 416.", reply);
      finish(); 
      return new Response("Stream bridge bypass or timeout", { 
        status: 416,
        headers: { "Content-Range": "bytes */*", "Accept-Ranges": "bytes" }
      }); 
    }

    console.log("[SW] Valid STREAM response received from client, preparing headers...");

    // ── FIREFOX HEADER NORMALIZATION ──
    const cleanResponseHeaders = new Headers();
    if (reply.headers) {
      Object.keys(reply.headers).forEach(key => {
        const val = reply.headers[key];
        if (val === undefined || val === null) {
          console.warn(`[SW] Empty value for header ${key}, skipping.`);
          return;
        }
        
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

    console.log("[SW] Ready response headers to send in ReadableStream:", Object.fromEntries(cleanResponseHeaders.entries()));

    try {
      return new Response(new ReadableStream({
        start(controller) {
          console.log("[SW] ReadableStream.start() - stream ready for reading");
        },
        pull(controller) {
          console.log("[SW] ReadableStream.pull() - browser requesting chunk, asking main thread...");
          return new Promise(resolveTick => {
            if (!port) { 
              console.warn("[SW] No port in pull(), closing controller.");
              controller.close(); 
              resolveTick(); 
              return; 
            }
            
            port.onmessage = ({ data: chunk }) => {
              try {
                if (chunk) {
                  const size = chunk.length || chunk.byteLength || "unknown";
                  console.log(`[SW] Received chunk from main window, size: ${size} bytes`);
                  controller.enqueue(chunk);
                } else {
                  console.log("[SW] Received empty chunk (falsy) - marking end of stream.");
                  finish();
                  controller.close();
                }
              } catch (e) {
                console.error("[SW] Exception during stream controller operation:", e);
                finish();
              }
              resolveTick();
            };
            port.postMessage(true);
          });
        },
        cancel(reason) { 
          console.log("[SW] ReadableStream.cancel() - stream cancelled by browser (e.g., video seek), reason:", reason);
          finish(); 
        },
      }), {
        status: reply.status || 206,
        statusText: reply.statusText || "Partial Content",
        headers: cleanResponseHeaders
      });
    } catch (err) {
      console.error("[SW] Fatal error generating Response object:", err);
      finish();
      return new Response("Fatal Stream Error", { 
        status: 416, 
        headers: { "Content-Range": "bytes */*" } 
      });
    }
  }
})();