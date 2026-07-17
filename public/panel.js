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
    let lastPingReceivedTime = Date.now();
    let detectedPingInterval = 10000; // default/fallback (10 seconds)

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
      lastPingReceivedTime = Date.now();

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

        else if (msg.type === "ping") {
          // Server is checking if this panel is open — reply with pong, track timing, and update status
          const now = Date.now();
          const measuredInterval = now - lastPingReceivedTime;
          if (measuredInterval > 1000 && measuredInterval < 120000) {
            detectedPingInterval = measuredInterval;
          }
          lastPingReceivedTime = now;
          ws.send(JSON.stringify({ type: "pong" }));
          updatePanelState();
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
      if (Date.now() - lastPingReceivedTime > (detectedPingInterval * 3)) return "stale";
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
        container.innerHTML = `
          <div class="glass" style="padding:40px; text-align:center;">
            <p style="color:var(--text-secondary);">Device connected but has not uploaded a UI definition layout yet.</p>
          </div>
        `;
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
          card.innerHTML = `
            <label class="widget-label">${p.label || 'Number'}</label>
            <input type="number" id="input-${p.id}" class="widget-input" step="${p.step || 'any'}" value="${p.value || ''}" ${isReadonly ? 'readonly disabled' : ''}>
          `;
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
          card.innerHTML = `
            <label class="widget-label">${p.label || 'Text'}</label>
            <input type="text" id="input-${p.id}" class="widget-input" value="${p.value || ''}" ${isReadonly ? 'readonly disabled' : ''}>
          `;
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
          card.innerHTML = `
            <div id="view-${p.id}" class="widget-text-view">${p.value || ''}</div>
          `;
          const view = card.querySelector('.widget-text-view');
          valueElements.set(p.id, view);
          break;
        }

        case "time": {
          card.innerHTML = `
            <label class="widget-label">${p.label || 'Time'}</label>
            <div id="time-${p.id}" class="widget-indicator">--</div>
          `;
          const textEl = card.querySelector('.widget-indicator');
          valueElements.set(p.id, textEl);
          break;
        }

        case "button": {
          card.innerHTML = `
            <button id="btn-${p.id}" class="widget-btn">${p.label || 'Button'}</button>
          `;
          const btn = card.querySelector('button');
          inputElements.set(p.id, btn);
          
          btn.addEventListener('click', () => sendCommandClick(p.id));
          break;
        }

        case "image": {
          card.innerHTML = `
            <img id="img-${p.id}" class="widget-img" src="${p.src || ''}">
          `;
          const img = card.querySelector('img');
          valueElements.set(p.id, img);
          break;
        }

        case "slider": {
          card.innerHTML = `
            <div class="widget-range-container">
              <label class="widget-label">${p.label || 'Slider'}</label>
              <div class="widget-range-row">
                <input type="range" id="range-${p.id}" class="widget-range" min="${p.min || '0'}" max="${p.max || '100'}" step="${p.step || '1'}" value="${p.value || '0'}">
                <span id="range-val-${p.id}" class="widget-range-value">${p.value || '0'}</span>
              </div>
            </div>
          `;
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
        thermometer: `<svg class="widget-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M15 13V5A3 3 0 0 0 9 5V13A5 5 0 1 0 15 13M12 4A1 1 0 0 1 13 5V8H11V5A1 1 0 0 1 12 4M12 18A3 3 0 0 1 12 12V10H13V12A4 4 0 0 1 12 20A4 4 0 0 1 12 12A1.5 1.5 0 0 1 13.5 13.5A1.5 1.5 0 0 1 12 15A1.5 1.5 0 0 1 10.5 13.5A1.5 1.5 0 0 1 12 12H12Z"/></svg>`,
        sun: `<svg class="widget-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12,18C11.11,18 10.26,17.8 9.5,17.45L11.56,13.87C11.7,13.95 11.85,14 12,14A2,2 0 0,0 14,12C14,11.85 13.95,11.7 13.87,11.56L17.45,9.5C17.8,10.26 18,11.11 18,12A6,6 0 0,1 12,18M20,8.69V4H15.31L12,0.69L8.69,4H4V8.69L0.69,12L4,15.31V20H8.69L12,23.31L15.31,20H20V15.31L23.31,12L20,8.69Z"/></svg>`
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

      const res = await fetch(`/api/history?device_id=${deviceId}`);
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
