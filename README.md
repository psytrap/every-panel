# Every-Panel: Self-Configuring IoT Dashboard (Deno Deploy)

A self-configuring, edge-native IoT dashboard and communication hub designed to run on **Deno Deploy** in a single file. Bypasses static widget layouts by letting the IoT device configure its own dashboard schema over WebSockets.

Includes a **Dummy IoT Device Emulator** for integration testing.

---

## Features
*   **Hierarchical Dynamic Layouts**: Render column/row flex structures dynamically based on a device-provided JSON description.
*   **Seven Connection, Control and Diagnostic States**:
    *   ⚪ **disconnected**: The browser client itself has lost connection to the server. Inputs are locked, and the status dot pulses gray while it retries to connect.
    *   🔴 **detached**: The server is online, but the physical IoT device is disconnected/offline. Dashboard is disabled.
    *   🟠 **initializing**: The server is connected and the device is online, but the layout configuration JSON is not yet received. Badge pulses orange.
    *   🌸 **stale**: The device is online, but it hasn't sent a telemetry update for > 10 seconds. Badge pulses pink indicating latency.
    *   🚨 **fault**: The device has sent a telemetry message containing a `fault` or `error` key. Badge pulses rapid red, indicating device fault.
    *   🟡 **live**: The device is connected. Clients can view real-time telemetry but cannot toggle switches (view-only mode).
    *   🟢 **control**: The device is connected, and one browser client holds the control lock. Only this client can toggle controls and send commands back to the device.
*   **Exclusive Lease-Lock Control**: Users can request control from the header controls block in the UI. Only one active dashboard instance is granted write-access at a time. Other browser tabs automatically fall back to live (view-only) mode.
*   **Keepalive Heartbeat**: The server issues periodic `ping` messages to the device WebSocket every 5 seconds to proactively detect network drop-offs and transition the state to `detached` if a `pong` is missed.
*   **Single-File Deployment**: HTTP server, WebSocket router, Deno KV database handlers, and HTML/CSS/JS frontend are self-contained in a single `main.ts` script.
*   **Switchable Authentication**: Secure access with **GitHub OAuth** or disable authentication entirely by setting `DISABLE_AUTH=true`.

---

## UI Layout Definition Schema

Connecting IoT devices register their interface by sending a `ui_definition` message. This layout definition supports recursive layouts to group components in grids.

### JSON Structure:
```json
{
  "type": "ui_definition",
  "device_id": "my_device_1",
  "layout_def": {
    "es-version": "0.0",
    "command": "page",
    "payload": {
      "title": "Device Control Panel",
      "type": "layout",
      "properties": {
        "id": "root_rows",
        "flow": "row"
      },
      "layout": [
        // List of widgets or sub-layouts
      ]
    }
  }
}
```

---

### Supported Widget Types & Properties

Every item in the `"layout"` array must specify a `"type"` and a `"properties"` object.

#### 1. Layout Container (`"type": "layout"`)
Used to group child widgets in row or column flow grids.
*   **Properties**:
    *   `id` *(string)*: Unique layout identifier.
    *   `flow` *(string)*: `"row"` stacks children vertically. `"column"` stacks children horizontally side-by-side (flex wrap automatically distributes them on mobile).
*   **Additional Keys**:
    *   `layout` *(array)*: List of child widgets or sub-layouts.

#### 2. Number Box (`"type": "number"`)
Displays a numeric value or input.
*   **Properties**:
    *   `id` *(string)*: Telemetry key.
    *   `label` *(string)*: Text label header.
    *   `value` *(string)*: Default placeholder number value.
    *   `step` *(string)*: Incremental stepping value (e.g. `".1"`, `"1"`).
    *   `readonly` *(string)*: `"true"` turns the input into a read-only display. `"false"` makes it editable.

#### 3. Text Input (`"type": "text"`)
Renders a string input box.
*   **Properties**:
    *   `id` *(string)*: Telemetry key.
    *   `label` *(string)*: Text label header.
    *   `value` *(string)*: Initial text value.
    *   `readonly` *(string)*: `"true"` makes it display-only.

#### 4. Text Display Panel (`"type": "text_view"`)
Renders a static multiline formatted container. Useful for status summaries or logs.
*   **Properties**:
    *   `id` *(string)*: Unique widget identifier.
    *   `value` *(string)*: Telemetry multiline text body.

#### 5. Divider Line (`"type": "divider"`)
Renders a horizontal rule break.
*   **Properties**:
    *   `id` *(string)*: Unique widget identifier.

#### 6. Action Button (`"type": "button"`)
Creates a click button which triggers an event on click.
*   **Properties**:
    *   `id` *(string)*: Command target key.
    *   `label` *(string)*: Button text.
    *   `edges` *(string)*: `"true"` (optional) enables click press events.

#### 7. Image Viewer (`"type": "image"`)
Renders an image from a URL or an inline base64 string.
*   **Properties**:
    *   `id` *(string)*: Telemetry key (for swapping images dynamically).
    *   `src` *(string)*: The image source (e.g., `data:image/svg+xml;base64,...`).

