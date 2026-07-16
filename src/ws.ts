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
  isDeviceAuthorized
} from "./db.ts";

// Memory stores for active connections (local to this isolate instance)
export const clients = new Set<WebSocket>();
export const devices = new Map<string, { socket: WebSocket; lastSeen: number }>();

// Periodic Device Keepalive Ping (Local Isolate)
setInterval(async () => {
  const now = Date.now();
  for (const [deviceId, dev] of devices.entries()) {
    // If device hasn't responded in 15 seconds, disconnect it
    if (now - dev.lastSeen > 15000) {
      console.log(`[Heartbeat] Device '${deviceId}' timed out. Disconnecting.`);
      try {
        dev.socket.close();
      } catch { /* ignore */ }
      
      const current = devices.get(deviceId);
      if (current && current.socket === dev.socket) {
        devices.delete(deviceId);
        // Update global status in Deno KV to detached
        await kv.set(pk("device", deviceId, "status"), { state: "detached", controllerSessionId: null });
      }
    } else {
      if (dev.socket.readyState === WebSocket.OPEN) {
        dev.socket.send(JSON.stringify({ type: "ping" }));
      }
    }
  }
}, 5000);

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
    return new Response("Bad Request: Device ID must be a valid UUID format.", { status: 400 });
  }

  // Reject connection if the device ID is not pre-registered/authorized
  const authorized = await isDeviceAuthorized(deviceId);
  if (!authorized) {
    return new Response("Unauthorized: This Device ID has not been registered in the dashboard system.", { status: 403 });
  }

  // Parse session from cookie headers to track the client
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`(^| )${COOKIE_NAME}=([^;]+)`));
  const sessionId = match ? match[2] : "anonymous";
  
  // Extract tab_id to distinguish between multiple tabs from the same logged-in user
  const tabId = url.searchParams.get("tab_id") || sessionId;

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = async () => {
    if (role === "device") {
      console.log(`[WS] Device connected to this isolate: ${deviceId}`);
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
        if (msg.type === "acquire_control") {
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
      } else {
        console.log(`[WS] Stale device socket closed for ${deviceId} (ignored)`);
      }
    } 
    
    else {
      console.log("[WS] Web Client disconnected from this isolate");
      clients.delete(socket);
      
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
