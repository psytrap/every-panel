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
        <button onclick="loadDevices()" class="btn-action">Refresh List</button>
      </div>

      <div id="directory-summary-bar" class="directory-summary" style="display:none;"></div>

      <div id="device-list-container" class="layout-row">
        <!-- Rendered list items -->
      </div>
    </div>
  </main>

  <script src="/public/devices.js"></script>
</body>
</html>
  `;
}
