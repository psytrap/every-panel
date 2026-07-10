// Initialize Deno KV Database
const kv = await Deno.openKv(Deno.env.get("KV_PATH"));

// Memory stores for active connections (local to this isolate instance)
const clients = new Set<WebSocket>();
const devices = new Map<string, { socket: WebSocket; lastSeen: number }>();

// Configurations from Environment Variables
const DISABLE_AUTH = Deno.env.get("DISABLE_AUTH") === "true";
const GITHUB_CLIENT_ID = Deno.env.get("GITHUB_CLIENT_ID") || "";
const GITHUB_CLIENT_SECRET = Deno.env.get("GITHUB_CLIENT_SECRET") || "";
const ALLOWED_GITHUB_USERS = (Deno.env.get("ALLOWED_GITHUB_USERS") || "")
  .split(",")
  .map(u => u.trim().toLowerCase())
  .filter(u => u.length > 0);

const COOKIE_NAME = "every_panel_session";
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Interface structures

interface CommandMessage {
  type: "command";
  device_id: string;
  action: string;
  target: string;
  value: unknown;
}

interface GlobalDeviceStatus {
  state: "detached" | "live" | "control";
  controllerSessionId: string | null;
}

// ==========================================
// Database Helper Operations
// ==========================================

async function saveUIDefinition(deviceId: string, layoutDef: Record<string, unknown>) {
  await kv.set(["device", deviceId, "ui_definition"], {
    layoutDef,
    timestamp: Date.now(),
  });
}

async function getUIDefinition(deviceId: string): Promise<Record<string, unknown> | null> {
  const res = await kv.get<{ layoutDef: Record<string, unknown> }>(["device", deviceId, "ui_definition"]);
  return res.value ? res.value.layoutDef : null;
}

async function saveLatestTelemetry(deviceId: string, data: Record<string, unknown>) {
  const timestamp = Date.now();
  await kv.set(["device", deviceId, "latest"], { data, timestamp });
  
  const settingsRes = await kv.get<{ historyTtlDays: number }>(["device", deviceId, "settings"]);
  const ttlDays = settingsRes.value ? settingsRes.value.historyTtlDays : 7; // default to 7 days
  
  if (ttlDays > 0) {
    const expireIn = ttlDays * 24 * 60 * 60 * 1000;
    await kv.set(["device", deviceId, "history", timestamp], { data, timestamp }, { expireIn });
  } else {
    await kv.set(["device", deviceId, "history", timestamp], { data, timestamp });
  }
}

async function getLatestTelemetry(deviceId: string) {
  const res = await kv.get<{ data: Record<string, unknown>; timestamp: number }>(["device", deviceId, "latest"]);
  return res.value || null;
}

async function getHistory(deviceId: string, limit = 50) {
  const list = kv.list<{ data: Record<string, unknown>; timestamp: number }>({
    prefix: ["device", deviceId, "history"],
  }, { limit, reverse: true });
  
  const results = [];
  for await (const item of list) {
    results.push(item.value);
  }
  return results.reverse();
}

// Session Helpers
async function createSession(sessionId: string, username: string) {
  const expires = Date.now() + SESSION_EXPIRY_MS;
  await kv.set(["sessions", sessionId], { username, expires });
  return expires;
}

async function checkSession(sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  const res = await kv.get<{ username: string; expires: number }>(["sessions", sessionId]);
  if (!res.value) return null;
  if (Date.now() > res.value.expires) {
    await kv.delete(["sessions", sessionId]);
    return null;
  }
  return res.value.username;
}

async function deleteSession(sessionId: string) {
  await kv.delete(["sessions", sessionId]);
}

// ==========================================
// Periodic Device Keepalive Ping (Local Isolate)
// ==========================================

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
        await kv.set(["device", deviceId, "status"], { state: "detached", controllerSessionId: null });
      }
    } else {
      if (dev.socket.readyState === WebSocket.OPEN) {
        dev.socket.send(JSON.stringify({ type: "ping" }));
      }
    }
  }
}, 5000);

