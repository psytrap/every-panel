import { DISABLE_AUTH, MOCK_AUTH } from "./db.ts";
import denoConfig from "../deno.json" with { type: "json" };

export function getLoginHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - Every-Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
    <div class="login-container">
    <div class="login-card glass">
      <h2>Every-Panel Hub <span style="font-size:12px; font-weight:400; opacity:0.6; vertical-align:middle; margin-left:8px;">v${denoConfig.version} (${denoConfig.releaseDate})</span></h2>
      <p>${MOCK_AUTH ? "Developer testing login interface" : "Secure login with your GitHub account"}</p>
      
      ${MOCK_AUTH ? `
      <!-- Developer Mock Auth Input Form -->
      <form action="/login/callback" method="GET" style="display:flex; flex-direction:column; gap:12px; margin-top:20px; width:100%;">
        <div style="background: rgba(217, 119, 6, 0.15); border: 1px solid rgba(217, 119, 6, 0.4); border-radius: 8px; padding: 10px; color: #fcd34d; font-size: 12px; text-align: center; font-weight:500;">
          ⚠️ Mock Authentication Active
        </div>
        <input type="text" name="code" placeholder="Enter mock username (e.g. alice)" required style="padding:10px 14px; border-radius:8px; background:rgba(255,255,255,0.05); border:1px solid var(--border-color); color:var(--text-primary); font-family:'Outfit', sans-serif; outline:none; font-size:14px; text-align:center;">
        <button type="submit" class="btn-action active-lease" style="padding:10px; font-weight:600; cursor:pointer;">Developer Login</button>
      </form>
      ` : `
      <a href="/login/github" class="btn-github">
        <svg style="width:24px;height:24px;" viewBox="0 0 24 24"><path fill="currentColor" d="M12,2A10,10 0 0,0 2,12C2,16.42 4.87,20.17 8.84,21.5C9.34,21.58 9.5,21.27 9.5,21C9.5,20.77 9.5,20.14 9.5,19.31C6.73,19.91 6.14,17.97 6.14,17.97C5.68,16.81 5.03,16.5 5.03,16.5C4.12,15.88 5.1,15.9 5.1,15.9C6.1,15.97 6.63,16.93 6.63,16.93C7.5,18.45 8.97,18 9.54,17.76C9.63,17.11 9.89,16.67 10.17,16.42C7.95,16.17 5.62,15.31 5.62,11.5C5.62,10.39 6,9.5 6.65,8.79C6.55,8.54 6.2,7.5 6.75,6.15C6.75,6.15 7.59,5.88 9.5,7.17C10.29,6.95 11.15,6.84 12,6.84C12.85,6.84 13.71,6.95 14.5,7.17C16.41,5.88 17.25,6.15 17.25,6.15C17.8,7.5 17.45,8.54 17.35,8.79C18,9.5 18.38,10.39 18.38,11.5C18.38,15.32 16.04,16.16 13.81,16.41C14.17,16.72 14.5,17.33 14.5,18.26C14.5,19.6 14.5,20.68 14.5,21C14.5,21.27 14.66,21.59 15.17,21.5C19.14,20.16 22,16.42 22,12A10,10 0 0,0 12,2Z"/></svg>
        <span>Authenticate with GitHub</span>
      </a>
      `}
      
      <div id="error-box"></div>
    </div>
  </div>

  <script src="/public/login.js"></script>
</body>
</html>
  `;
}

// Helper to construct index HTML dynamically based on DISABLE_AUTH
export function getPanelHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Every-Panel - IoT Hub</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
  <header class="glass">
    <div class="header-title">
      <h1>
        <svg style="width:24px;height:24px;" viewBox="0 0 24 24"><path fill="currentColor" d="M19,5V19H5V5H19M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M14,17H7V15H14V17M17,13H7V11H17V13M17,9H7V7H17V9Z"/></svg>
        <span id="app-title">Every-Panel</span>
        <span style="font-size:11px; opacity:0.5; font-weight:400; margin-left:6px; vertical-align:middle; display:inline-block;">v${denoConfig.version} (${denoConfig.releaseDate})</span>
        ${MOCK_AUTH ? '<span style="font-size:10px; background:#d97706; color:white; padding:2px 8px; border-radius:9999px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-left:8px; vertical-align:middle; display:inline-block;">Mock Auth</span>' : ''}
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

  <script src="/public/panel.js"></script>
</body>
</html>
  `;
}

