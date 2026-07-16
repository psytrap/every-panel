// tests/auth_integration_test.ts
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.200.0/assert/mod.ts";
import { fromFileUrl, join } from "https://deno.land/std@0.200.0/path/mod.ts";
import denoConfig from "../deno.json" with { type: "json" };

const expectedVersion = `v${denoConfig.version} (${denoConfig.releaseDate})`;

const mainTsPath = join(fromFileUrl(import.meta.url), "../../src/main.ts");
const port = "8006";

Deno.test("Mock Authentication Integration: OAuth boundary and session verification", async () => {
  // Start server subprocess on port 8006
  // Configure MOCK_AUTH=true, DISABLE_AUTH=false, and GITHUB_CLIENT credentials to run OAuth router
  const serverProc = new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", "--unstable-kv", mainTsPath],
    env: {
      PORT: port,
      DISABLE_AUTH: "false",
      MOCK_AUTH: "true",
      ALLOWED_GITHUB_USERS: "alice,bob",
      GITHUB_CLIENT_ID: "mock_client_id",
      GITHUB_CLIENT_SECRET: "mock_client_secret",
      KV_PATH: ":memory:"
    }
  }).spawn();

  // Wait 1000ms for server to startup and bind port
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    const baseUrl = `http://localhost:${port}`;

    // Test Case 1: Unauthenticated request to "/" or "/devices" redirects to "/login"
    console.log("[Test] 1. Verifying unauthenticated access gets redirected...");
    const unauthRes = await fetch(`${baseUrl}/devices`, { redirect: "manual" });
    assertEquals(unauthRes.status, 302);
    assertEquals(unauthRes.headers.get("location"), `${baseUrl}/login`);
    await unauthRes.body?.cancel();

    // Verify that the login UI actively displays mock auth indicators to the user
    console.log("[Test] 1b. Verifying Mock Auth warnings are visible on the login UI...");
    const loginPageRes = await fetch(`${baseUrl}/login`);
    assertEquals(loginPageRes.status, 200);
    const loginHtml = await loginPageRes.text();
    assertEquals(loginHtml.includes("Mock Authentication Active"), true);
    assertEquals(loginHtml.includes("Developer Login"), true);
    // Verify version tag is present on the login UI
    assertEquals(loginHtml.includes(expectedVersion), true);

    // Test Case 2: Block login of unauthorized user (not in allowed list)
    console.log("[Test] 2. Verifying unauthorized user is blocked...");
    const githubRedirectRes = await fetch(`${baseUrl}/login/github?mock_code=charlie`, { redirect: "manual" });
    assertEquals(githubRedirectRes.status, 302);
    const callbackUrl = githubRedirectRes.headers.get("location") || "";
    assertEquals(callbackUrl, `${baseUrl}/login/callback?code=charlie`);
    await githubRedirectRes.body?.cancel();

    const failLoginRes = await fetch(callbackUrl, { redirect: "manual" });
    assertEquals(failLoginRes.status, 302);
    // Redirects to login with not_allowed error code
    assertEquals(failLoginRes.headers.get("location"), `${baseUrl}/login?error=not_allowed`);
    assertEquals(failLoginRes.headers.get("set-cookie"), null); // No cookie should be set
    await failLoginRes.body?.cancel();

    // Test Case 3: Successful login of an allowed user
    console.log("[Test] 3. Verifying allowed user gets successfully logged in...");
    const githubRedirectSuccessRes = await fetch(`${baseUrl}/login/github?mock_code=alice`, { redirect: "manual" });
    assertEquals(githubRedirectSuccessRes.status, 302);
    const callbackSuccessUrl = githubRedirectSuccessRes.headers.get("location") || "";
    assertEquals(callbackSuccessUrl, `${baseUrl}/login/callback?code=alice`);
    await githubRedirectSuccessRes.body?.cancel();

    const successLoginRes = await fetch(callbackSuccessUrl, { redirect: "manual" });
    assertEquals(successLoginRes.status, 302);
    assertEquals(successLoginRes.headers.get("location"), "/");
    
    // Read the session cookie from Set-Cookie header
    const cookieHeader = successLoginRes.headers.get("set-cookie");
    assertNotEquals(cookieHeader, null);
    
    const cookieMatch = cookieHeader!.match(/every_panel_session=([^;]+)/);
    assertNotEquals(cookieMatch, null);
    const sessionId = cookieMatch![1];
    assertNotEquals(sessionId, "");
    await successLoginRes.body?.cancel();

    // Test Case 4: Authenticated requests succeed
    console.log("[Test] 4. Verifying authenticated page loads succeed with cookie...");
    const authPageRes = await fetch(`${baseUrl}/devices`, {
      headers: { "Cookie": `every_panel_session=${sessionId}` }
    });
    assertEquals(authPageRes.status, 200);
    const htmlText = await authPageRes.text();
    assertEquals(htmlText.includes("Device Directory"), true);
    // Verify that the header contains the visual "Mock Auth" warning badge
    assertEquals(htmlText.includes("Mock Auth"), true);
    // Verify that the header contains the version tag
    assertEquals(htmlText.includes(expectedVersion), true);

    const testUuid = "e0821c8b-ff4b-48ae-94a2-9b2ee0c6488d";

    // Register the test device using the authenticated session
    console.log("[Test] 4a. Registering test device via authenticated endpoint...");
    const regRes = await fetch(`${baseUrl}/api/devices/add`, {
      method: "POST",
      headers: {
        "Cookie": `every_panel_session=${sessionId}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ deviceId: testUuid })
    });
    assertEquals(regRes.status, 200);
    const regJson = await regRes.json();
    assertEquals(regJson.success, true);
    const testUuidKey = regJson.deviceKey;

    // Verify stats diagnostics page is secure and loads correctly
    console.log("[Test] 4b. Verifying stats view and stats REST API load successfully...");
    const statsViewRes = await fetch(`${baseUrl}/devices/stats?device_id=${testUuid}`, {
      headers: { "Cookie": `every_panel_session=${sessionId}` }
    });
    assertEquals(statsViewRes.status, 200);
    const statsHtml = await statsViewRes.text();
    assertEquals(statsHtml.includes("Storage & Logs Diagnostics"), true);

    const statsApiRes = await fetch(`${baseUrl}/api/devices/stats?device_id=${testUuid}`, {
      headers: { "Cookie": `every_panel_session=${sessionId}` }
    });
    assertEquals(statsApiRes.status, 200);
    const statsJson = await statsApiRes.json();
    assertEquals(statsJson.deviceId, testUuid);
    assertEquals(typeof statsJson.historyCount, "number");
    assertEquals(typeof statsJson.historyBytes, "number");

    // Verify WebSocket connection upgrade security via X-Device-Key headers and subprotocols
    console.log("[Test] 4c. Verifying WebSocket upgrades require valid keys in headers/protocols...");
    
    // 1. Connection fails with bad key in header
    const wsFailRes = await fetch(`${baseUrl}/ws?role=device&device_id=${testUuid}`, {
      headers: { "X-Device-Key": "wrong_key_123" }
    });
    assertEquals(wsFailRes.status, 403);
    await wsFailRes.body?.cancel();

    // 2. Connection fails with bad key in subprotocols
    const wsFailProtoRes = await fetch(`${baseUrl}/ws?role=device&device_id=${testUuid}`, {
      headers: {
        "Connection": "Upgrade",
        "Upgrade": "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Protocol": "every-panel-device-auth, wrong_proto_key_123"
      }
    });
    assertEquals(wsFailProtoRes.status, 403);
    await wsFailProtoRes.body?.cancel();

    // 3. Connection upgrades successfully with correct key in header
    const wsSuccessRes = await fetch(`${baseUrl}/ws?role=device&device_id=${testUuid}`, {
      headers: {
        "Connection": "Upgrade",
        "Upgrade": "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        "X-Device-Key": testUuidKey
      }
    });
    assertEquals(wsSuccessRes.status, 101); // 101 Switching Protocols
    await wsSuccessRes.body?.cancel();

    // 4. Connection upgrades successfully with correct key in subprotocols
    const wsSuccessProtoRes = await fetch(`${baseUrl}/ws?role=device&device_id=${testUuid}`, {
      headers: {
        "Connection": "Upgrade",
        "Upgrade": "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Protocol": `every-panel-device-auth, ${testUuidKey}`
      }
    });
    assertEquals(wsSuccessProtoRes.status, 101); // 101 Switching Protocols
    await wsSuccessProtoRes.body?.cancel();

    // 4d. Connection upgrades successfully with correct key in URL query parameter fallback
    const wsSuccessQueryRes = await fetch(`${baseUrl}/ws?role=device&device_id=${testUuid}&device_key=${testUuidKey}`, {
      headers: {
        "Connection": "Upgrade",
        "Upgrade": "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13"
      }
    });
    assertEquals(wsSuccessQueryRes.status, 101); // 101 Switching Protocols
    await wsSuccessQueryRes.body?.cancel();

    // Test Case 5: Logout invalidates and deletes the session
    console.log("[Test] 5. Verifying logout routine clears session state...");
    const logoutRes = await fetch(`${baseUrl}/logout`, {
      method: "GET",
      headers: { "Cookie": `every_panel_session=${sessionId}` },
      redirect: "manual"
    });
    assertEquals(logoutRes.status, 302);
    assertEquals(logoutRes.headers.get("location"), "/login");
    
    // Cookie header should be expired
    const expiredCookieHeader = logoutRes.headers.get("set-cookie") || "";
    assertEquals(expiredCookieHeader.includes("Max-Age=0") || expiredCookieHeader.includes("Expires=Thu, 01 Jan 1970"), true);
    await logoutRes.body?.cancel();

    // Test Case 6: Verifying subsequent request with the same session cookie gets redirected
    console.log("[Test] 6. Verifying subsequent requests with logged-out cookie fail...");
    const postLogoutRes = await fetch(`${baseUrl}/devices`, {
      headers: { "Cookie": `every_panel_session=${sessionId}` },
      redirect: "manual"
    });
    assertEquals(postLogoutRes.status, 302);
    assertEquals(postLogoutRes.headers.get("location"), `${baseUrl}/login`);
    await postLogoutRes.body?.cancel();

  } finally {
    // Terminate server process safely and wait for it to exit to avoid resource leak warnings
    console.log("[Test] Terminating server subprocess...");
    try {
      serverProc.kill();
      await serverProc.status;
    } catch {
      // ignore
    }
  }
});
