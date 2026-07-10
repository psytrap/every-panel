import { serve } from "https://deno.land/std@0.200.0/http/server.ts";

const PORT = Number(Deno.env.get("PORT")) || 8001;

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IoT Device Emulator Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0d0e15;
      --panel-bg: rgba(22, 28, 45, 0.45);
      --border-color: rgba(255, 255, 255, 0.08);
      --accent-color: #f59e0b; /* Amber/orange theme for device emulator */
      --accent-glow: rgba(245, 158, 11, 0.3);
      --success-color: #10b981;
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
      padding: 30px;
    }

    header {
      margin-bottom: 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      max-width: 1200px;
      width: 100%;
      margin: 0 auto 30px auto;
    }

    h1 {
      font-size: 22px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .glass {
      background: var(--panel-bg);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      box-shadow: 0 10px 40px 0 rgba(0, 0, 0, 0.45);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 500;
      padding: 6px 14px;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-color);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-secondary);
      box-shadow: 0 0 8px var(--text-secondary);
    }

    .status-badge.connected .status-dot {
      background: var(--success-color);
      box-shadow: 0 0 10px var(--success-color);
    }

    .status-badge.disconnected .status-dot {
      background: var(--danger-color);
      box-shadow: 0 0 10px var(--danger-color);
    }

    main {
      flex: 1;
      display: grid;
      grid-template-columns: 350px 1fr;
      gap: 30px;
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
    }

    @media (max-width: 900px) {
      main {
        grid-template-columns: 1fr;
      }
    }

    .control-section {
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      height: fit-content;
    }

    .config-card {
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 15px;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    label {
      font-size: 13px;
      color: var(--text-secondary);
      font-weight: 500;
    }

    .input-field {
      width: 100%;
      padding: 10px 14px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
    }

    .input-field:focus {
      outline: none;
      border-color: var(--accent-color);
    }

    .btn {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: none;
      background: var(--accent-color);
      color: #000;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
    }

    .btn:hover {
      box-shadow: 0 0 15px var(--accent-glow);
      background: #fbbf24;
    }

    .btn.btn-disconnect {
      background: var(--danger-color);
      color: #fff;
    }

    .btn.btn-disconnect:hover {
      box-shadow: 0 0 15px rgba(239, 68, 68, 0.4);
      background: #dc2626;
    }

    .knob-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }

    .knob-controls {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .knob-slider {
      accent-color: var(--accent-color);
      cursor: pointer;
    }

    .btn-fault {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: var(--danger-color);
      padding: 10px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: all 0.3s ease;
    }

    .btn-fault.active {
      background: var(--danger-color);
      color: #fff;
      box-shadow: 0 0 15px rgba(239, 68, 68, 0.4);
    }

    .console-panel {
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 15px;
      height: 600px;
    }

    .console-header {
      font-weight: 600;
      font-size: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .console-terminal {
      flex: 1;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      font-family: monospace;
      font-size: 13px;
      overflow-y: auto;
      color: #34d399; /* Green terminal text */
      line-height: 1.6;
    }

    .log-line {
      margin-bottom: 6px;
      border-bottom: 1px solid rgba(255,255,255,0.02);
      padding-bottom: 4px;
    }

    .log-time {
      color: var(--text-secondary);
      margin-right: 8px;
    }
  </style>
</head>
<body>
  <header>
    <h1>
      <svg style="width:28px;height:28px;color:var(--accent-color);" viewBox="0 0 24 24"><path fill="currentColor" d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8Z"/></svg>
      <span>IoT Device Emulator Panel</span>
    </h1>

    <div id="connection-badge" class="status-badge disconnected">
      <span class="status-dot"></span>
      <span id="status-text">Disconnected</span>
    </div>
  </header>

  <main>
    <!-- Left Configuration Side -->
    <div style="display:flex; flex-direction:column; gap:30px;">
      <div class="glass config-card">
        <h3>Server Config</h3>
        <div class="form-group">
          <label>Every-Panel Hub URL</label>
          <input type="text" id="hub-url" class="input-field" value="ws://localhost:8000/ws">
        </div>
        <div class="form-group">
          <label>Emulator Device ID</label>
          <input type="text" id="device-id" class="input-field" value="e0821c8b-ff4b-48ae-94a2-9b2ee0c6488d">
        </div>
        <button id="connect-btn" class="btn" onclick="toggleConnection()">Connect to Hub</button>
      </div>

      <!-- Simulated hardware state controls -->
      <div class="glass control-section">
        <h3>Device Hardware Knobs</h3>
        
        <div class="form-group">
          <label>Office Temperature</label>
          <div class="knob-row">
            <input type="range" id="knob-temp" class="knob-slider" min="15" max="35" step="0.1" value="21.5" oninput="updateKnobVal('temp', this.value)">
            <span id="val-temp" style="font-weight:600; color:var(--accent-color);">21.5°C</span>
          </div>
        </div>

        <div class="form-group">
          <label>Desk Light Level</label>
          <div class="knob-row">
            <input type="range" id="knob-light" class="knob-slider" min="50" max="800" step="10" value="350" oninput="updateKnobVal('light', this.value)">
            <span id="val-light" style="font-weight:600; color:var(--accent-color);">350lx</span>
          </div>
        </div>

        <div class="form-group">
          <label>Desk Fan Switch Relay</label>
          <div class="knob-row">
            <span>Fan Status</span>
            <input type="checkbox" id="knob-fan" style="width:20px; height:20px; cursor:pointer;" onchange="updateFanVal(this.checked)">
          </div>
        </div>

        <div class="form-group">
          <label>Constant Sensor Updates</label>
          <div class="knob-row">
            <span>Auto-Stream Telemetry (2s)</span>
            <input type="checkbox" id="knob-autostream" style="width:20px; height:20px; cursor:pointer;" checked onchange="toggleAutoStream(this.checked)">
          </div>
        </div>

        <div class="form-group" style="margin-top:10px;">
          <button id="fault-btn" class="btn-fault" onclick="toggleFault()">Simulate Hardware Fault</button>
        </div>
      </div>
    </div>

    <!-- Right Side Logger Terminal -->
    <div class="glass console-panel">
      <div class="console-header">
        <span>Device Connection Telemetry Logs</span>
        <button onclick="clearLogs()" class="btn-action" style="font-size:11px; padding:4px 8px; border:1px solid var(--border-color); background:transparent; color:var(--text-secondary); border-radius:4px; cursor:pointer;">Clear Logs</button>
      </div>
      <div id="terminal" class="console-terminal">
        <div class="log-line"><span class="log-time">[System]</span> Ready. Set Hub configurations and click Connect.</div>
      </div>
    </div>
  </main>

  <script>
    let ws = null;
    let telemetryTimer = null;

    // Local device simulated hardware values
    let tempVal = 21.5;
    let lightVal = 350;
    let fanVal = false;
    let hasFault = false;
    let autoStreamActive = true;

    function log(message, category = "Info") {
      const term = document.getElementById("terminal");
      const time = new Date().toLocaleTimeString();
      const line = document.createElement("div");
      line.className = "log-line";
      
      let categoryColor = "#34d399";
      if (category === "Command") categoryColor = "#60a5fa";
      if (category === "Error") categoryColor = "#ef4444";
      if (category === "System") categoryColor = "#9ca3af";

      line.innerHTML = \`<span class="log-time">[\${time}]</span> <span style="color:\${categoryColor}; font-weight:500;">[\${category}]</span> \${message}\`;
      term.appendChild(line);
      term.scrollTop = term.scrollHeight;
    }

    function clearLogs() {
      document.getElementById("terminal").innerHTML = "";
      log("Logs cleared.", "System");
    }

    function updateKnobVal(type, val) {
      if (type === 'temp') {
        tempVal = Number(val);
        document.getElementById("val-temp").innerText = tempVal.toFixed(1) + "°C";
      } else if (type === 'light') {
        lightVal = Number(val);
        document.getElementById("val-light").innerText = lightVal + "lx";
      }
      // Send telemetry updates immediately on slider shift
      sendTelemetryPacket();
    }

    function updateFanVal(checked) {
      fanVal = !!checked;
      log(\`Fan switch manually flipped to: \${fanVal}\`, "Info");
      sendTelemetryPacket();
    }

    function toggleFault() {
      hasFault = !hasFault;
      const btn = document.getElementById("fault-btn");
      if (hasFault) {
        btn.classList.add("active");
        btn.innerText = "Clear Hardware Fault";
        log("Simulated Hardware Fault triggered!", "Error");
      } else {
        btn.classList.remove("active");
        btn.innerText = "Simulate Hardware Fault";
        log("Hardware Fault cleared.", "System");
      }
      sendTelemetryPacket();
    }

    function toggleAutoStream(checked) {
      autoStreamActive = !!checked;
      log("Auto-Stream Telemetry set to: " + autoStreamActive, "System");
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (autoStreamActive) {
          if (telemetryTimer) clearInterval(telemetryTimer);
          telemetryTimer = setInterval(sendTelemetryPacket, 2000);
          log("Constant sensor updates started.", "System");
        } else {
          if (telemetryTimer) {
            clearInterval(telemetryTimer);
            telemetryTimer = null;
          }
          log("Constant sensor updates paused.", "System");
        }
      }
    }

    function toggleConnection() {
      const btn = document.getElementById("connect-btn");
      if (ws) {
        disconnect();
      } else {
        connect();
      }
    }

    function connect() {
      const hubUrl = document.getElementById("hub-url").value.trim();
      const deviceId = document.getElementById("device-id").value.trim();
      const connectBtn = document.getElementById("connect-btn");
      const badge = document.getElementById("connection-badge");
      const statusText = document.getElementById("status-text");

      const wsTarget = hubUrl + "?role=device&device_id=" + deviceId;
      log(\`Attempting WebSocket connection to: \${wsTarget}...\`, "System");

      ws = new WebSocket(wsTarget);

      ws.onopen = () => {
        log("Connection established successfully with Every-Panel hub.", "System");
        connectBtn.innerText = "Disconnect";
        connectBtn.className = "btn btn-disconnect";
        badge.className = "status-badge connected";
        statusText.innerText = "Connected";

        // 1. Upload UI layout definition
        sendLayoutDefinition(deviceId);

        // 2. Start streaming telemetry every 2 seconds if auto-stream is enabled
        if (autoStreamActive) {
          telemetryTimer = setInterval(sendTelemetryPacket, 2000);
        } else {
          log("Auto-stream is disabled. Telemetry will only send on manual adjustments.", "System");
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "ping") {
            // Heartbeat reply
            ws.send(JSON.stringify({ type: "pong" }));
          } 
          
          else if (msg.type === "command") {
            log(\`Incoming Command -> Target: '\${msg.target}', Action: \${msg.action}, Value: \${msg.value}\`, "Command");
            
            if (msg.target === "relay_1") {
              fanVal = !!msg.value;
              document.getElementById("knob-fan").checked = fanVal;
              sendTelemetryPacket();
            } 
            else if (msg.target === "number") {
              tempVal = Number(msg.value);
              document.getElementById("knob-temp").value = tempVal;
              document.getElementById("val-temp").innerText = tempVal.toFixed(1) + "°C";
              sendTelemetryPacket();
            }
             else if (msg.target === "slider") {
               // Map to companion slider controls
               const rawSlider = Number(msg.value);
               document.getElementById("knob-light").value = (rawSlider + 10) * 25 + 50; // exact linear map: [-10, 20] -> [50, 800]
               updateKnobVal('light', document.getElementById("knob-light").value);
             }
            // Trigger button-edges mock actions
            else if (msg.target === "button_edges") {
              toggleFault();
            }
            else if (msg.target === "button_fan") {
              fanVal = !fanVal;
              document.getElementById("knob-fan").checked = fanVal;
              sendTelemetryPacket();
            }
          }
        } catch (e) {
          log("Error parsing message: " + e.message, "Error");
        }
      };

      ws.onclose = () => {
        log("WebSocket connection closed.", "System");
        cleanupConnectionState();
      };

      ws.onerror = (e) => {
        log("WebSocket transport error occurred.", "Error");
      };
    }

    function disconnect() {
      if (ws) {
        ws.close();
      }
    }

    function cleanupConnectionState() {
      ws = null;
      if (telemetryTimer) {
        clearInterval(telemetryTimer);
        telemetryTimer = null;
      }
      const connectBtn = document.getElementById("connect-btn");
      const badge = document.getElementById("connection-badge");
      const statusText = document.getElementById("status-text");

      connectBtn.innerText = "Connect to Hub";
      connectBtn.className = "btn";
      badge.className = "status-badge disconnected";
      statusText.innerText = "Disconnected";
    }

    function sendLayoutDefinition(deviceId) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const payload = {
        type: "ui_definition",
        device_id: deviceId,
        layout_def: {
          "es-version": "0.0",
          "command": "page",
          "payload": {
            "title": "Interactive IoT Demo App",
            "type": "layout",
            "properties": {
              "id": "layout_rows",
              "flow": "row"
            },
            "layout": [
              {
                "type": "layout",
                "properties": {
                  "id": "layout_columns",
                  "flow": "column"
                },
                "layout": [
                  {
                    "type": "number",
                    "properties": {
                      "label": "Ambient Temperature (°C)",
                      "id": "number",
                      "step": ".1",
                      "value": String(tempVal),
                      "update": "false",
                      "readonly": "true"
                    }
                  },
                  {
                    "type": "number",
                    "properties": {
                      "label": "Fixed Baseline Target",
                      "id": "number_ro",
                      "step": ".1",
                      "value": "42.0",
                      "update": "false",
                      "readonly": "true"
                    }
                  }
                ]
              },
              {
                "type": "divider",
                "properties": {
                  "id": "divider"
                }
              },
              {
                "type": "layout",
                "properties": {
                  "id": "layout_buttons",
                  "flow": "column"
                },
                "layout": [
                  {
                    "type": "button",
                    "properties": {
                      "label": "Trigger Mock Alert Event",
                      "id": "button_clicked"
                    }
                  },
                  {
                    "type": "button",
                    "properties": {
                      "label": "Toggle Simulated Hardware Fault",
                      "id": "button_edges",
                      "edges": "true"
                    }
                  }
                ]
              },
              {
                "type": "layout",
                "properties": {
                  "id": "layout_fan",
                  "flow": "column"
                },
                "layout": [
                  {
                    "type": "text",
                    "properties": {
                      "label": "Desk Fan Status Indicator",
                      "id": "relay_1_text",
                      "value": "OFF",
                      "update": "false",
                      "readonly": "true"
                    }
                  },
                  {
                    "type": "button",
                    "properties": {
                      "label": "Toggle Desk Fan",
                      "id": "button_fan"
                    }
                  }
                ]
              },
              {
                "type": "text",
                "properties": {
                  "label": "Device Status Logger Input",
                  "id": "text",
                  "value": "Office Node #1 Active"
                }
              },
              {
                "type": "text",
                "properties": {
                  "label": "Console State Logs",
                  "id": "text_events",
                  "value": "Waiting for events...",
                  "update": "false",
                  "readonly": "true"
                }
              },
              {
                "type": "time",
                "properties": {
                  "id": "time",
                  "label": "Internal Clock",
                  "value": ""
                }
              },
              {
                "type": "text_view",
                "properties": {
                  "id": "text_view",
                  "value": "Stateless Deno IoT Node Emulator"
                }
              },
              {
                "type": "slider",
                "properties": {
                  "label": "Desk Light Level Slider",
                  "id": "slider",
                  "value": "2",
                  "min": "-10",
                  "max": "+20",
                  "step": "1"
                }
              },
              {
                "type": "number",
                "properties": {
                  "label": "Mapped Intensity Value",
                  "id": "number_slider",
                  "step": "1",
                  "value": "2",
                  "update": "false",
                  "readonly": "true"
                }
              }
            ]
          }
        }
      };

      log("Uploading dynamic layout definitions to the server...", "System");
      ws.send(JSON.stringify(payload));
    }

    function sendTelemetryPacket() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const deviceId = document.getElementById("device-id").value.trim();

      const payload = {
        type: "telemetry",
        device_id: deviceId,
        data: {
          number: Number(tempVal.toFixed(1)),
          number_ro: 42.0,
          text: document.getElementById("device-id").value + " active",
          text_events: hasFault ? "Simulated Hardware Fault Code E-04 active!" : "System running normally.",
          time: new Date().toLocaleTimeString(),
          text_view: "Stateless Deno IoT Emulator Node\\nUptime: Live",
          slider: Math.round((lightVal - 50) / 25) - 10,
          number_slider: Math.round((lightVal - 50) / 25) - 10,
          relay_1: fanVal,
          relay_1_text: fanVal ? "ON" : "OFF",
          fault: hasFault ? "Simulated Hardware Fault Code E-04" : null
        }
      };

      log(\`Sending Telemetry -> Temp: \${payload.data.number}°C, Light: \${lightVal}lx, Fan: \${payload.data.relay_1}, Fault: \${payload.data.fault ? 'Active' : 'None'}\`, "Info");
      ws.send(JSON.stringify(payload));
    }
  </script>
</body>
</html>
`;

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  if (url.pathname === "/") {
    return new Response(HTML_CONTENT, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("Not Found", { status: 404 });
}

console.log(`IoT Emulator Panel starting on port ${PORT}...`);
await serve(handler, { port: PORT });
