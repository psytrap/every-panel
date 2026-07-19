import {
  kv,
  pk,
  saveLatestTelemetry,
  saveUIDefinition,
  getUIDefinition,
  getLatestTelemetry,
  COOKIE_NAME,
  GlobalDeviceStatus,
  CommandMessage,
  isDeviceAuthorized,
  checkDeviceKey
} from "./db.ts";

// Memory stores for active connections (local to this isolate instance)
export const clients = new Set<WebSocket>();
export const devices = new Map<string, { socket: WebSocket; lastSeen: number }>();

// BroadcastChannel for cross-isolate viewer pong relay
export const wsChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("every-panel-ws")
  : null;

// Per-device viewer state: tracks last pong time and whether device was already notified
export const viewerState = new Map<string, { lastPong: number; notifiedActive: boolean }>();

function getViewerState(deviceId: string) {
  if (!viewerState.has(deviceId)) {
    viewerState.set(deviceId, { lastPong: 0, notifiedActive: false });
  }
  return viewerState.get(deviceId)!;
}

// Receive cross-isolate viewer_pong (from clients on other isolates)
if (wsChannel) {
  wsChannel.onmessage = (event) => {
    const { type, deviceId } = event.data;
    if (type === "viewer_pong") {
      getViewerState(deviceId).lastPong = Date.now();
    }
  };
}

// Every 10s: ping all local UI clients watching each locally-connected device,
// then notify the device on viewer presence state changes.
// PING_INTERVAL_MS env var allows tests to override this to a shorter value.
const PING_INTERVAL_MS = parseInt(Deno.env.get("PING_INTERVAL_MS") ?? "10000");
setInterval(async () => {
  const now = Date.now();

  for (const [deviceId, dev] of devices.entries()) {
    // Ping all local UI clients watching this device
    for (const client of clients) {
      if ((client as any).role === "client" && (client as any).deviceId === deviceId) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "ping" }));
        }
      }
    }

    // Determine viewer presence: recent pong within TTL (1 interval + 10s grace)
    const vs = getViewerState(deviceId);
    const hasViewers = (now - vs.lastPong) < (PING_INTERVAL_MS + 10000);

    if (dev.socket.readyState !== WebSocket.OPEN) continue;

    // Notify device only on state transitions
    if (hasViewers && !vs.notifiedActive) {
      vs.notifiedActive = true;
      console.log(`[Heartbeat] Viewers active for device '${deviceId}'`);
      dev.socket.send(JSON.stringify({ type: "viewers_active" }));
    } else if (!hasViewers && vs.notifiedActive) {
      vs.notifiedActive = false;
      console.log(`[Heartbeat] No viewers for device '${deviceId}'`);
      dev.socket.send(JSON.stringify({ type: "viewers_inactive" }));
    }
  }
}, PING_INTERVAL_MS);

export function startDeviceKVWatcher(socket: WebSocket, deviceId: string) {
  const watchKeys = [pk("device", deviceId, "command")];
  const watcher = kv.watch(watchKeys);
  const reader = watcher.getReader();
  
  const closeListener = () => {
    try {
      reader.cancel();
    } catch (_err) {
      // ignore
    }
  };
  socket.addEventListener("close", closeListener);
  socket.addEventListener("error", closeListener);

  (async () => {
    let lastCommandVer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || socket.readyState !== WebSocket.OPEN) {
          break;
        }
        
        const [commandEntry] = value;
        if (commandEntry.versionstamp && commandEntry.versionstamp !== lastCommandVer) {
          lastCommandVer = commandEntry.versionstamp;
          const cmd = commandEntry.value as CommandMessage | null;
          if (cmd && cmd.type === "command") {
            console.log(`[Watch] Routing command to device '${deviceId}' -> target: ${cmd.target}`);
            socket.send(JSON.stringify(cmd));
          }
        }
      }
    } catch (err) {
      console.error("[WS] Device KV Watcher error:", err);
    } finally {
      socket.removeEventListener("close", closeListener);
      socket.removeEventListener("error", closeListener);
      try {
        reader.releaseLock();
        watcher.cancel();
      } catch (_err) {
        // ignore
      }
    }
  })();
}