// Helper to construct the Devices Directory UI page
export function getDevicesDirectoryHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Device Directory - Every-Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
  <header class="glass">
    <div class="header-title">
      <h1>
        <svg style="width:24px;height:24px;" viewBox="0 0 24 24"><path fill="currentColor" d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8Z"/></svg>
        <span>Every-Panel Hub Directory</span>
        <span style="font-size:11px; opacity:0.5; font-weight:400; margin-left:6px; vertical-align:middle; display:inline-block;">v${denoConfig.version} (${denoConfig.releaseDate})</span>
        ${MOCK_AUTH ? '<span style="font-size:10px; background:#d97706; color:white; padding:2px 8px; border-radius:9999px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-left:8px; vertical-align:middle; display:inline-block;">Mock Auth</span>' : ''}
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
        <div style="display:flex; gap:10px;">
          <button onclick="showAddDeviceModal()" class="btn-action active-lease">Register Device</button>
          <button onclick="loadDevices()" class="btn-action">Refresh List</button>
        </div>
      </div>

      <div id="directory-summary-bar" class="directory-summary" style="display:none;"></div>

      <div id="device-list-container" class="layout-row">
        <!-- Rendered list items -->
      </div>

      <!-- Telemetry Diagnostics Badge Panel -->
      <div id="telemetry-diagnostics" class="directory-summary" style="display:none; margin-top:20px; font-size:12px; opacity:0.8; justify-content:center; gap:16px;"></div>

      <!-- Add Device Modal -->
      <div id="add-device-modal" class="glass" style="display:none; position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); width:90%; max-width:450px; z-index:1000; padding:24px; border-radius:16px; box-shadow:0 8px 32px rgba(0,0,0,0.5);">
        <h3 style="font-size:18px; font-weight:600; margin-bottom:12px; color:var(--text-primary);">Register New Device</h3>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:8px;">Enter a unique UUID to authorize this IoT device to connect to the panel dashboard.</p>
        <input type="text" id="add-device-input" placeholder="e.g. e0821c8b-ff4b-48ae-94a2-9b2ee0c6488d" style="width:100%; padding:10px 14px; margin-bottom:16px; border-radius:8px; background:rgba(255,255,255,0.05); border:1px solid var(--border-color); color:var(--text-primary); font-family:'Outfit', sans-serif; font-size:14px; outline:none; text-align:center; box-sizing:border-box;">
        
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:8px;">Device Key (Secret passcode, optional - will auto-generate if empty):</p>
        <input type="password" id="add-device-key-input" placeholder="e.g. secret_passcode_123" style="width:100%; padding:10px 14px; margin-bottom:20px; border-radius:8px; background:rgba(255,255,255,0.05); border:1px solid var(--border-color); color:var(--text-primary); font-family:'Outfit', sans-serif; font-size:14px; outline:none; text-align:center; box-sizing:border-box;">
        
        <div style="display:flex; justify-content:flex-end; gap:12px;">
          <button onclick="hideAddDeviceModal()" class="btn-action" style="background:rgba(255,255,255,0.05); border:1px solid var(--border-color); color:var(--text-primary); padding:8px 16px;">Cancel</button>
          <button onclick="submitAddDevice()" class="btn-action active-lease" style="padding:8px 16px;">Register Device</button>
        </div>
      </div>
      <!-- Backdrop -->
      <div id="modal-backdrop" onclick="hideAddDeviceModal()" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); backdrop-filter:blur(4px); z-index:999;"></div>
    </div>
  </main>

  <script src="/public/devices.js"></script>