#### 8. Time Indicator (`"type": "time"`)
Renders a specialized timestamp indicator.
*   **Properties**:
    *   `id` *(string)*: Telemetry key.
    *   `label` *(string)*: Text label.
    *   `value` *(string)*: Live time representation string.

#### 9. Slider Bar (`"type": "slider"`)
Renders an interactive slide controller.
*   **Properties**:
    *   `id` *(string)*: Telemetry/Command key.
    *   `label` *(string)*: Text label.
    *   `value` *(string)*: Initial slider position number.
    *   `min` *(string)*: Minimum range parameter.
    *   `max` *(string)*: Maximum range parameter.
    *   `step` *(string)*: Stepper precision interval.

---

## Data Communication Protocol

### 1. Telemetry Updates (Device -> Server -> Clients)
Sent by the device. Telemetry data keys map directly to the widget `id` definitions in the layout payload:
```json
{
  "type": "telemetry",
  "device_id": "dummy_dev",
  "data": {
    "temp_sensor": 24.8,
    "text_events": "Device active",
    "relay_1": true
  }
}
```

### 2. Command Messages (Client -> Server -> Device)
Triggered when the controller client interacts with sliders, numbers, texts, or button controls:
*   **Update Event (Inputs/Sliders)**:
    ```json
    {
      "type": "command",
      "device_id": "dummy_dev",
      "action": "update",
      "target": "slider_id",
      "value": 15
    }
    ```
*   **Click Event (Buttons)**:
    ```json
    {
      "type": "command",
      "device_id": "dummy_dev",
      "action": "click",
      "target": "button_id"
    }
    ```

---

## Local Integration Testing (Quick Start)

Run both the server and the dummy device emulator locally:

1.  **Start the Server (Auth Bypassed)**:
    ```bash
    export DISABLE_AUTH="true"
    deno task dev
    ```
    *   **Start the Server in LAN Mode** (binds to `0.0.0.0` allowing real devices on your local network to connect):
        ```bash
        deno task dev:lan
        ```
2.  **Start the Dummy Device Emulator**:
    In a new terminal window, run:
    ```bash
    deno task device
    ```
3.  **View the Dashboard**:
    *   Open `http://localhost:8000/` (will automatically redirect to the active device: `http://localhost:8000/?device_id=dummy_dev`).
    *   Click **Acquire Control** to begin interactively testing buttons and sliders.

---

## Deploying to Deno Deploy

This project is 100% compatible with Deno Deploy. To deploy the server to the cloud:

1.  **Select Entrypoint**: Set **`src/main.ts`** as the project entrypoint in your Deno Deploy project settings.
2.  **Environment Variables**: Bind the following variables in the Deno Deploy dashboard under **Settings > Environment Variables**:
    *   `DISABLE_AUTH`: `"true"` (to bypass login) or `"false"` (to use GitHub OAuth authentication).
    *   `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`: Your GitHub OAuth app secrets (if authentication is enabled).
    *   `ALLOWED_GITHUB_USERS`: Comma-separated list of GitHub logins permitted to access the panel directory.
3.  **Deno KV Database**: Leave the `KV_PATH` environment variable empty on the cloud. Deno Deploy will automatically bind the application to its managed, zero-config production database instance.
4.  **Static Files**: Deno Deploy automatically packages and serves all static file assets located inside the `/public` directory.

---

## Code Files Overview
*   [src/main.ts](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/src/main.ts): Central HTTP router entry point and request router.
*   [src/db.ts](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/src/db.ts): Deno KV initialization, configuration settings, and database operations.
*   [src/ws.ts](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/src/ws.ts): WebSocket upgrade logic, keepalive ping heartbeat loop, and command/telemetry synchronization watchers.
*   [src/views.ts](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/src/views.ts): Dynamically-rendered HTML skeleton page templates.
*   [public/style.css](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/public/style.css): Main Glassmorphism UI stylesheet.
*   [public/login.js](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/public/login.js): Client-side JavaScript handling login errors.
*   [public/panel.js](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/public/panel.js): Client-side JavaScript for the main control panel workspace (WS connection, Chart.js, rendering).
*   [public/devices.js](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/public/devices.js): Client-side JavaScript for the registered devices index directory list.
*   [examples/device_emulator.ts](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/examples/device_emulator.ts): Web-based IoT device emulator.
*   [tests/integration_test.ts](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/tests/integration_test.ts): Integration test verifying concurrent WebSockets lease allocations and command routing.
*   [tests/db_test.ts](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/tests/db_test.ts): Unit tests verifying session storage, validation, lifecycle, and expiration operations.
*   [tests/auth_integration_test.ts](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/tests/auth_integration_test.ts): Integration tests validating OAuth authentication redirect endpoints, session cookie creation, whitelist permissions, and logout flows.
*   [tests/test_plan.md](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/tests/test_plan.md): Architectural test strategy and verification plans.
*   [deno.json](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/deno.json): Local dev task configurations.
*   [spec.md](file:///home/mik/Documents/Bastel/2023-/every-panel/every-panel/spec.md): Complete systems design specification.
