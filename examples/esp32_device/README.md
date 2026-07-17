# Every-Panel ESP32 Client

This directory contains a complete ESP32 client implementation for **Every-Panel** using the Arduino framework. The device reads temperature values from a DS18B20 1-Wire temperature sensor and streams telemetry directly to the Every-Panel server.

---

## Features
* **Zero-Config Provisioning**: On first boot, provisioning is handled interactively via the Arduino Serial Monitor. SSID, passwords, device UUIDs, and keys are stored securely in flash (Preferences/NVS) and reused.
* **On-Demand Dynamic Telemetry**:
  * **Idle state**: Telemetry values are only sent every **5 minutes** to save radio power and database write counts.
  * **Active state**: When a user opens the device's dashboard panel, the server notifies the device, which automatically scales up telemetry rate to every **15 seconds** (and pushes an update immediately on connect).
* **Self-Configuring Layout**: On connection, the device sends its own JSON UI layout definition to the server, which dynamically renders the dashboard on the fly.
* **Secure TLS Option**: Capable of secure WebSocket connections (`wss://`) utilizing NTP time synchronization and certificate validation.

---

## Hardware Requirements
1. **ESP32 Dev Board** (e.g., ESP32-WROOM-32D/E).
2. **DS18B20 1-Wire Temperature Sensor** (TO-92 package or waterproof probe).
3. **4.7kΩ Pull-Up Resistor** (connected between DS18B20 DATA and VCC).

### Wiring Diagram
```
  [ESP32 3.3V]  ─────────────────────────────── DS18B20 VCC (Pin 3)
                                      ┌───┐
                                     [ 4K7 ] (Pull-Up)
                                      └───┘
  [ESP32 GPIO26] ───────────────────★────────── DS18B20 DATA (Pin 2)
  [ESP32 GND]   ─────────────────────────────── DS18B20 GND (Pin 1)
```

---

## Software Dependencies
Install the following libraries using the **Arduino Library Manager** (`Sketch -> Include Library -> Manage Libraries...`):

1. **WebSockets** by Markus Sattler (v2.4+)
2. **OneWire** by Jim Studt (v2.3+)
3. **DallasTemperature** by Miles Burton (v3.9+)
4. **ArduinoJson** by Benoit Blanchon (v7.0+)

---

## How to Use

### 1. Upload the Sketch
1. Open the [esp32_device.ino](esp32_device.ino) sketch in the Arduino IDE.
2. Select your ESP32 board and port.
3. Verify and Upload.

### 2. Configure Provisioning
1. Open the **Serial Monitor** in the Arduino IDE.
2. Set the baud rate to **115200** and select **NL & CR** (Newline / Carriage Return) line endings.
3. Follow the interactive prompts to configure:
   * **WiFi SSID**
   * **WiFi Password**
   * **Hub URL** (e.g. `ws://192.168.1.100:8000/ws`)
   * **Device UUID** (press enter to generate a default UUID based on chip MAC address)
4. A secure, random **Device Key** is generated automatically on setup.
5. **Copy the generated key** shown in the serial console. You will need this key when registering the device on the Every-Panel dashboard.

### 3. Resetting Configuration
To reconfigure WiFi or target URLs, type `reset` into the Serial Monitor input field within 3 seconds of booting the board. NVS memory will be cleared, and provisioning prompts will reappear.

---

## Testing & Verification

### Step 1: Run the Server Locally
To connect the ESP32 to your local computer:
1. Ensure your ESP32 and your computer are connected to the **same Wi-Fi network**.
2. Determine your computer's local IP address (e.g., `192.168.1.120`).
3. Start the Every-Panel server bound to your local network address:
   ```bash
   deno task dev:lan
   ```
4. Access the web interface at `http://<your-computer-ip>:8000/`.

### Step 2: Register the ESP32 Device
1. On the web dashboard, click **Register Device**.
2. Input the **Device UUID** (the chip UUID printed to the Serial Monitor) and the generated **Device Key** you copied during provisioning.
3. Submit the registration. The device status will initially show as **Detached**.

### Step 3: Power on the ESP32
1. Power up the ESP32 while it is connected to the Serial Monitor.
2. Verify that it connects to Wi-Fi and establishes the WebSocket connection to your hub URL:
   `[WS] Connected to hub: ws://192.168.1.120:8000/ws`
3. The server dashboard will automatically transition to **Live (View Only)** as it receives the UI layout configuration.

### Step 4: Verify Dynamic Telemetry
1. **Idle State**: Close all browser tabs showing this device's panel. Watch the ESP32 Serial Monitor: it will show telemetry sends only once every **5 minutes**.
2. **Active State**: Open the device's dashboard panel in your web browser.
   * The ESP32 Serial Monitor will immediately print: `[WS] Server notified: Viewers are active.`
   * Telemetry updates will immediately start streaming and log to the console every **15 seconds**.
   * Close the browser tab again; after 10–20 seconds, the Serial Monitor will log `[WS] Server notified: Viewers are inactive.` and return to the 5-minute interval.

---

## Testing & Emulating Without Physical Hardware

If you want to test server-side integration or verify client logic without flashing physical hardware:

### Option A: Use the Mock Device Emulator
You can run a software emulator on your machine that simulates a connected ESP32 client:
1. Register a test device ID and key on your local server.
2. Launch the mock device emulator:
   ```bash
   deno task device
   ```
3. The emulator will automatically connect to your local server, register as an active device, and start streaming simulated telemetry values, allowing you to test UI rendering and dashboard layout definitions instantly.

### Option B: Run Automated Integration Tests
To execute the automated test suite which mocks server execution, multiple concurrent browser client connections, control lease lock acquisitions, and keepalive heartbeat state loops:
```bash
deno task test
```
The test suite verifies all connectivity workflows inside a headless environment.

### Option C: Run On-Device ESP32 Unit Tests
A dedicated unit test sketch is provided in the `esp32_device_tests` directory to validate helper functions (such as URL parsing and JSON packet layout decoding) directly on the ESP32 chip:
1. Open the [esp32_device_tests.ino](esp32_device_tests/esp32_device_tests.ino) sketch in the Arduino IDE.
2. Select your ESP32 board and port.
3. Verify and Upload.
4. Open the Serial Monitor at **115200** baud to view the test run execution and verification logs.