</body>
</html>
  `;
}

export function getStatsPageHtml(deviceId: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storage Stats - Every-Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
  <header class="glass">
    <div class="header-title">
      <h1>
        <svg style="width:24px;height:24px;" viewBox="0 0 24 24"><path fill="currentColor" d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8Z"/></svg>
        <span>Storage & Logs Diagnostics</span>
        <span style="font-size:11px; opacity:0.5; font-weight:400; margin-left:6px; vertical-align:middle; display:inline-block;">v${denoConfig.version} (${denoConfig.releaseDate})</span>
        ${MOCK_AUTH ? '<span style="font-size:10px; background:#d97706; color:white; padding:2px 8px; border-radius:9999px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-left:8px; vertical-align:middle; display:inline-block;">Mock Auth</span>' : ''}
      </h1>
    </div>
    <div class="header-controls">
      <a href="/devices" class="btn-action" style="text-decoration:none; display:inline-flex; align-items:center; gap:6px;">Back to Directory</a>
    </div>
  </header>

  <main>
    <div class="directory-container" style="max-width:800px;">
      <div class="glass" style="padding:30px; border-radius:16px;">
        <h2 id="device-title" style="font-size:22px; font-weight:600; margin-bottom:4px;">Loading Device Storage Details...</h2>
        <p id="device-uuid" style="font-size:13px; color:var(--text-secondary); font-family:monospace; margin-bottom:24px;">${deviceId}</p>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:20px; margin-bottom:30px;">
          <div class="glass" style="padding:20px; text-align:center; border-radius:12px; background:rgba(255,255,255,0.02);">
            <div style="font-size:12px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Total Database Entries</div>
            <div id="stat-count" style="font-size:32px; font-weight:700; color:var(--text-primary);">--</div>
          </div>
          <div class="glass" style="padding:20px; text-align:center; border-radius:12px; background:rgba(255,255,255,0.02);">
            <div style="font-size:12px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Estimated Footprint</div>
            <div id="stat-bytes" style="font-size:32px; font-weight:700; color:var(--text-primary);">--</div>
          </div>
          <div class="glass" style="padding:20px; text-align:center; border-radius:12px; background:rgba(255,255,255,0.02);">
            <div style="font-size:12px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Retention Policy</div>
            <div id="stat-retention" style="font-size:32px; font-weight:700; color:var(--text-primary);">--</div>
          </div>
          <div class="glass" style="padding:20px; text-align:center; border-radius:12px; background:rgba(255,255,255,0.02);">
            <div style="font-size:12px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Device Key (Secret)</div>
            <div id="stat-key" style="font-size:15px; font-weight:600; color:var(--text-primary); font-family:monospace; padding-top:12px; word-break:break-all;">--</div>
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:20px; border-top: 1px solid var(--border-color); padding-top:24px;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
            <div>
              <h3 style="font-size:16px; font-weight:500; margin-bottom:4px;">Configure Log Ingestion Retention</h3>
              <p style="font-size:13px; color:var(--text-secondary);">Set when database telemetry entries automatically expire from Deno KV.</p>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <select id="retention-select" style="padding:8px 12px; font-size:14px; border-radius:8px; background:rgba(255,255,255,0.05); border:1px solid var(--border-color); color:var(--text-primary); cursor:pointer; font-family:'Outfit', sans-serif;">
                <option value="1">1 Day</option>
                <option value="7">7 Days</option>
                <option value="30">30 Days</option>
                <option value="365">1 Year</option>
                <option value="0">Infinite</option>
              </select>
              <button onclick="updateRetention()" class="btn-action active-lease" style="padding:8px 16px;">Apply Policy</button>
            </div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; border-top: 1px solid rgba(255,255,255,0.05); padding-top:20px;">
            <div>
              <h3 style="font-size:16px; font-weight:500; margin-bottom:4px; color:var(--danger-color);">Danger Zone</h3>
              <p style="font-size:13px; color:var(--text-secondary);">Purges all historical logs and layout schemas for this device.</p>
            </div>
            <button onclick="wipeStorage()" class="btn-delete" style="padding:10px 20px;">Wipe Device Storage</button>
          </div>
        </div>
      </div>
    </div>
  </main>

  <script>
    const deviceId = "${deviceId}";

    async function loadStats() {
      try {
        const res = await fetch(\`/api/devices/stats?device_id=\${deviceId}\`);
        const stats = await res.json();
        
        document.getElementById("device-title").innerText = stats.title;
        document.getElementById("stat-count").innerText = stats.historyCount.toLocaleString();
        document.getElementById("stat-bytes").innerText = formatBytes(stats.historyBytes);
        document.getElementById("stat-retention").innerText = formatRetention(stats.historyTtlDays);
        document.getElementById("retention-select").value = stats.historyTtlDays;
        document.getElementById("stat-key").innerText = stats.deviceKey;
      } catch (e) {
        document.getElementById("device-title").innerText = "Error loading stats";
      }
    }

    function formatBytes(bytes) {
      if (bytes === 0) return "0 Bytes";
      const k = 1024;
      const sizes = ["Bytes", "KB", "MB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    }

    function formatRetention(days) {
      if (days === 0) return "Infinite";
      if (days === 1) return "1 Day";
      if (days === 365) return "1 Year";
      return days + " Days";
    }

    async function updateRetention() {
      const days = document.getElementById("retention-select").value;
      try {
        const res = await fetch("/api/devices/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId, historyTtlDays: Number(days) })
        });
        const data = await res.json();
        if (data.success) {
          alert("Retention policy updated successfully!");
          loadStats();
        } else {
          alert("Failed: " + data.error);
        }
      } catch (e) {
        alert("Failed to update policy.");
      }
    }

    async function wipeStorage() {
      if (!confirm("Are you sure you want to completely wipe all historical logs and configuration for this device?")) return;
      try {
        const res = await fetch(\`/api/devices/delete?device_id=\${deviceId}\`, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          alert("Device storage wiped successfully!");
          window.location.href = "/devices";
        }
      } catch (e) {
        alert("Failed to wipe storage.");
      }
    }

    loadStats();
  </script>
</body>
</html>
  `;
}

