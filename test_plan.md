# Test Strategy and Test Plan: Every-Panel IoT Dashboard

This document defines the testing strategy, test scenarios, and automated validation methods for the `Every-Panel` self-configuring IoT dashboard. 

---

## 1. Test Strategy Overview

The `Every-Panel` platform contains three distinct execution blocks:
1.  **Distributed Backend** (Deno server isolates running on Deno Deploy).
2.  **Physical IoT Emulator** (Dummy WebSocket device client).
3.  **Dynamic UI Frontend** (HTML/JS browser client with recursive rendering).

Due to the real-time, stateful nature of WebSockets paired with a stateless backend, the testing strategy focuses on **End-to-End (E2E) Integration Tests** using mock clients, alongside manual check-lists for UI locking behaviors.

```
                  +--------------------------------+
                  |      Integration Testing       |
                  |  (Simulate Server/Dev/Client)  |
                  +--------------------------------+
                                  ||
        ======================================================
        ||                                                  ||
        \/                                                  \/
+-----------------------+                           +------------------------+
|      Unit Tests       |                           |  Manual UI Diagnostics |
|  - KV Helper functions|                           |  - Interactive badge   |
|  - Cookie matching    |                           |  - Multi-tab lockouts  |
|  - URL redirect logs  |                           |  - Slider handle drift |
+-----------------------+                           +------------------------+
```

---

## 2. Test Scope & Focus Areas

### A. Dynamic Layout Parsing
*   **Verification**: Ensure the dynamic UI renderer correctly reads the nested JSON arrays and formats row/column flex alignments without syntax crashes.
*   **Widgets Tested**: Number box, Text, Text View, Divider, Button, Image (Base64), Time, and Slider.

### B. Distributed State Sync (KV Watch Command Routing)
*   **Verification**: Ensure that when Client A updates a slider, the server writes the command to Deno KV, the isolate holding the device connection detects the change via watch, forwards it to the device, and the resulting telemetry is broadcast to all active viewers.

### C. Connection & Control States
*   Verify transitions between all **seven** states: `disconnected`, `detached`, `initializing`, `stale`, `fault`, `live`, and `control`.

---

## 3. Detailed Test Cases (Integration & E2E)

| Test ID | Test Scenario | Expected Outcome | Type |
| :--- | :--- | :--- | :--- |
| **TC-01** | Connect device layout definition payload | Server saves definitions in KV. Clients receive `init` containing layouts and draw UI cards immediately. | E2E |
| **TC-02** | Multi-client connection lease lock | First tab acquires control (status: `control / Green`). Second tab remains locked (status: `Live (In Use)`). Inputs on second tab are disabled. | Integration |
| **TC-03** | Auto-redirect to Device Hub Directory | Accessing root path `/` without any device ID parameter automatically redirects to `/devices` (Device Directory hub). | E2E |
| **TC-04** | Heartbeat Ping/Pong Keepalive | Device WebSocket closes. State transitions to `detached` (solid red) exactly 15 seconds after the last heartbeat pong frame is missed. | System |
| **TC-05** | Stale connection alert | Stop sending telemetry packets from device emulator for 10 seconds. Browser badge transitions to `Stale (Lagging)` (pulsing pink). | UI / E2E |
| **TC-06** | Hardware fault notification | Click the simulated fault button. Telemetry data appends `"fault": "Error E-04"`. Badge transitions to `Fault: Error E-04` (pulsing red). | UI / E2E |
| **TC-07** | Write Access Security Guard | Client without lease attempts to send a command packet. Server rejects, returning an `error` frame. | Security |
| **TC-08** | Invalid UUID Parameter | Server rejects WebSocket connection with `400 Bad Request` if device connects with an invalid UUID format (e.g. `dummy_dev`). | Security |
| **TC-09** | Database Wipe Action | Click "Wipe" button on the Device Directory page. UI triggers a POST request to `/api/devices/delete`. The device's KV layout, state, status, and history are wiped, and it is removed from the directory list. | E2E |

---

## 4. E2E Test Execution Plan (Manual Validation Checklist)

Run the following manual tests to ensure full compliance before deploying to production:

### Phase 1: Local Bootup
1.  Run the server: `DISABLE_AUTH=true deno task dev`
2.  Observe console logs: `Server starting on port 8000...`
3.  Open browser to `http://localhost:8000/`. Confirm it redirects to `http://localhost:8000/devices` showing the empty directory panel: *No registered devices found*.

### Phase 2: Device Initialization
1.  Run emulator: `deno task device`
2.  Open browser to the emulator panel at `http://localhost:8001/` and click **Connect**.
3.  Go back to the Hub Directory tab at `http://localhost:8000/devices` and click **Refresh List**.
4.  Confirm the row for device `e0821c8b-ff4b-48ae-94a2-9b2ee0c6488d` appears with a **`live` (Yellow)** badge.
5.  Confirm the row shows **"Storage Footprint"** with the number of telemetry logs (e.g. `12 entries`) and size footprint (e.g. `3.45 KB`).
6.  Confirm the **"Retention"** dropdown defaults to **"7 Days"**. Toggle it to **"1 Day"**; verify the page reloads the directory, showing the new selection.
7.  Click **Open Dashboard**. Confirm the page loads the layout widgets and starts updating sensor telemetry in real-time.

### Phase 3: Exclusive Lease Locks
1.  Open a second browser tab to `http://localhost:8000/`.
2.  On Tab 1, click **Acquire Control**. Confirm Tab 1 changes to **`Control Mode (You)` (Green)** and inputs become interactive.
3.  Look at Tab 2. Confirm Tab 2 shows **`Live (In Use)`** and its interactive inputs (sliders, buttons) are locked and dimmed, but the sensor displays and historical telemetry chart remain fully bright and readable.
4.  On Tab 1, slide the slider. Confirm Tab 2's slider automatically slides to match the position in real-time.

### Phase 4: Diagnostic States (Stale & Fault)
1.  On Tab 1, click the **"Toggle Simulated Hardware Fault"** button.
2.  Confirm the badge on both tabs changes to **`Fault: Simulated Hardware Fault Code E-04` (Pulsing Red)** and inputs are locked and dimmed, but sensor values and the telemetry chart remain fully sharp and readable. Click the button again to clear.
3.  On the Emulator Panel (Port 8001), uncheck the **"Auto-Stream Telemetry (2s)"** checkbox.
4.  Within 10 seconds, confirm the dashboard badge transitions to **`Stale (Lagging)` (Pulsing Pink)** and interactive inputs are disabled and dimmed.
5.  Re-check the checkbox. Confirm the dashboard badge transitions back to **`Control Mode (You)` (Green)**.
6.  On the Emulator Panel, click **Disconnect**. Confirm the dashboard transitions to **`Detached` (Solid Red)**.
7.  Terminate the server process. Confirm the badge changes to **`Connecting...` (Pulsing Gray)**.

---

## 5. Automated Regression Test Structure

To run regression tests locally in continuous integration (CI):
*   Add a test runner file: `deno test --allow-run --allow-net --unstable-kv tests/`
*   Incorporate the mock clients setup from our concurrency script to programmatically assert JSON packets matching expected structures.