function startDeviceKVWatcher(socket: WebSocket, deviceId: string) {
  const watchKeys = [["device", deviceId, "command"]];
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

// ==========================================
// WebSocket Broadcast and Connection Router
function broadcastLocalStatus(deviceId: string, state: string, controllerSessionId: string | null) {
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

// ==========================================

function handleWebSocketUpgrade(req: Request): Response {
  const url = new URL(req.url);
  const role = url.searchParams.get("role");
  const deviceId = url.searchParams.get("device_id") || "default";

  // Validate device ID matches UUID format (except for the 'default' offline panel placeholder)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (deviceId !== "default" && !UUID_REGEX.test(deviceId)) {
    return new Response("Bad Request: Device ID must be a valid UUID format.", { status: 400 });
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
      await kv.set(["device", deviceId, "status"], { state: "live", controllerSessionId: null });
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
          await kv.set(["device", deviceId, "status"], {
            state: "control",
            controllerSessionId: tabId
          });
          broadcastLocalStatus(deviceId, "control", tabId);
        } 
        
        else if (msg.type === "release_control") {
          const statusKey = ["device", deviceId, "status"];
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
          const statusRes = await kv.get<GlobalDeviceStatus>(["device", cmdMsg.device_id, "status"]);
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
            .set(["device", cmdMsg.device_id, "command"], cmdMsg)
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
        await kv.set(["device", deviceId, "status"], { state: "detached", controllerSessionId: null });
        broadcastLocalStatus(deviceId, "detached", null);
      } else {
        console.log(`[WS] Stale device socket closed for ${deviceId} (ignored)`);
      }
    } 
    
    else {
      console.log("[WS] Web Client disconnected from this isolate");
      clients.delete(socket);
      
      // Release control if this client tab held the active lease lock
      const statusKey = ["device", deviceId, "status"];
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

// ==========================================
// Deno KV Watcher (Client updates stream)
// ==========================================

function startKVWatcher(socket: WebSocket, deviceId: string, sessionId: string) {
  const watchKeys = [
    ["device", deviceId, "status"],
    ["device", deviceId, "ui_definition"],
    ["device", deviceId, "latest"]
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

// ==========================================
// Embedded Client UI Templates
// ==========================================

const CSS_TEMPLATE = `
:root {
  --bg-color: #0b0f19;
  --panel-bg: rgba(17, 24, 39, 0.6);
  --border-color: rgba(255, 255, 255, 0.08);
  --primary-color: #24292e;
  --primary-glow: rgba(255, 255, 255, 0.1);
  --accent-color: #3b82f6;
  --accent-glow: rgba(59, 130, 246, 0.4);
  --success-color: #10b981;
  --warning-color: #f59e0b;
  --danger-color: #ef4444;
  --text-primary: #f3f4f6;
  --text-secondary: #9ca3af;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: 'Outfit', sans-serif;
  background-color: var(--bg-color);
  color: var(--text-primary);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.glass {
  background: var(--panel-bg);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  box-shadow: 0 10px 40px 0 rgba(0, 0, 0, 0.45);
}

.login-container {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 20px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  padding: 50px 30px;
  text-align: center;
}

.login-card h2 {
  font-size: 24px;
  margin-bottom: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.login-card p {
  color: var(--text-secondary);
  font-size: 14px;
  margin-bottom: 35px;
}

.btn-github {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
  padding: 14px;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.15);
  background: #24292e;
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.3s ease;
}

.btn-github:hover {
  background: #2f363d;
  box-shadow: 0 0 15px rgba(255,255,255,0.1);
}

.error-message {
  color: var(--danger-color);
  font-size: 13px;
  margin-top: 20px;
}

header {
  padding: 20px 40px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
}

.header-title h1 {
  font-size: 20px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 15px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 12px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-color);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-secondary);
}

.status-badge.detached .status-dot {
  background: var(--danger-color);
  box-shadow: 0 0 8px var(--danger-color);
}

.status-badge.live .status-dot {
  background: var(--warning-color);
  box-shadow: 0 0 8px var(--warning-color);
}

.status-badge.control .status-dot {
  background: var(--success-color);
  box-shadow: 0 0 8px var(--success-color);
}

.status-badge.disconnected .status-dot {
  background: #6b7280;
  box-shadow: 0 0 8px #6b7280;
  animation: pulse-glow 1.5s infinite;
}

.status-badge.initializing .status-dot {
  background: #f59e0b;
  box-shadow: 0 0 8px #f59e0b;
  animation: pulse-glow 1.2s infinite;
}

.status-badge.stale .status-dot {
  background: #ec4899;
  box-shadow: 0 0 8px #ec4899;
  animation: pulse-glow 0.8s infinite;
}

.status-badge.fault .status-dot {
  background: #ef4444;
  box-shadow: 0 0 10px #ef4444;
  animation: pulse-glow 0.5s infinite;
}

@keyframes pulse-glow {
  0% { opacity: 0.35; }
  50% { opacity: 1; }
  100% { opacity: 0.35; }
}

.btn-action {
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  transition: all 0.3s ease;
}

.btn-action:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--text-secondary);
}

.btn-action.active-lease {
  background: var(--accent-color);
  border-color: var(--accent-color);
  box-shadow: 0 0 10px var(--accent-glow);
}

.btn-action.active-lease:hover {
  background: #2563eb;
}

.btn-logout {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  text-decoration: none;
  border: 1px solid var(--border-color);
  transition: all 0.3s ease;
}

.btn-logout:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.05);
}

main {
  flex: 1;
  padding: 40px;
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 30px;
}

.layout-row {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
}

.layout-column {
  display: flex;
  flex-direction: row;
  gap: 20px;
  flex-wrap: wrap;
  width: 100%;
}

.layout-column > * {
  flex: 1 1 200px;
}

.widget-card {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.widget-label {
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 500;
  display: block;
}

.widget-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.widget-input {
  width: 100%;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: 15px;
  transition: all 0.3s ease;
  font-family: inherit;
}

.widget-input:focus {
  outline: none;
  border-color: var(--accent-color);
  background: rgba(255, 255, 255, 0.08);
}

.widget-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.widget-btn {
  width: 100%;
  padding: 12px;
  border-radius: 8px;
  border: none;
  background: var(--accent-color);
  color: #fff;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s ease;
}

.widget-btn:hover:not(:disabled) {
  background: #2563eb;
  box-shadow: 0 0 10px var(--accent-glow);
}

.widget-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.widget-text-view {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 14px;
  font-size: 14px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  line-height: 1.5;
}

.widget-range-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.widget-range-row {
  display: flex;
  align-items: center;
  gap: 15px;
}

.widget-range {
  flex: 1;
  height: 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  outline: none;
  accent-color: var(--accent-color);
  cursor: pointer;
}

.widget-range:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.widget-range-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent-color);
  min-width: 30px;
  text-align: right;
}

.widget-img {
  width: 100%;
  max-height: 300px;
  object-fit: contain;
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.widget-indicator {
  font-size: 26px;
  font-weight: 600;
  color: var(--text-primary);
}

.widget-unit {
  font-size: 14px;
  color: var(--text-secondary);
  font-weight: 400;
  margin-left: 4px;
}

.widget-icon {
  width: 22px;
  height: 22px;
  color: var(--accent-color);
}

.disabled-overlay {
  pointer-events: none;
  opacity: 0.45;
}

.chart-container {
  padding: 30px;
  width: 100%;
}

.chart-header {
  margin-bottom: 20px;
  font-weight: 600;
  font-size: 16px;
  letter-spacing: 0.5px;
}

.chart-wrapper {
  position: relative;
  width: 100%;
  height: 300px;
}
`;

const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - Every-Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS_TEMPLATE}</style>
</head>
<body>
  <div class="login-container">
    <div class="login-card glass">
      <h2>Every-Panel Hub</h2>
      <p>Secure login with your GitHub account</p>
      
      <a href="/login/github" class="btn-github">
        <svg style="width:24px;height:24px;" viewBox="0 0 24 24"><path fill="currentColor" d="M12,2A10,10 0 0,0 2,12C2,16.42 4.87,20.17 8.84,21.5C9.34,21.58 9.5,21.27 9.5,21C9.5,20.77 9.5,20.14 9.5,19.31C6.73,19.91 6.14,17.97 6.14,17.97C5.68,16.81 5.03,16.5 5.03,16.5C4.12,15.88 5.1,15.9 5.1,15.9C6.1,15.97 6.63,16.93 6.63,16.93C7.5,18.45 8.97,18 9.54,17.76C9.63,17.11 9.89,16.67 10.17,16.42C7.95,16.17 5.62,15.31 5.62,11.5C5.62,10.39 6,9.5 6.65,8.79C6.55,8.54 6.2,7.5 6.75,6.15C6.75,6.15 7.59,5.88 9.5,7.17C10.29,6.95 11.15,6.84 12,6.84C12.85,6.84 13.71,6.95 14.5,7.17C16.41,5.88 17.25,6.15 17.25,6.15C17.8,7.5 17.45,8.54 17.35,8.79C18,9.5 18.38,10.39 18.38,11.5C18.38,15.32 16.04,16.16 13.81,16.41C14.17,16.72 14.5,17.33 14.5,18.26C14.5,19.6 14.5,20.68 14.5,21C14.5,21.27 14.66,21.59 15.17,21.5C19.14,20.16 22,16.42 22,12A10,10 0 0,0 12,2Z"/></svg>
        <span>Authenticate with GitHub</span>
      </a>
      
      <div id="error-box"></div>
    </div>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);
    if (params.has('error')) {
      const errBox = document.getElementById('error-box');
      errBox.className = 'error-message';
      const reason = params.get('error');
      if (reason === 'not_allowed') {
        errBox.innerText = 'Authentication succeeded, but your GitHub user is not in the allowed access list.';
      } else if (reason === 'no_config') {
        errBox.innerText = 'GitHub OAuth environment variables are not configured on the server.';
      } else {
        errBox.innerText = 'GitHub OAuth validation failed. Please try again.';
      }
    }
  </script>
</body>
</html>
`;

// Helper to construct index HTML dynamically based on DISABLE_AUTH
function getPanelHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Every-Panel - IoT Hub</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>${CSS_TEMPLATE}</style>
</head>
<body>
  <header class="glass">
    <div class="header-title">
      <h1>
        <svg style="width:24px;height:24px;" viewBox="0 0 24 24"><path fill="currentColor" d="M19,5V19H5V5H19M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M14,17H7V15H14V17M17,13H7V11H17V13M17,9H7V7H17V9Z"/></svg>
        <span id="app-title">Every-Panel</span>
      </h1>
    </div>
    
    <div class="header-controls">
      <div id="connection-badge" class="status-badge detached">
        <span class="status-dot"></span>
        <span id="status-text">Detached</span>
      </div>
      
      <button id="control-lease-btn" onclick="toggleControlLease()" class="btn-action" style="display:none;">
        Acquire Control
      </button>

       <a href="/devices" class="btn-action" style="text-decoration:none; display:inline-flex; align-items:center; gap:6px;">Device Directory</a>

      <a href="/logout" class="btn-logout" id="logout-btn" style="${DISABLE_AUTH ? 'display:none;' : ''}">Logout</a>
    </div>
  </header>

  <main>
    <!-- Dynamic Panel Container -->
    <div id="widgets-container" class="layout-row">
      <div class="glass" style="padding:40px; text-align:center;">
        <p style="color:var(--text-secondary);">Waiting for device configurations and telemetry stream...</p>
      </div>
    </div>

    <!-- Telemetry History Chart -->
    <div id="chart-panel" class="glass chart-container" style="display:none;">
      <div class="chart-header">Historical Telemetry Stream</div>
      <div class="chart-wrapper">
        <canvas id="telemetryChart"></canvas>
      </div>
    </div>
  </main>

  <script>
    const url = new URL(window.location.href);
    const deviceId = url.searchParams.get("device_id") || "default";
    const tabId = crypto.randomUUID();
    
    const wsProto = url.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = wsProto + "//" + url.host + "/ws?role=client&device_id=" + deviceId + "&tab_id=" + tabId;

    let ws = null;
    let layoutDef = null;
    let latestData = {};
    let chart = null;

    let isController = false;
    let deviceState = "detached"; // "detached" | "live" | "control"
    let lastTelemetryTime = Date.now();

    // Maps to track DOM elements dynamically for updates
    const valueElements = new Map(); // id -> Element
    const inputElements = new Map(); // id -> HTMLInputElement

    // Check stale status loop every 2 seconds
    setInterval(() => {
      if (deviceState !== "detached" && deviceState !== "disconnected") {
        updatePanelState();
      }
    }, 2000);

    function connect() {
      console.log("Connecting to WebSocket...");
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        console.log("WS Received:", msg);

        if (msg.type === "init") {
          layoutDef = msg.layout_def;
          latestData = msg.latest;
          if (latestData && Object.keys(latestData).length > 0) {
            lastTelemetryTime = Date.now();
          }
          if (layoutDef) {
            renderPanel();
          } else {
            updatePanelState();
          }
        } 
        
        else if (msg.type === "status_update") {
          updatePanelState(msg.state, msg.is_controller);
        } 
        
        else if (msg.type === "ui_definition") {
          layoutDef = msg.layout_def;
          renderPanel();
        } 
        
        else if (msg.type === "telemetry") {
          latestData = msg.data;
          lastTelemetryTime = Date.now();
          updateWidgets();
          appendChartData(msg.data, msg.timestamp);
          updatePanelState();
        }
        
        else if (msg.type === "error") {
          alert(msg.message);
        }
      };

      ws.onclose = () => {
        console.log("WS Disconnected. Retrying in 3s...");
        updatePanelState("disconnected", false);
        setTimeout(connect, 3000);
      };
    }

    function determineActiveUIState() {
      if (deviceState === "disconnected") return "disconnected";
      if (deviceState === "detached") return "detached";
      if (latestData && (latestData.fault || latestData.error)) return "fault";
      if (Date.now() - lastTelemetryTime > 10000) return "stale";
      if (!layoutDef) return "initializing";
      return deviceState;
    }

    function updatePanelState(state, controllerFlag) {
      if (state !== undefined) {
        deviceState = state;
      }
      if (controllerFlag !== undefined) {
        isController = controllerFlag;
      }

      const activeState = determineActiveUIState();

      const badge = document.getElementById("connection-badge");
      const statusText = document.getElementById("status-text");
      const leaseBtn = document.getElementById("control-lease-btn");
      const widgetsContainer = document.getElementById("widgets-container");

      badge.className = "status-badge " + activeState;
      
      if (activeState === "disconnected") {
        statusText.innerText = "Connecting...";
        leaseBtn.style.display = "none";
      }
      
      else if (activeState === "detached") {
        statusText.innerText = "Detached";
        leaseBtn.style.display = "none";
      }

      else if (activeState === "initializing") {
        statusText.innerText = "Initializing...";
        leaseBtn.style.display = "none";
      }

      else if (activeState === "stale") {
        statusText.innerText = "Stale (Lagging)";
        leaseBtn.style.display = "inline-block";
      }

      else if (activeState === "fault") {
        const errMsg = latestData.fault || latestData.error || "Device Fault";
        statusText.innerText = "Fault: " + errMsg;
        leaseBtn.style.display = "inline-block";
      }
      
      else if (activeState === "live") {
        statusText.innerText = "Live (View Only)";
        leaseBtn.style.display = "inline-block";
        leaseBtn.className = "btn-action";
        leaseBtn.innerText = "Acquire Control";
      } 
      
      else if (activeState === "control") {
        if (isController) {
          statusText.innerText = "Control Mode (You)";
          leaseBtn.style.display = "inline-block";
          leaseBtn.className = "btn-action active-lease";
          leaseBtn.innerText = "Release Control";
        } else {
          statusText.innerText = "Live (In Use)";
          leaseBtn.style.display = "inline-block";
          leaseBtn.className = "btn-action";
          leaseBtn.innerText = "Take Over Control";
        }
      }

      // Enable/disable form inputs based on control state
      inputElements.forEach(el => {
        el.disabled = (activeState !== "control" || !isController);
      });
    }

    function toggleControlLease() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (isController) {
        ws.send(JSON.stringify({ type: "release_control", device_id: deviceId }));
      } else {
        ws.send(JSON.stringify({ type: "acquire_control", device_id: deviceId }));
      }
    }

    // ==========================================
    // Dynamic Layout Rendering Engine
    // ==========================================

    function renderPanel() {
      const container = document.getElementById("widgets-container");
      container.innerHTML = "";
      
      valueElements.clear();
      inputElements.clear();

      if (!layoutDef || !layoutDef.payload) {
        container.innerHTML = \`
          <div class="glass" style="padding:40px; text-align:center;">
            <p style="color:var(--text-secondary);">Device connected but has not uploaded a UI definition layout yet.</p>
          </div>
        \`;
        return;
      }

      const payload = layoutDef.payload;
      
      // Update app title in header
      if (payload.title) {
        document.getElementById("app-title").innerText = payload.title;
      }

      // Root element is a layout (typically flow: row)
      renderNode(payload, container);
      
      // Sync telemetry values after building layout
      updateWidgets();
      
      // Setup dynamic charts
      initChart();
      
      // Restore appropriate state overlays
      updatePanelState(deviceState, isController);
    }

    // Recursive node builder
    function renderNode(node, container) {
      if (!node) return;

      if (node.type === "layout") {
        const flow = node.properties?.flow || "row";
        const layoutDiv = document.createElement("div");
        
        layoutDiv.className = flow === "column" ? "layout-column" : "layout-row";
        layoutDiv.id = "layout-" + (node.properties?.id || Math.random());
        
        if (Array.isArray(node.layout)) {
          node.layout.forEach(child => {
            renderNode(child, layoutDiv);
          });
        }
        container.appendChild(layoutDiv);
      } 
      
      else {
        // Individual leaves/widgets
        const widgetCard = buildWidget(node);
        if (widgetCard) {
          container.appendChild(widgetCard);
        }
      }
    }

    function buildWidget(node) {
      const p = node.properties || {};
      const card = document.createElement("div");
      
      if (node.type === "divider") {
        const hr = document.createElement("hr");
        hr.style.cssText = "border:0; border-top:1px solid var(--border-color); margin:10px 0; width:100%;";
        return hr;
      }

      card.className = "glass widget-card";
      if (p.id) card.id = "widget-" + p.id;

      switch (node.type) {
        case "number": {
          const isReadonly = p.readonly === "true";
          card.innerHTML = \`
            <label class="widget-label">\${p.label || 'Number'}</label>
            <input type="number" id="input-\${p.id}" class="widget-input" step="\${p.step || 'any'}" value="\${p.value || ''}" \${isReadonly ? 'readonly disabled' : ''}>
          \`;
          const input = card.querySelector('input');
          
          if (!isReadonly) {
            inputElements.set(p.id, input);
            input.addEventListener('change', () => sendCommandUpdate(p.id, Number(input.value)));
          } else {
            valueElements.set(p.id, input);
          }
          break;
        }

        case "text": {
          const isReadonly = p.readonly === "true";
          card.innerHTML = \`
            <label class="widget-label">\${p.label || 'Text'}</label>
            <input type="text" id="input-\${p.id}" class="widget-input" value="\${p.value || ''}" \${isReadonly ? 'readonly disabled' : ''}>
          \`;
          const input = card.querySelector('input');
          
          if (!isReadonly) {
            inputElements.set(p.id, input);
            input.addEventListener('change', () => sendCommandUpdate(p.id, input.value));
          } else {
            valueElements.set(p.id, input);
          }
          break;
        }

        case "text_view": {
          card.innerHTML = \`
            <div id="view-\${p.id}" class="widget-text-view">\${p.value || ''}</div>
          \`;
          const view = card.querySelector('.widget-text-view');
          valueElements.set(p.id, view);
          break;
        }

        case "time": {
          card.innerHTML = \`
            <label class="widget-label">\${p.label || 'Time'}</label>
            <div id="time-\${p.id}" class="widget-indicator">--</div>
          \`;
          const textEl = card.querySelector('.widget-indicator');
          valueElements.set(p.id, textEl);
          break;
        }

        case "button": {
          card.innerHTML = \`
            <button id="btn-\${p.id}" class="widget-btn">\${p.label || 'Button'}</button>
          \`;
          const btn = card.querySelector('button');
          inputElements.set(p.id, btn);
          
          btn.addEventListener('click', () => sendCommandClick(p.id));
          break;
        }

        case "image": {
          card.innerHTML = \`
            <img id="img-\${p.id}" class="widget-img" src="\${p.src || ''}">
          \`;
          const img = card.querySelector('img');
          valueElements.set(p.id, img);
          break;
        }

        case "slider": {
          card.innerHTML = \`
            <div class="widget-range-container">
              <label class="widget-label">\${p.label || 'Slider'}</label>
              <div class="widget-range-row">
                <input type="range" id="range-\${p.id}" class="widget-range" min="\${p.min || '0'}" max="\${p.max || '100'}" step="\${p.step || '1'}" value="\${p.value || '0'}">
                <span id="range-val-\${p.id}" class="widget-range-value">\${p.value || '0'}</span>
              </div>
            </div>
          \`;
          const range = card.querySelector('input');
          const valText = card.querySelector('.widget-range-value');
          
          inputElements.set(p.id, range);
          
          range.addEventListener('input', () => {
            valText.innerText = range.value;
            sendCommandUpdate(p.id, Number(range.value));
          });
          
          valueElements.set(p.id, range); // Also track as value receiver
          break;
        }

        default:
          return null;
      }

      return card;
    }

    function updateWidgets() {
      // Loop over incoming data variables and match with UI containers
      for (const [id, value] of Object.entries(latestData)) {
        
        // 1. Inputs (Value updater)
        if (valueElements.has(id)) {
          const el = valueElements.get(id);
          
          if (el.tagName === "INPUT") {
            if (document.activeElement !== el) {
              el.value = value;
              // Update companion texts if slider
              const companion = document.getElementById("range-val-" + id);
              if (companion) companion.innerText = value;
            }
          } 
          
          else if (el.tagName === "IMG") {
            el.src = value;
          } 
          
          else {
            el.innerText = value;
          }
        } 
        
        // 2. Interactive switches/inputs values sync
        else if (inputElements.has(id)) {
          const el = inputElements.get(id);
          if (el.tagName === "INPUT") {
            if (document.activeElement !== el) {
              el.value = value;
              // Update companion range span value
              const companion = document.getElementById("range-val-" + id);
              if (companion) companion.innerText = value;
            }
          }
        }
      }
    }

    function getIcon(iconName) {
      const icons = {
        thermometer: \`<svg class="widget-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M15 13V5A3 3 0 0 0 9 5V13A5 5 0 1 0 15 13M12 4A1 1 0 0 1 13 5V8H11V5A1 1 0 0 1 12 4M12 18A3 3 0 0 1 12 12V10H13V12A4 4 0 0 1 12 20A4 4 0 0 1 12 12A1.5 1.5 0 0 1 13.5 13.5A1.5 1.5 0 0 1 12 15A1.5 1.5 0 0 1 10.5 13.5A1.5 1.5 0 0 1 12 12H12Z"/></svg>\`,
        sun: \`<svg class="widget-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12,18C11.11,18 10.26,17.8 9.5,17.45L11.56,13.87C11.7,13.95 11.85,14 12,14A2,2 0 0,0 14,12C14,11.85 13.95,11.7 13.87,11.56L17.45,9.5C17.8,10.26 18,11.11 18,12A6,6 0 0,1 12,18M20,8.69V4H15.31L12,0.69L8.69,4H4V8.69L0.69,12L4,15.31V20H8.69L12,23.31L15.31,20H20V15.31L23.31,12L20,8.69Z"/></svg>\`
      };
      return icons[iconName] || '';
    }

    function sendCommandUpdate(targetId, newValue) {
      if (!isController || !ws || ws.readyState !== WebSocket.OPEN) return;
      
      ws.send(JSON.stringify({
        type: "command",
        device_id: deviceId,
        action: "update",
        target: targetId,
        value: newValue
      }));
    }

    function sendCommandClick(targetId) {
      if (!isController || !ws || ws.readyState !== WebSocket.OPEN) return;
      
      ws.send(JSON.stringify({
        type: "command",
        device_id: deviceId,
        action: "click",
        target: targetId
      }));
    }

    // ==========================================
    // Historical Chart Functions
    // ==========================================

    async function initChart() {
      // Find numeric widgets inside layout definition keys to plot (e.g. number types that are read-only)
      const numberWidgets = [];
      
      function searchNumberNodes(node) {
        if (!node) return;
        if (node.type === "number" && node.properties?.readonly === "true") {
          numberWidgets.push(node.properties);
        } else if (node.type === "layout" && Array.isArray(node.layout)) {
          node.layout.forEach(searchNumberNodes);
        }
      }
      
      if (layoutDef && layoutDef.payload) {
        searchNumberNodes(layoutDef.payload);
      }

      if (numberWidgets.length === 0) {
        document.getElementById("chart-panel").style.display = "none";
        return;
      }

      document.getElementById("chart-panel").style.display = "block";

      const res = await fetch(\`/api/history?device_id=\${deviceId}\`);
      const rawHistory = await res.json();
      
      const chartLabels = [];
      const dataSetsMap = {};

      numberWidgets.forEach(s => {
        dataSetsMap[s.id] = {
          label: s.label || s.id,
          data: [],
          borderColor: getDatasetColor(s.id),
          backgroundColor: 'rgba(59, 130, 246, 0.05)',
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 1
        };
      });

      rawHistory.forEach(h => {
        chartLabels.push(new Date(h.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}));
        numberWidgets.forEach(s => {
          dataSetsMap[s.id].data.push(h.data[s.id]);
        });
      });

      const ctx = document.getElementById('telemetryChart').getContext('2d');
      
      if (chart) chart.destroy();

      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: chartLabels,
          datasets: Object.values(dataSetsMap)
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: { color: '#9ca3af', font: { family: 'Outfit' } }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#9ca3af', font: { family: 'Outfit', size: 10 } }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#9ca3af', font: { family: 'Outfit', size: 10 } }
            }
          }
        }
      });
    }

    function appendChartData(data, timestamp) {
      if (!chart) return;
      
      chart.data.labels.push(new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}));
      if (chart.data.labels.length > 50) chart.data.labels.shift();

      chart.data.datasets.forEach(dataset => {
        const match = Object.keys(data).find(k => k === dataset.label || dataset.label.startsWith(k));
        const val = data[match];
        if (match && val !== undefined) {
          dataset.data.push(val);
          if (dataset.data.length > 50) dataset.data.shift();
        }
      });

      chart.update('none');
    }

    function getDatasetColor(id) {
      const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];
      let hash = 0;
      for (let i = 0; i < id.length; i++) hash += id.charCodeAt(i);
      return colors[hash % colors.length];
    }

    connect();
  </script>
</body>
</html>
  `;
}

// Helper to construct the Devices Directory UI page
function getDevicesDirectoryHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Device Directory - Every-Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS_TEMPLATE}</style>
  <style>
    .directory-container {
      max-width: 900px;
      width: 100%;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .device-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px;
      border-radius: 12px;
      transition: all 0.3s ease;
    }
    .device-row:hover {
      border-color: var(--accent-color);
      box-shadow: 0 4px 20px rgba(59, 130, 246, 0.1);
    }
    .device-info {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .device-title {
      font-weight: 600;
      font-size: 16px;
      color: var(--text-primary);
    }
    .device-uuid {
      font-family: monospace;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .device-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .btn-delete {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: var(--danger-color);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    .btn-delete:hover {
      background: var(--danger-color);
      color: #fff;
    }
    .empty-state {
      text-align: center;
      padding: 60px 40px;
    }
    .directory-summary {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px 18px;
      font-size: 13px;
      color: var(--text-secondary);
      display: flex;
      gap: 20px;
      margin-bottom: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .directory-summary strong {
      color: var(--accent-color);
    }
  </style>
</head>
<body>
  <header class="glass">
    <div class="header-title">
      <h1>
        <svg style="width:24px;height:24px;" viewBox="0 0 24 24"><path fill="currentColor" d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8Z"/></svg>
        <span>Every-Panel Hub Directory</span>
      </h1>
    </div>
    
    <div class="header-controls">
      <a href="/logout" class="btn-logout" id="logout-btn" style="${DISABLE_AUTH ? 'display:none;' : ''}">Logout</a>
    </div>
  </header>

  <main>
    <div class="directory-container">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <h2 style="font-size:18px; font-weight:500;">Registered IoT Nodes</h2>
        <button onclick="loadDevices()" class="btn-action">Refresh List</button>
      </div>

      <div id="directory-summary-bar" class="directory-summary" style="display:none;"></div>

      <div id="device-list-container" class="layout-row">
        <!-- Rendered list items -->
      </div>
    </div>
  </main>

  <script>
    async function loadDevices() {
      const container = document.getElementById("device-list-container");
      const summaryBar = document.getElementById("directory-summary-bar");
      container.innerHTML = \`<div class="glass empty-state"><p style="color:var(--text-secondary);">Loading registered devices...</p></div>\`;
      summaryBar.style.display = "none";
      
      try {
        const res = await fetch("/api/devices");
        const list = await res.json();
        
        container.innerHTML = "";

        if (list.length === 0) {
          container.innerHTML = \`
            <div class="glass empty-state">
              <h3 style="margin-bottom:10px;">No registered devices found</h3>
              <p style="color:var(--text-secondary); font-size:14px;">Connect a device emulator using its UUID to register it in the panel index.</p>
            </div>
          \`;
          return;
        }

        // Hydrate totals summary footprint metrics
        const totalDevices = list.length;
        const totalCount = list.reduce((acc, dev) => acc + (dev.historyCount || 0), 0);
        const totalBytes = list.reduce((acc, dev) => acc + (dev.historyBytes || 0), 0);
        
        summaryBar.style.display = "flex";
        summaryBar.innerHTML = \`
          <span>Total Nodes: <strong>\${totalDevices}</strong></span>
          <span>Total Entries: <strong>\${totalCount}</strong></span>
          <span>Total Footprint: <strong>\${formatBytes(totalBytes)}</strong></span>
        \`;

        list.forEach(dev => {
          const row = document.createElement("div");
          row.className = "glass device-row";
          
          row.innerHTML = \`
            <div class="device-info">
              <div style="display:flex; align-items:center; gap:10px;">
                <div class="status-badge \${dev.state}">
                  <span class="status-dot"></span>
                  <span style="font-size:11px; text-transform:capitalize;">\${dev.state}</span>
                </div>
                <span class="device-title">\${dev.title}</span>
              </div>
              <span class="device-uuid">\${dev.deviceId}</span>
              <span style="font-size:12px; color:var(--text-secondary); margin-top:2px;">Storage Footprint: <strong>\${dev.historyCount}</strong> entries (\${formatBytes(dev.historyBytes)})</span>
            </div>

            <div class="device-actions">
              <div style="display:flex; align-items:center; gap:8px; margin-right:12px;">
                <span style="font-size:12px; color:var(--text-secondary); font-weight:500;">Retention:</span>
                <select onchange="updateTtl('\${dev.deviceId}', this.value)" style="padding:6px 10px; font-size:12px; border-radius:6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-color); color:var(--text-primary); cursor:pointer; font-family:'Outfit', sans-serif;">
                  <option value="1" \${dev.historyTtlDays === 1 ? 'selected' : ''}>1 Day</option>
                  <option value="7" \${dev.historyTtlDays === 7 ? 'selected' : ''}>7 Days</option>
                  <option value="30" \${dev.historyTtlDays === 30 ? 'selected' : ''}>30 Days</option>
                  <option value="365" \${dev.historyTtlDays === 365 ? 'selected' : ''}>1 Year</option>
                  <option value="0" \${dev.historyTtlDays === 0 ? 'selected' : ''}>Infinite</option>
                </select>
              </div>
              <a href="/?device_id=\${dev.deviceId}" class="btn-action active-lease" style="text-decoration:none; padding:8px 16px;">Open Panel</a>
              <button onclick="wipeDevice('\${dev.deviceId}')" class="btn-delete">Wipe</button>
            </div>
          \`;
          container.appendChild(row);
        });
      } catch(e) {
        container.innerHTML = \`<div class="glass empty-state"><p style="color:var(--danger-color);">Error loading directory list.</p></div>\`;
      }
    }

    function formatBytes(bytes) {
      if (bytes === 0) return "0 Bytes";
      const k = 1024;
      const sizes = ["Bytes", "KB", "MB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    }

    async function updateTtl(deviceId, days) {
      try {
        const res = await fetch("/api/devices/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId, historyTtlDays: Number(days) })
        });
        const data = await res.json();
        if (data.success) {
          // Soft refresh statistics footprint after change
          loadDevices();
        } else {
          alert("Failed to update retention policy: " + data.error);
        }
      } catch (e) {
        alert("Failed to update retention policy.");
      }
    }

    async function wipeDevice(id) {
      if (!confirm("Are you sure you want to delete this device's configuration and wipe all historical logs? This cannot be undone.")) return;
      
      try {
        const res = await fetch("/api/devices/delete?device_id=" + id, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          loadDevices();
        }
      } catch (e) {
        alert("Failed to delete device logs.");
      }
    }

    // Initial load
    loadDevices();
  </script>
</body>
</html>
  `;
}

// ==========================================
// HTTP Request Router (including GitHub OAuth)
// ==========================================

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  
  // 1. Handle WebSockets upgrade
  if (path === "/ws") {
    return handleWebSocketUpgrade(req);
  }

  // 2. Auth Cookie checking (Bypassed if DISABLE_AUTH is set to true)
  let isAuthorized = DISABLE_AUTH;
  let sessionId = "";
  
  if (!DISABLE_AUTH) {
    const cookieHeader = req.headers.get("cookie") || "";
    const match = cookieHeader.match(new RegExp(`(^| )${COOKIE_NAME}=([^;]+)`));
    sessionId = match ? match[2] : "";
    const username = await checkSession(sessionId);
    isAuthorized = username !== null;
  }

  // Unauthenticated Route: Serve login UI
  if (path === "/login") {
    if (isAuthorized) {
      return Response.redirect(`${url.origin}/`, 302);
    }
    return new Response(LOGIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // Trigger GitHub OAuth redirect
  if (path === "/login/github") {
    if (DISABLE_AUTH) {
      return Response.redirect(`${url.origin}/`, 302);
    }
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      console.error("[Auth] GitHub OAuth credentials not configured!");
      return Response.redirect(`${url.origin}/login?error=no_config`, 302);
    }

    const redirectUri = `${url.origin}/login/callback`;
    const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&scope=read:user`;

    return Response.redirect(authorizeUrl, 302);
  }

  // GitHub OAuth Callback Endpoint
  if (path === "/login/callback") {
    if (DISABLE_AUTH) {
      return Response.redirect(`${url.origin}/`, 302);
    }
    
    const code = url.searchParams.get("code");
    if (!code) {
      return Response.redirect(`${url.origin}/login?error=oauth_failed`, 302);
    }

    try {
      // Exchange Authorization Code for Access Token
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${url.origin}/login/callback`,
        }),
      });

      const tokenData = await tokenResponse.json();
      const accessToken = tokenData.access_token;

      if (!accessToken) {
        throw new Error("No access token returned from GitHub");
      }

      // Query User Profile
      const userResponse = await fetch("https://api.github.com/user", {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": "Every-Panel-App",
        },
      });

      const userData = await userResponse.json();
      const gitUsername = userData.login?.toLowerCase();

      if (!gitUsername) {
        throw new Error("Could not retrieve login handle from user profile");
      }

      // Validate against Allowed Users list
      if (ALLOWED_GITHUB_USERS.length > 0 && !ALLOWED_GITHUB_USERS.includes(gitUsername)) {
        console.warn(`[Auth] User '${gitUsername}' attempted login but is not in allowed list.`);
        return Response.redirect(`${url.origin}/login?error=not_allowed`, 302);
      }

      // Successful authentication: Create Session
      const randomSessionId = crypto.randomUUID();
      const expires = await createSession(randomSessionId, gitUsername);
      const expiresDate = new Date(expires).toUTCString();

      return new Response("", {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": `${COOKIE_NAME}=${randomSessionId}; Path=/; HttpOnly; SameSite=Strict; Expires=${expiresDate}; Secure`,
        },
      });
    } catch (err) {
      console.error("[Auth] OAuth Callback Error:", err);
      return Response.redirect(`${url.origin}/login?error=oauth_error`, 302);
    }
  }

  // Handle Logout
  if (path === "/logout") {
    if (sessionId) {
      await deleteSession(sessionId);
    }
    return new Response("", {
      status: 302,
      headers: {
        "Location": "/login",
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      },
    });
  }

  // Secure Endpoints Validation
  if (!isAuthorized) {
    return Response.redirect(`${url.origin}/login`, 302);
  }

  // Devices Directory UI page
  if (path === "/devices") {
    return new Response(getDevicesDirectoryHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // REST API: Get all registered devices in KV store
  if (path === "/api/devices") {
    const devicesList = [];
    const prefix = ["device"];
    const list = kv.list({ prefix });
    const seenIds = new Set<string>();

    for await (const entry of list) {
      // Key format: ["device", deviceId, "ui_definition"] or similar
      const deviceId = entry.key[1];
      if (typeof deviceId !== "string" || seenIds.has(deviceId)) continue;
      seenIds.add(deviceId);

      const uiDef = await getUIDefinition(deviceId);
      const statusRes = await kv.get<GlobalDeviceStatus>(["device", deviceId, "status"]);

      // Determine state - default to detached if not found
      let state = "detached";
      if (statusRes.value) {
        state = statusRes.value.state;
        
        // Dynamic stale state check
        if (state !== "detached" && state !== "disconnected") {
          const lastTelemetry = await getLatestTelemetry(deviceId);
          if (lastTelemetry && (Date.now() - lastTelemetry.timestamp > 10000)) {
            state = "stale";
          }
        }
      }

      // Calculate history stats footprint
      let historyCount = 0;
      let historyBytes = 0;
      const historyIter = kv.list({ prefix: ["device", deviceId, "history"] });
      for await (const entry of historyIter) {
        historyCount++;
        const serialized = JSON.stringify(entry.value);
        historyBytes += serialized.length + 30; // payload size + indexing overhead
      }

      // Load retention TTL setting
      const settingsRes = await kv.get<{ historyTtlDays: number }>(["device", deviceId, "settings"]);
      const historyTtlDays = settingsRes.value ? settingsRes.value.historyTtlDays : 7; // default to 7 days

      devicesList.push({
        deviceId,
        title: uiDef ? (uiDef as any).payload?.title || "Unnamed Device" : "Unnamed Device",
        state,
        controllerSessionId: statusRes.value ? statusRes.value.controllerSessionId : null,
        historyCount,
        historyBytes,
        historyTtlDays
      });
    }

    return new Response(JSON.stringify(devicesList), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // REST API: Update settings (like history TTL) for a device
  if (path === "/api/devices/settings" && req.method === "POST") {
    const body = await req.json();
    const { deviceId, historyTtlDays } = body;
    
    if (!deviceId || historyTtlDays === undefined) {
      return new Response(JSON.stringify({ success: false, error: "Missing deviceId or historyTtlDays" }), { status: 400 });
    }
    
    await kv.set(["device", deviceId, "settings"], { historyTtlDays: Number(historyTtlDays) });
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // REST API: Wipe configuration and logs for a device
  if (path === "/api/devices/delete" && req.method === "POST") {
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) {
      return new Response(JSON.stringify({ success: false, error: "Missing device_id" }), { status: 400 });
    }

    await kv.delete(["device", deviceId, "ui_definition"]);
    await kv.delete(["device", deviceId, "latest"]);
    await kv.delete(["device", deviceId, "status"]);

    const historyIter = kv.list({ prefix: ["device", deviceId, "history"] });
    for await (const entry of historyIter) {
      await kv.delete(entry.key);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // Panel landing page - redirect to /devices if no target device ID is given
  if (path === "/") {
    const deviceParam = url.searchParams.get("device_id");
    if (!deviceParam) {
      return Response.redirect(`${url.origin}/devices`, 302);
    }
    return new Response(getPanelHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // Telemetry History API
  if (path === "/api/history") {
    const deviceId = url.searchParams.get("device_id") || "default";
    const historyData = await getHistory(deviceId);
    return new Response(JSON.stringify(historyData), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // 404 Fallback
  return new Response("Not Found", { status: 404 });
}

// Start serve routing
const PORT = Number(Deno.env.get("PORT")) || 8000;
const HOST = Deno.env.get("HOST") || "0.0.0.0";
console.log(`Server starting on ${HOST}:${PORT} (Auth: ${DISABLE_AUTH ? 'DISABLED' : 'ENABLED'})...`);
Deno.serve({ port: PORT, hostname: HOST }, handler);