export function broadcastLocalStatus(deviceId: string, state: string, controllerSessionId: string | null) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN && (client as any).role === "client" && (client as any).deviceId === deviceId) {
      client.send(JSON.stringify({
        type: "status_update",
        device_id: deviceId,
        state,
        is_controller: controllerSessionId ? (client as any).tabId === controllerSessionId : false
      }));
    }
  }
}

export async function handleWebSocketUpgrade(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const role = url.searchParams.get("role"); // "device" or "client"
  const deviceId = url.searchParams.get("device_id") || "default";

  // Validate device ID matches UUID format (except for the 'default' offline panel placeholder)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (deviceId !== "default" && !UUID_REGEX.test(deviceId)) {
    console.log(`[WS REJECT] Invalid Device ID format: "${deviceId}"`);
    return new Response("Bad Request: Device ID must be a valid UUID format.", { status: 400 });
  }

  // Reject connection if the device ID is not pre-registered/authorized
  const authorized = await isDeviceAuthorized(deviceId);
  if (!authorized) {
    console.log(`[WS REJECT] Device ID "${deviceId}" has not been registered in the dashboard.`);
    return new Response("Unauthorized: This Device ID has not been registered in the dashboard system.", { status: 403 });
  }

  // If a physical device is connecting, it must supply the correct matching device key
  const protocols = req.headers.get("sec-websocket-protocol") || "";
  const subprotocolKey = protocols.split(",")
    .map(p => p.trim())
    .find(p => p && p !== "every-panel-device-auth");

  if (role === "device") {
    const deviceKey = req.headers.get("X-Device-Key") || subprotocolKey || url.searchParams.get("device_key") || "";
    const keyMatches = await checkDeviceKey(deviceId, deviceKey);
    if (!keyMatches) {
      console.log(`[WS REJECT] Key mismatch for Device ID: "${deviceId}". Provided: "${deviceKey}"`);
      return new Response("Unauthorized: Invalid or missing device key.", { status: 403 });
    }
  }

  // Parse session from cookie headers to track the client
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`(^| )${COOKIE_NAME}=([^;]+)`));
  const sessionId = match ? match[2] : "anonymous";
  
  // Extract tab_id to distinguish between multiple tabs from the same logged-in user
  const tabId = url.searchParams.get("tab_id") || sessionId;

  const selectedProtocol = protocols.includes("every-panel-device-auth")
    ? "every-panel-device-auth"
    : undefined;

  const { socket, response } = Deno.upgradeWebSocket(req, {
    protocol: selectedProtocol
  });

  socket.onopen = async () => {
    if (role === "device") {
      console.log(`[WS] Device connected to this isolate: ${deviceId}`);
      
      // Clean up any existing stale connection for this device ID to save resources
      const existing = devices.get(deviceId);
      if (existing) {
        console.log(`[WS] Closing existing stale connection for device '${deviceId}'`);
        try {
          existing.socket.close();
        } catch (_) {}
      }
      
      devices.set(deviceId, { socket, lastSeen: Date.now() });
      
      // Update global state in Deno KV
      await kv.set(pk("device", deviceId, "status"), { state: "live", controllerSessionId: null });
      broadcastLocalStatus(deviceId, "live", null);

      // Start watcher for commands sent to this device
      startDeviceKVWatcher(socket, deviceId);
    } 
    
    else {
      console.log(`[WS] Web Client connected to this isolate`);
      (socket as any).role = "client";
      (socket as any).deviceId = deviceId;
      (socket as any).tabId = tabId;
      clients.add(socket);
      
      // Prime viewer state on connect so the next interval tick immediately sees this client as active
      getViewerState(deviceId).lastPong = Date.now();
      // No client-side ping loop needed: server pings clients, clients reply with pong
      
      const uiDef = await getUIDefinition(deviceId);
      const latest = await getLatestTelemetry(deviceId);

      // Send initial dataset bootstrapper
      socket.send(JSON.stringify({
        type: "init",
        device_id: deviceId,
        layout_def: uiDef || null,
        latest: latest ? latest.data : {}
      }));
      
      // Start Deno KV Watch loop to reactively push updates to this client
      startKVWatcher(socket, deviceId, tabId);
    }
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (role === "device") {
        if (msg.type === "pong") {
          const dev = devices.get(deviceId);
          if (dev) {
            dev.lastSeen = Date.now();
          }
        } 
        
        else if (msg.type === "ui_definition") {
          console.log(`[WS] Received UI Definition Layout from ${deviceId}`);
          await saveUIDefinition(deviceId, msg.layout_def);
        } 
        
        else if (msg.type === "telemetry") {
          await saveLatestTelemetry(deviceId, msg.data);
        }
      } 
      
      else if (role === "client") {
        if (msg.type === "pong") {
          // UI replied to server ping — update viewer presence for this device
          getViewerState(deviceId).lastPong = Date.now();
          // Relay cross-isolate so the device's isolate also knows viewers are present
          if (wsChannel) {
            wsChannel.postMessage({ type: "viewer_pong", deviceId });
          }
        }

        else if (msg.type === "acquire_control") {
          console.log(`[WS] Client tab '${tabId}' acquiring control lease for ${deviceId}`);
          await kv.set(pk("device", deviceId, "status"), {
            state: "control",
            controllerSessionId: tabId
          });
          broadcastLocalStatus(deviceId, "control", tabId);
        } 
        
        else if (msg.type === "release_control") {
          const statusKey = pk("device", deviceId, "status");
          const statusRes = await kv.get<GlobalDeviceStatus>(statusKey);
          if (statusRes.value && statusRes.value.controllerSessionId === tabId) {
            console.log(`[WS] Client tab '${tabId}' releasing control lease for ${deviceId}`);
            const commitRes = await kv.atomic()
              .check(statusRes)
              .set(statusKey, {
                state: "live",
                controllerSessionId: null
              })
              .commit();
            if (commitRes.ok) {
              broadcastLocalStatus(deviceId, "live", null);
            }
          }
        } 
        
        else if (msg.type === "command") {
          const cmdMsg = msg as CommandMessage;
          
          // Security Check: Verify this client tab holds the control lock lease in KV
          const statusRes = await kv.get<GlobalDeviceStatus>(pk("device", cmdMsg.device_id, "status"));
          if (!statusRes.value || statusRes.value.controllerSessionId !== tabId) {
            socket.send(JSON.stringify({
              type: "error",
              message: "Write Access Denied: You do not hold active control rights."
            }));
            return;
          }

          // Direct Route Optimization: If the device is connected locally to this isolate, route it directly in-memory!
          const dev = devices.get(cmdMsg.device_id);
          if (dev && dev.socket.readyState === WebSocket.OPEN) {
            dev.socket.send(JSON.stringify(cmdMsg));
            return;
          }

          // Write command key to KV to trigger the device watcher (cross-isolate compatible)
          const commitRes = await kv.atomic()
            .check(statusRes)
            .set(pk("device", cmdMsg.device_id, "command"), cmdMsg)
            .commit();
          if (!commitRes.ok) {
            socket.send(JSON.stringify({
              type: "error",
              message: "Write Access Denied: Control lease changed during execution."
            }));
          }
        }
      }
    } catch (e) {
      console.error("[WS] Error handling message:", e);
    }
  };

  socket.onclose = async () => {
    if (role === "device") {
      const current = devices.get(deviceId);
      if (current && current.socket === socket) {
        console.log(`[WS] Device disconnected from this isolate: ${deviceId}`);
        devices.delete(deviceId);
        
        // Update global state in Deno KV to detached
        await kv.set(pk("device", deviceId, "status"), { state: "detached", controllerSessionId: null });
        broadcastLocalStatus(deviceId, "detached", null);

        // If there are no local clients watching this device, delete from viewerState to prevent memory leaks
        const remainingClients = Array.from(clients).some(
          c => (c as any).role === "client" && (c as any).deviceId === deviceId
        );
        if (!remainingClients) {
          viewerState.delete(deviceId);
        }
      } else {
        console.log(`[WS] Stale device socket closed for ${deviceId} (ignored)`);
      }
    } 
    
    else {
      console.log("[WS] Web Client disconnected from this isolate");
      clients.delete(socket);

      // If no more local clients are watching this device, expire viewer state immediately
      // so the next interval tick sends viewers_inactive without waiting out the full TTL
      const remainingClients = Array.from(clients).some(
        c => (c as any).role === "client" && (c as any).deviceId === deviceId
      );
      if (!remainingClients) {
        const vs = getViewerState(deviceId);
        vs.lastPong = 0; // Expire immediately
        
        // If the physical device is also not connected to this isolate, remove from viewerState to prevent memory leak
        if (!devices.has(deviceId)) {
          viewerState.delete(deviceId);
        }
      }
      
      // Release control if this client tab held the active lease lock
      const statusKey = pk("device", deviceId, "status");
      const statusRes = await kv.get<GlobalDeviceStatus>(statusKey);
      if (statusRes.value && statusRes.value.controllerSessionId === tabId) {
        console.log(`[WS] Active controller tab disconnected. Releasing lease for ${deviceId}`);
        const commitRes = await kv.atomic()
          .check(statusRes)
          .set(statusKey, {
            state: "live",
            controllerSessionId: null
          })
          .commit();
        if (commitRes.ok) {
          broadcastLocalStatus(deviceId, "live", null);
        }
      }
    }
  };

  return response;
}

