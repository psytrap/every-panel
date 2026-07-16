import { assertEquals } from "https://deno.land/std@0.200.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.200.0/path/mod.ts";

const mainTsPath = fromFileUrl(new URL("../src/main.ts", import.meta.url));

// Helper function to wait for a matching JSON message on a WebSocket connection
function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", listener);
      reject(new Error("Timeout waiting for WebSocket message matching condition"));
    }, timeoutMs);

    function listener(event: MessageEvent) {
      try {
        const data = JSON.parse(event.data);
        if (predicate(data)) {
          clearTimeout(timer);
          ws.removeEventListener("message", listener);
          resolve(data);
        }
      } catch { /* ignore non-JSON messages */ }
    }

    ws.addEventListener("message", listener);
  });
}

// Auto-reply to server pings with a pong on behalf of a mock UI client
function autoReplyPong(ws: WebSocket) {
  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "ping" && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch { /* ignore */ }
  });
}

Deno.test({
  name: "Mock WebSocket Integration: Concurrency, Control Lease, and Command Routing",
  fn: async () => {
    // 1. Launch Every-Panel Server in a subprocess (on test port 8005)
    const port = "8005";
    const testDbPath = ":memory:";

    const serverProc = new Deno.Command("deno", {
      args: ["run", "--allow-net", "--allow-env", "--allow-read", "--unstable-kv", mainTsPath],
      env: { DISABLE_AUTH: "true", PORT: port, KV_PATH: testDbPath, PING_INTERVAL_MS: "5000" }
    }).spawn();

    // Give server 1.5 seconds to bind to port 8005
    await new Promise(resolve => setTimeout(resolve, 1500));

    const deviceId = "e0821c8b-ff4b-48ae-94a2-9b2ee0c6488d";
    const deviceKey = "mock_secret_key_123";
    
    // Authorize the device in the test server instance
    const authRes = await fetch(`http://localhost:${port}/api/devices/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, deviceKey })
    });
    assertEquals(authRes.status, 200);
    const authJson = await authRes.json();
    assertEquals(authJson.success, true);
    
    // Connect Mock WebSockets: Connect clients first to ensure they are registered for broadcasts
    const devUrl = `ws://localhost:${port}/ws?role=device&device_id=${deviceId}`;
    const clientAUrl = `ws://localhost:${port}/ws?role=client&device_id=${deviceId}&tab_id=tab-A`;
    const clientBUrl = `ws://localhost:${port}/ws?role=client&device_id=${deviceId}&tab_id=tab-B`;

    const clientAWs = new WebSocket(clientAUrl);
    const clientBWs = new WebSocket(clientBUrl);
    await Promise.all([
      new Promise(resolve => clientAWs.onopen = resolve),
      new Promise(resolve => clientBWs.onopen = resolve),
    ]);

    // Auto-reply pong to server pings for both UI clients
    autoReplyPong(clientAWs);
    autoReplyPong(clientBWs);

    const deviceWs = new WebSocket(devUrl, ["every-panel-device-auth", deviceKey]);
    await new Promise(resolve => deviceWs.onopen = resolve);

    try {
      console.log("\n[Test] WebSockets connected. Verifying system state loops...");

      // Step 1: Confirm initial state is 'live' (view-only) for client tabs
      const statusInitA = await waitForMessage(clientAWs, m => m.type === "status_update");
      assertEquals(statusInitA.state, "live");
      assertEquals(statusInitA.is_controller, false);

      // Step 2: Tab A acquires control lease
      console.log("[Test] Tab A requesting control lease lock...");
      
      // Hook up listeners BEFORE triggering status changes to prevent race conditions
      const updatePromiseA = waitForMessage(clientAWs, m => m.type === "status_update" && m.state === "control");
      const updatePromiseB = waitForMessage(clientBWs, m => m.type === "status_update" && m.state === "control");

      clientAWs.send(JSON.stringify({ type: "acquire_control", device_id: deviceId }));

      const [statusUpdateA, statusUpdateB] = await Promise.all([updatePromiseA, updatePromiseB]);
      assertEquals(statusUpdateA.is_controller, true);
      assertEquals(statusUpdateB.is_controller, false); // Tab B is locked out
      console.log("[Test] Exclusive lease assigned correctly!");

      // Step 3: Verify security block on Tab B (unauthorized write)
      console.log("[Test] Testing write security: Tab B sends unauthorized command...");
      const errorMsgPromise = waitForMessage(clientBWs, m => m.type === "error");

      clientBWs.send(JSON.stringify({
        type: "command",
        device_id: deviceId,
        action: "update",
        target: "slider",
        value: 12
      }));
      
      const errorMsg = await errorMsgPromise;
      assertEquals(errorMsg.message.includes("Denied"), true);
      console.log("[Test] Write Access successfully denied to Tab B!");

      // Step 4: Tab A sends authorized command (routed to device)
      console.log("[Test] Tab A sends command update...");
      const devCommandPromise = waitForMessage(deviceWs, m => m.type === "command");

      clientAWs.send(JSON.stringify({
        type: "command",
        device_id: deviceId,
        action: "update",
        target: "slider",
        value: 15
      }));

      // Mock device should receive the command
      const devCommand = await devCommandPromise;
      assertEquals(devCommand.target, "slider");
      assertEquals(devCommand.value, 15);
      console.log("[Test] Command enqueued and routed correctly to device!");

      // Step 5: Mock device responds with telemetry packet
      console.log("[Test] Device sending telemetry data stream...");
      const telemetryPromiseA = waitForMessage(clientAWs, m => m.type === "telemetry");
      const telemetryPromiseB = waitForMessage(clientBWs, m => m.type === "telemetry");

      deviceWs.send(JSON.stringify({
        type: "telemetry",
        device_id: deviceId,
        data: { slider: 15, temp: 22.4 }
      }));

      // Server should broadcast telemetry data to all viewing clients
      const [telemetryA, telemetryB] = await Promise.all([telemetryPromiseA, telemetryPromiseB]);
      assertEquals(telemetryA.data.slider, 15);
      assertEquals(telemetryB.data.slider, 15);
      console.log("[Test] Telemetry successfully looped back and broadcasted!");

      // Step 6: Auto-Release control lock on tab close
      console.log("[Test] Closing Tab A socket...");
      const liveUpdateBPromise = waitForMessage(clientBWs, m => m.type === "status_update" && m.state === "live");

      clientAWs.close();

      // Tab B should receive status update saying lease is released back to 'live' state
      const liveUpdateB = await liveUpdateBPromise;
      assertEquals(liveUpdateB.is_controller, false);
      console.log("[Test] Lease lock auto-released upon client disconnect!");

      // Step 7: Heartbeat — server pings UI clients, clients reply, device gets viewers_active
      // lastPong is primed on client connect, so viewers_active fires on the first 5s tick
      console.log("[Test] Waiting for server to ping UI clients and device to receive viewers_active...");
      const viewersActivePromise = waitForMessage(deviceWs, m => m.type === "viewers_active", 8000);
      // Tab B is still connected and auto-pong is active — server should send viewers_active to device
      const viewersActiveMsg = await viewersActivePromise;
      assertEquals(viewersActiveMsg.type, "viewers_active");
      console.log("[Test] Device correctly notified: viewers_active!");

      // Step 8: Disconnect remaining UI client — device should receive viewers_inactive
      console.log("[Test] Disconnecting last UI client (Tab B)...");
      clientBWs.close();
      // lastPong is expired on disconnect, so viewers_inactive fires on the next ~5s tick
      const viewersInactivePromise = waitForMessage(deviceWs, m => m.type === "viewers_inactive", 8000);
      const viewersInactiveMsg = await viewersInactivePromise;
      assertEquals(viewersInactiveMsg.type, "viewers_inactive");
      console.log("[Test] Device correctly notified: viewers_inactive after all UI tabs closed!");

    } finally {
      // Shutdown connections
      deviceWs.close();
      clientBWs.close();
      // Stop server subprocess
      console.log("[Test] Terminating server subprocess...");
      serverProc.kill();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

