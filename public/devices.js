    async function loadDevices() {
      const container = document.getElementById("device-list-container");
      const summaryBar = document.getElementById("directory-summary-bar");
      const diagPanel = document.getElementById("telemetry-diagnostics");
      container.innerHTML = `<div class="glass empty-state"><p style="color:var(--text-secondary);">Loading registered devices...</p></div>`;
      summaryBar.style.display = "none";
      if (diagPanel) diagPanel.style.display = "none";
      
      try {
        const tStart = performance.now();
        const res = await fetch("/api/devices");
        const tFetch = performance.now() - tStart;
        const list = await res.json();
        
        container.innerHTML = "";

        if (list.length === 0) {
          container.innerHTML = `
            <div class="glass empty-state">
              <h3 style="margin-bottom:10px;">No registered devices found</h3>
              <p style="color:var(--text-secondary); font-size:14px;">Connect a device emulator using its UUID to register it in the panel index.</p>
            </div>
          `;
          return;
        }

        // Hydrate totals summary footprint metrics
        const totalDevices = list.length;
        
        summaryBar.style.display = "flex";
        summaryBar.innerHTML = `
          <span>Total Nodes: <strong>${totalDevices}</strong></span>
        `;

        list.forEach(dev => {
          const row = document.createElement("div");
          row.className = "glass device-row";
          
          row.innerHTML = `
            <div class="device-info">
              <div style="display:flex; align-items:center; gap:10px;">
                <div class="status-badge ${dev.state}">
                  <span class="status-dot"></span>
                  <span style="font-size:11px; text-transform:capitalize;">${dev.state}</span>
                </div>
                <span class="device-title">${dev.title}</span>
              </div>
              <span class="device-uuid">${dev.deviceId}</span>
            </div>

            <div class="device-actions">
              <a href="/?device_id=${dev.deviceId}" class="btn-action active-lease" style="text-decoration:none; padding:8px 16px;">Open Panel</a>
              <a href="/devices/stats?device_id=${dev.deviceId}" class="btn-action" style="text-decoration:none; padding:8px 16px; background:rgba(255,255,255,0.05); border:1px solid var(--border-color); color:var(--text-primary);">Storage Stats</a>
            </div>
          `;
          container.appendChild(row);
        });

        // Populate diagnostics telemetry metrics
        const serverTiming = res.headers.get("Server-Timing") || "";
        const dbGetsMatch = serverTiming.match(/db_gets;dur=([\d.]+)/);
        const dbHistoryMatch = serverTiming.match(/db_history;dur=([\d.]+)/);
        const serverTotalMatch = serverTiming.match(/total;dur=([\d.]+)/);
        
        const dbGetsTime = dbGetsMatch ? parseFloat(dbGetsMatch[1]) : 0;
        const dbHistoryTime = dbHistoryMatch ? parseFloat(dbHistoryMatch[1]) : 0;
        const serverTotalTime = serverTotalMatch ? parseFloat(serverTotalMatch[1]) : 0;
        const networkTime = Math.max(0, tFetch - serverTotalTime);

        if (diagPanel) {
          diagPanel.style.display = "flex";
          diagPanel.innerHTML = `
            <span>⏱️ UI Fetch Latency: <strong>${tFetch.toFixed(0)}ms</strong> (Network: ${networkTime.toFixed(0)}ms)</span>
            <span>💾 KV Gets: <strong>${dbGetsTime.toFixed(0)}ms</strong></span>
            <span>🔍 KV History Scan: <strong>${dbHistoryTime.toFixed(0)}ms</strong></span>
          `;
        }
      } catch(e) {
        container.innerHTML = `<div class="glass empty-state"><p style="color:var(--danger-color);">Error loading directory list.</p></div>`;
      }
    }



    // Initial load
    loadDevices();