export function startKVWatcher(socket: WebSocket, deviceId: string, sessionId: string) {
  const watchKeys = [
    pk("device", deviceId, "status"),
    pk("device", deviceId, "ui_definition"),
    pk("device", deviceId, "latest")
  ];

  const watcher = kv.watch(watchKeys);
  const reader = watcher.getReader();
  
  const closeListener = () => {
    try {
      reader.cancel();
    } catch (_err) {
      // ignore
    }
  };
  socket.addEventListener("close", closeListener);
  socket.addEventListener("error", closeListener);
  
  (async () => {
    let lastStatusVer = "";
    let lastUiVer = "";
    let lastLatestVer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || socket.readyState !== WebSocket.OPEN) break;

        const [statusEntry, uiEntry, latestEntry] = value;

        // 1. Status Update check
        if (statusEntry.versionstamp && statusEntry.versionstamp !== lastStatusVer) {
          lastStatusVer = statusEntry.versionstamp;
          const val = statusEntry.value as GlobalDeviceStatus | null;
          socket.send(JSON.stringify({
            type: "status_update",
            device_id: deviceId,
            state: val ? val.state : "detached",
            is_controller: val ? val.controllerSessionId === sessionId : false
          }));
        }

        // 2. UI Definition layout check
        if (uiEntry.versionstamp && uiEntry.versionstamp !== lastUiVer) {
          lastUiVer = uiEntry.versionstamp;
          const val = uiEntry.value as { layoutDef: Record<string, unknown> } | null;
          socket.send(JSON.stringify({
            type: "ui_definition",
            device_id: deviceId,
            layout_def: val ? val.layoutDef : null
          }));
        }

        // 3. Telemetry Update check
        if (latestEntry.versionstamp && latestEntry.versionstamp !== lastLatestVer) {
          lastLatestVer = latestEntry.versionstamp;
          const val = latestEntry.value as { data: Record<string, unknown>; timestamp: number } | null;
          if (val) {
            socket.send(JSON.stringify({
              type: "telemetry",
              device_id: deviceId,
              data: val.data,
              timestamp: val.timestamp
            }));
          }
        }
      }
    } catch (e) {
      console.error("[Watcher] KV watch stream error:", e);
    } finally {
      socket.removeEventListener("close", closeListener);
      socket.removeEventListener("error", closeListener);
      try {
        reader.releaseLock();
        watcher.cancel();
      } catch (_err) {
        // ignore
      }
    }
  })();
}
