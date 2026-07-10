    async function loadDevices() {
      const container = document.getElementById("device-list-container");
      const summaryBar = document.getElementById("directory-summary-bar");
      container.innerHTML = `<div class="glass empty-state"><p style="color:var(--text-secondary);">Loading registered devices...</p></div>`;
      summaryBar.style.display = "none";
      
      try {
        const res = await fetch("/api/devices");
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
        const totalCount = list.reduce((acc, dev) => acc + (dev.historyCount || 0), 0);
        const totalBytes = list.reduce((acc, dev) => acc + (dev.historyBytes || 0), 0);
        
        summaryBar.style.display = "flex";
        summaryBar.innerHTML = `
          <span>Total Nodes: <strong>${totalDevices}</strong></span>
          <span>Total Entries: <strong>${totalCount}</strong></span>
          <span>Total Footprint: <strong>${formatBytes(totalBytes)}</strong></span>
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
              <span style="font-size:12px; color:var(--text-secondary); margin-top:2px;">Storage Footprint: <strong>${dev.historyCount}</strong> entries (${formatBytes(dev.historyBytes)})</span>
            </div>

            <div class="device-actions">
              <div style="display:flex; align-items:center; gap:8px; margin-right:12px;">
                <span style="font-size:12px; color:var(--text-secondary); font-weight:500;">Retention:</span>
                <select onchange="updateTtl('${dev.deviceId}', this.value)" style="padding:6px 10px; font-size:12px; border-radius:6px; background:rgba(255,255,255,0.05); border:1px solid var(--border-color); color:var(--text-primary); cursor:pointer; font-family:'Outfit', sans-serif;">
                  <option value="1" ${dev.historyTtlDays === 1 ? 'selected' : ''}>1 Day</option>
                  <option value="7" ${dev.historyTtlDays === 7 ? 'selected' : ''}>7 Days</option>
                  <option value="30" ${dev.historyTtlDays === 30 ? 'selected' : ''}>30 Days</option>
                  <option value="365" ${dev.historyTtlDays === 365 ? 'selected' : ''}>1 Year</option>
                  <option value="0" ${dev.historyTtlDays === 0 ? 'selected' : ''}>Infinite</option>
                </select>
              </div>
              <a href="/?device_id=${dev.deviceId}" class="btn-action active-lease" style="text-decoration:none; padding:8px 16px;">Open Panel</a>
              <button onclick="wipeDevice('${dev.deviceId}')" class="btn-delete">Wipe</button>
            </div>
          `;
          container.appendChild(row);
        });
      } catch(e) {
        container.innerHTML = `<div class="glass empty-state"><p style="color:var(--danger-color);">Error loading directory list.</p></div>`;
      }
    }

    function formatBytes(bytes) {
      if (bytes === 0) return "0 Bytes";
      const k = 1024;
      const sizes = ["Bytes", "KB", "MB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    }

    async function updateTtl(deviceId, days) {
      try {
        const res = await fetch("/api/devices/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId, historyTtlDays: Number(days) })
        });
        const data = await res.json();
        if (data.success) {
          // Soft refresh statistics footprint after change
          loadDevices();
        } else {
          alert("Failed to update retention policy: " + data.error);
        }
      } catch (e) {
        alert("Failed to update retention policy.");
      }
    }

    async function wipeDevice(id) {
      if (!confirm("Are you sure you want to delete this device's configuration and wipe all historical logs? This cannot be undone.")) return;
      
      try {
        const res = await fetch("/api/devices/delete?device_id=" + id, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          loadDevices();
        }
      } catch (e) {
        alert("Failed to delete device logs.");
      }
    }

    // Initial load
    loadDevices();
