// tests/auth_integration_test.ts
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.200.0/assert/mod.ts";
import { fromFileUrl, join } from "https://deno.land/std@0.200.0/path/mod.ts";

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
