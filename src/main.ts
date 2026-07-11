import {
  kv,
  pk,
  DISABLE_AUTH,
  MOCK_AUTH,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  ALLOWED_GITHUB_USERS,
  COOKIE_NAME,
  createSession,
  checkSession,
  deleteSession,
  getHistory,
  getLatestTelemetry,
  getUIDefinition,
  GlobalDeviceStatus
} from "./db.ts";
import {
  getPanelHtml,
  getDevicesDirectoryHtml,
  getLoginHtml,
  getStatsPageHtml
} from "./views.ts";
import {
  handleWebSocketUpgrade
} from "./ws.ts";

// ==========================================
// HTTP Request Router (including GitHub OAuth)
// ==========================================

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  
  // Serve static assets from public/ directory
  if (path.startsWith("/public/")) {
    try {
      const file = await Deno.readTextFile("." + path);
      let contentType = "text/plain; charset=utf-8";
      if (path.endsWith(".css")) {
        contentType = "text/css; charset=utf-8";
      } else if (path.endsWith(".js")) {
        contentType = "application/javascript; charset=utf-8";
      }
      return new Response(file, { headers: { "content-type": contentType } });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

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
    return new Response(getLoginHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // Trigger GitHub OAuth redirect
  if (path === "/login/github") {
    if (DISABLE_AUTH) {
      return Response.redirect(`${url.origin}/`, 302);
    }
    if (MOCK_AUTH) {
      const mockCode = url.searchParams.get("mock_code") || "mock_user";
      return Response.redirect(`${url.origin}/login/callback?code=${mockCode}`, 302);
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

    if (MOCK_AUTH) {
      const gitUsername = code.toLowerCase();
      
      // Validate against Allowed Users list
      if (ALLOWED_GITHUB_USERS.length > 0 && !ALLOWED_GITHUB_USERS.includes(gitUsername)) {
        console.warn(`[Auth] Mock User '${gitUsername}' attempted login but is not in allowed list.`);
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
    const tStart = performance.now();
    let dbGetTime = 0;

    const devicesList = [];
    const prefix = pk("device");
    const list = kv.list({ prefix });
    const seenIds = new Set<string>();

    for await (const entry of list) {
      // Key format: [INSTANCE_ID, "device", deviceId, "ui_definition"] or similar
      const deviceId = entry.key[2];
      if (typeof deviceId !== "string" || seenIds.has(deviceId)) continue;
      seenIds.add(deviceId);

      const tGetStart = performance.now();
      const uiDef = await getUIDefinition(deviceId);
      const statusRes = await kv.get<GlobalDeviceStatus>(pk("device", deviceId, "status"));
      dbGetTime += performance.now() - tGetStart;

      // Determine state - default to detached if not found
      let state = "detached";
      if (statusRes.value) {
        state = statusRes.value.state;
        
        // Dynamic stale state check
        if (state !== "detached" && state !== "disconnected") {
          const tTeleStart = performance.now();
          const lastTelemetry = await getLatestTelemetry(deviceId);
          dbGetTime += performance.now() - tTeleStart;

          if (lastTelemetry && (Date.now() - lastTelemetry.timestamp > 10000)) {
            state = "stale";
          }
        }
      }

      devicesList.push({
        deviceId,
        title: uiDef ? (uiDef as any).payload?.title || "Unnamed Device" : "Unnamed Device",
        state,
        controllerSessionId: statusRes.value ? statusRes.value.controllerSessionId : null
      });
    }

    const tTotal = performance.now() - tStart;
    console.log(`[Telemetry] /api/devices processed in ${tTotal.toFixed(1)}ms (gets: ${dbGetTime.toFixed(1)}ms)`);

    return new Response(JSON.stringify(devicesList), {
      headers: { 
        "content-type": "application/json; charset=utf-8",
        "Server-Timing": `db_gets;dur=${dbGetTime.toFixed(1)};desc="KV Gets", total;dur=${tTotal.toFixed(1)};desc="Total Time"`
      },
    });
  }

  // REST API: Update settings (like history TTL) for a device
  if (path === "/api/devices/settings" && req.method === "POST") {
    const body = await req.json();
    const { deviceId, historyTtlDays } = body;
    
    if (!deviceId || historyTtlDays === undefined) {
      return new Response(JSON.stringify({ success: false, error: "Missing deviceId or historyTtlDays" }), { status: 400 });
    }
    
    await kv.set(pk("device", deviceId, "settings"), { historyTtlDays: Number(historyTtlDays) });
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // Render separate dedicated Storage Stats & Log Diagnostics page
  if (path === "/devices/stats") {
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) {
      return Response.redirect(`${url.origin}/devices`, 302);
    }
    return new Response(getStatsPageHtml(deviceId), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // REST API: Get stats for a single device on-demand
  if (path === "/api/devices/stats") {
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) {
      return new Response(JSON.stringify({ success: false, error: "Missing device_id" }), { status: 400 });
    }

    const uiDef = await getUIDefinition(deviceId);
    const settingsRes = await kv.get<{ historyTtlDays: number }>(pk("device", deviceId, "settings"));
    const historyTtlDays = settingsRes.value ? settingsRes.value.historyTtlDays : 7;

    let historyCount = 0;
    let historyBytes = 0;
    const historyIter = kv.list({ prefix: pk("device", deviceId, "history") });
    for await (const entry of historyIter) {
      historyCount++;
      const serialized = JSON.stringify(entry.value);
      historyBytes += serialized.length + 30;
    }

    return new Response(JSON.stringify({
      deviceId,
      title: uiDef ? (uiDef as any).payload?.title || "Unnamed Device" : "Unnamed Device",
      historyCount,
      historyBytes,
      historyTtlDays
    }), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  // REST API: Wipe configuration and logs for a device
  if (path === "/api/devices/delete" && req.method === "POST") {
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) {
      return new Response(JSON.stringify({ success: false, error: "Missing device_id" }), { status: 400 });
    }

    await kv.delete(pk("device", deviceId, "ui_definition"));
    await kv.delete(pk("device", deviceId, "latest"));
    await kv.delete(pk("device", deviceId, "status"));

    const historyIter = kv.list({ prefix: pk("device", deviceId, "history") });
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
