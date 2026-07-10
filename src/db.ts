// Initialize Deno KV Database
export const kv = await Deno.openKv(Deno.env.get("KV_PATH"));

// Configurations from Environment Variables
export const DISABLE_AUTH = Deno.env.get("DISABLE_AUTH") === "true";
export const GITHUB_CLIENT_ID = Deno.env.get("GITHUB_CLIENT_ID") || "";
export const GITHUB_CLIENT_SECRET = Deno.env.get("GITHUB_CLIENT_SECRET") || "";
export const ALLOWED_GITHUB_USERS = (Deno.env.get("ALLOWED_GITHUB_USERS") || "")
  .split(",")
  .map(u => u.trim().toLowerCase())
  .filter(u => u.length > 0);

export const COOKIE_NAME = "every_panel_session";
export const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Interface structures
export interface CommandMessage {
  type: "command";
  device_id: string;
  action: string;
  target: string;
  value: unknown;
}

export interface GlobalDeviceStatus {
  state: "detached" | "live" | "control";
  controllerSessionId: string | null;
}

// Database Helper Operations
export async function saveUIDefinition(deviceId: string, layoutDef: Record<string, unknown>) {
  await kv.set(["device", deviceId, "ui_definition"], {
    layoutDef,
    timestamp: Date.now()
  });
}

export async function getUIDefinition(deviceId: string): Promise<Record<string, unknown> | null> {
  const res = await kv.get<{ layoutDef: Record<string, unknown> }>([
    "device",
    deviceId,
    "ui_definition"
  ]);
  return res.value ? res.value.layoutDef : null;
}

export async function saveLatestTelemetry(deviceId: string, data: Record<string, unknown>) {
  const timestamp = Date.now();
  await kv.set(["device", deviceId, "latest"], { data, timestamp });
  
  const settingsRes = await kv.get<{ historyTtlDays: number }>(["device", deviceId, "settings"]);
  const ttlDays = settingsRes.value ? settingsRes.value.historyTtlDays : 7;
  const expireIn = ttlDays * 24 * 60 * 60 * 1000;

  if (expireIn > 0) {
    await kv.set(["device", deviceId, "history", timestamp], { data, timestamp }, { expireIn });
  } else {
    await kv.set(["device", deviceId, "history", timestamp], { data, timestamp });
  }
}

export async function getLatestTelemetry(deviceId: string) {
  const res = await kv.get<{ data: Record<string, unknown>; timestamp: number }>([
    "device",
    deviceId,
    "latest"
  ]);
  return res.value;
}

export async function getHistory(deviceId: string, limit = 50) {
  const list = kv.list<{ data: Record<string, unknown>; timestamp: number }>({
    prefix: ["device", deviceId, "history"]
  });
  const results = [];
  for await (const entry of list) {
    results.push(entry.value);
  }
  // Sort descending and take the limit
  results.sort((a, b) => b.timestamp - a.timestamp);
  return results.slice(0, limit);
}

export async function createSession(sessionId: string, username: string) {
  const expires = Date.now() + SESSION_EXPIRY_MS;
  await kv.set(["sessions", sessionId], { username, expires });
  return expires;
}

export async function checkSession(sessionId: string): Promise<string | null> {
  const res = await kv.get<{ username: string; expires: number }>(["sessions", sessionId]);
  if (!res.value) return null;
  if (Date.now() > res.value.expires) {
    await kv.delete(["sessions", sessionId]);
    return null;
  }
  return res.value.username;
}

export async function deleteSession(sessionId: string) {
  await kv.delete(["sessions", sessionId]);
}
