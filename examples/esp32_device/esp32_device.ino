/**
 * ============================================================================
 * EVERY-PANEL ESP32 DEVICE CLIENT
 * ============================================================================
 * ESP32 Arduino sketch that connects to an Every-Panel IoT hub via WebSocket,
 * reads temperature from a DS18B20 1-wire sensor, and streams telemetry data.
 *
 * WIRING:
 *   DS18B20 VCC  --> ESP32 3.3V
 *   DS18B20 GND  --> ESP32 GND
 *   DS18B20 DATA --> ESP32 GPIO4  (with 4.7kΩ pull-up resistor to 3.3V)
 *
 * DEPENDENCIES (install via Arduino Library Manager):
 *   - WebSockets by Markus Sattler (v2.4+)
 *   - OneWire by Jim Studt (v2.3+)
 *   - DallasTemperature by Miles Burton (v3.9+)
 *   - ArduinoJson by Benoit Blanchon (v7+)
 *
 * CONFIGURATION:
 *   On first boot, open the Arduino Serial Monitor (115200 baud, Newline
 *   line ending) and follow the prompts to enter WiFi SSID, password,
 *   hub host, port, and device ID. Credentials are saved to flash and
 *   reused on subsequent boots. Type 'reset' at the boot prompt to
 *   wipe stored config and re-enter provisioning.
 * ============================================================================
 */

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>

// Let's Encrypt ISRG Root X1 Trust Anchor Certificate (PEM format)
const char* LETS_ENCRYPT_ROOT_CA = \
"-----BEGIN CERTIFICATE-----\n" \
"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\n" \
"-----END CERTIFICATE-----\n";

// ==========================================
// Hardware Constants
// ==========================================

const int   ONE_WIRE_PIN  = 26;                 // DS18B20 1-Wire data pin
const unsigned long TELEMETRY_INTERVAL_MS = 10 *1000; // Telemetry interval (ms)
const int   WIFI_CONNECT_TIMEOUT_MS = 10000;     // WiFi connection timeout

// ==========================================
// Runtime Configuration (loaded from NVS)
// ==========================================

Preferences prefs;
String cfgSsid;
String cfgPass;
String cfgHubUrl;
String cfgDeviceId;
String cfgDeviceKey;
String cfgExtraHeaders;

// ==========================================
// Global Objects
// ==========================================

OneWire           oneWire(ONE_WIRE_PIN);
DallasTemperature sensors(&oneWire);
WebSocketsClient  webSocket;

float    currentTempC       = 0.0;
bool     hasFault           = false;
bool     connected          = false;
bool     layoutSent         = false;
unsigned long lastTelemetry = 0;

// ==========================================
// URL Parsing Helper
// ==========================================

void parseUrl(String url, String &protocol, String &host, int &port, String &path) {
  protocol = "ws";
  host = "";
  port = 80;
  path = "/ws";

  int protoIdx = url.indexOf("://");
  if (protoIdx != -1) {
    protocol = url.substring(0, protoIdx);
    url = url.substring(protoIdx + 3);
  }

  int pathIdx = url.indexOf('/');
  if (pathIdx != -1) {
    path = url.substring(pathIdx);
    url = url.substring(0, pathIdx);
  }

  int portIdx = url.indexOf(':');
  if (portIdx != -1) {
    host = url.substring(0, portIdx);
    port = url.substring(portIdx + 1).toInt();
  } else {
    host = url;
    port = (protocol.equalsIgnoreCase("wss")) ? 443 : 80;
  }
}

// ==========================================
// Serial Provisioning Helpers
// ==========================================

// Blocks until the user presses Enter. Returns the typed text (may be empty).
String serialReadLine() {
  String line = "";
  bool receiving = false;
  while (true) {
    if (Serial.available()) {
      char c = Serial.read();
      if (c == '\r') {
        receiving = true;
        // Consume a following \n if present (CR+LF pair)
        delay(10);
        if (Serial.available() && Serial.peek() == '\n') Serial.read();
        return line;
      }
      if (c == '\n') {
        // Standalone LF — only return if we haven't just handled a CR
        return line;
      }
      receiving = true;
      line += c;
    }
    delay(10);
  }
}

// Prompts the user for a value, showing a default. Returns default if input is empty.
String serialPrompt(const char* label, const String& defaultVal) {
  bool isSecret = (strcmp(label, "WiFi Password") == 0 || strcmp(label, "Device Key") == 0);
  if (defaultVal.length() > 0) {
    if (isSecret) {
      Serial.printf("  %s [********]: ", label);
    } else {
      Serial.printf("  %s [%s]: ", label, defaultVal.c_str());
    }
  } else {
    Serial.printf("  %s: ", label);
  }
  String input = serialReadLine();
  input.trim();
  return (input.length() > 0) ? input : defaultVal;
}

// ==========================================
// Configuration: Load / Save / Provision
// ==========================================

bool loadConfig() {
  prefs.begin("ep-config", true);  // read-only
  cfgSsid     = prefs.getString("ssid", "");
  cfgPass     = prefs.getString("pass", "");
  cfgHubUrl   = prefs.getString("hub_url", "");
  cfgDeviceId = prefs.getString("device_id", "");
  cfgDeviceKey = prefs.getString("device_key", "");
  prefs.end();
  return cfgSsid.length() > 0 && cfgPass.length() > 0 && cfgHubUrl.length() > 0 && cfgDeviceId.length() > 0 && cfgDeviceKey.length() > 0;
}

void saveConfig() {
  prefs.begin("ep-config", false);  // read-write
  prefs.putString("ssid", cfgSsid);
  prefs.putString("pass", cfgPass);
  prefs.putString("hub_url", cfgHubUrl);
  prefs.putString("device_id", cfgDeviceId);
  prefs.putString("device_key", cfgDeviceKey);
  prefs.end();
  Serial.println("[Config] Saved to flash.");
}

void clearConfig() {
  prefs.begin("ep-config", false);
  prefs.clear();
  prefs.end();
  Serial.println("[Config] Flash storage cleared.");
}

String getBuiltinUUID() {
  uint64_t chipId = ESP.getEfuseMac();
  uint32_t macLow = (uint32_t)(chipId);
  uint16_t macHigh = (uint16_t)(chipId >> 32);
  
  // Format as a valid UUID v4 shape: 32323232-3232-4232-8232-xxxxxxxxxxxx
  char uuidBuf[37];
  snprintf(uuidBuf, sizeof(uuidBuf), "32323232-3232-4232-8232-%04x%08x", macHigh, macLow);
  return String(uuidBuf);
}

String generateRandomKey() {
  uint8_t randomBytes[8];
  esp_fill_random(randomBytes, 8);
  char keyBuf[17];
  snprintf(keyBuf, sizeof(keyBuf), "%02x%02x%02x%02x%02x%02x%02x%02x",
           randomBytes[0], randomBytes[1], randomBytes[2], randomBytes[3],
           randomBytes[4], randomBytes[5], randomBytes[6], randomBytes[7]);
  return String(keyBuf);
}

void runSerialProvisioning() {
  Serial.println();
  Serial.println("╔══════════════════════════════════════╗");
  Serial.println("║   Every-Panel Device Configuration   ║");
  Serial.println("╚══════════════════════════════════════╝");
  Serial.println();
  Serial.println("  Enter values below (press Enter to keep default):");
  Serial.println();

  cfgSsid     = serialPrompt("WiFi SSID", cfgSsid);
  cfgPass     = serialPrompt("WiFi Password", cfgPass);
  cfgHubUrl   = serialPrompt("Hub URL", cfgHubUrl.length() > 0 ? cfgHubUrl : String("ws://192.168.2.207:8000/ws"));
  
  String defaultUUID = cfgDeviceId.length() > 0 ? cfgDeviceId : getBuiltinUUID();
  cfgDeviceId = serialPrompt("Device UUID", defaultUUID);

  if (cfgDeviceKey.length() > 0) {
    Serial.println("  Device Key Settings:");
    Serial.print("  Type 'reset' to generate a new Device Key (press Enter to keep current): ");
    String keyInput = serialReadLine();
    keyInput.trim();
    if (keyInput.equalsIgnoreCase("reset")) {
      cfgDeviceKey = generateRandomKey();
      Serial.println();
      Serial.println("┌────────────────────────────────────────────────────────┐");
      Serial.println("│  [SECURITY] GENERATED NEW DEVICE KEY:                  │");
      Serial.printf("│  >>>  %s  <<<                 │\n", cfgDeviceKey.c_str());
      Serial.println("│  Copy this key and register it on the dashboard.       │");
      Serial.println("└────────────────────────────────────────────────────────┘");
    }
  } else {
    // First setup: force key generation
    cfgDeviceKey = generateRandomKey();
    Serial.println();
    Serial.println("┌────────────────────────────────────────────────────────┐");
    Serial.println("│  [SECURITY] GENERATED NEW DEVICE KEY (FIRST SETUP):    │");
    Serial.printf("│  >>>  %s  <<<                 │\n", cfgDeviceKey.c_str());
    Serial.println("│  Copy this key and register it on the dashboard.       │");
    Serial.println("└────────────────────────────────────────────────────────┘");
  }
 
  saveConfig();
}

// ==========================================
// Wi-Fi Setup (with timeout + re-provision)
// ==========================================

bool connectWiFi() {
  Serial.printf("[WiFi] Connecting to '%s'", cfgSsid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println(" FAILED");
      Serial.println("[WiFi] Connection timed out.");
      return false;
    }
    delay(500);
    Serial.print(".");
  }

  Serial.println(" OK");
  Serial.printf("[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  return true;
}

// ==========================================
// UI Layout Definition
// ==========================================
// Sends the self-describing dashboard layout to the Every-Panel hub.
// The server stores this and renders a live dashboard for browser clients.

void sendLayoutDefinition() {
  JsonDocument doc;
  doc["type"]      = "ui_definition";
  doc["device_id"] = cfgDeviceId.c_str();

  JsonObject layoutDef = doc["layout_def"].to<JsonObject>();
  layoutDef["es-version"] = "0.0";
  layoutDef["command"]    = "page";

  JsonObject payload = layoutDef["payload"].to<JsonObject>();
  payload["title"] = "ESP32 Temperature Node";
  payload["type"]  = "layout";

  JsonObject rootProps = payload["properties"].to<JsonObject>();
  rootProps["id"]   = "layout_root";
  rootProps["flow"] = "row";

  JsonArray rootLayout = payload["layout"].to<JsonArray>();

  // --- Temperature reading (read-only sensor output) ---
  JsonObject tempWidget = rootLayout.add<JsonObject>();
  tempWidget["type"] = "number";
  JsonObject tempProps = tempWidget["properties"].to<JsonObject>();
  tempProps["label"]    = "DS18B20 Temperature (°C)";
  tempProps["id"]       = "temperature";
  tempProps["step"]     = ".1";
  tempProps["value"]    = String(currentTempC, 1);
  tempProps["update"]   = "false";
  tempProps["readonly"] = "true";

  // --- Divider ---
  JsonObject divider = rootLayout.add<JsonObject>();
  divider["type"] = "divider";
  JsonObject divProps = divider["properties"].to<JsonObject>();
  divProps["id"] = "divider_1";

  // --- Uptime text (read-only) ---
  JsonObject uptimeWidget = rootLayout.add<JsonObject>();
  uptimeWidget["type"] = "text";
  JsonObject uptimeProps = uptimeWidget["properties"].to<JsonObject>();
  uptimeProps["label"]    = "Device Uptime";
  uptimeProps["id"]       = "uptime";
  uptimeProps["value"]    = "0s";
  uptimeProps["update"]   = "false";
  uptimeProps["readonly"] = "true";

  // --- Device status log (read-only) ---
  JsonObject statusWidget = rootLayout.add<JsonObject>();
  statusWidget["type"] = "text";
  JsonObject statusProps = statusWidget["properties"].to<JsonObject>();
  statusProps["label"]    = "Device Status";
  statusProps["id"]       = "status_text";
  statusProps["value"]    = "Booting...";
  statusProps["update"]   = "false";
  statusProps["readonly"] = "true";

  // Serialize and send
  String output;
  serializeJson(doc, output);
  webSocket.sendTXT(output);

  Serial.println("[WS] Layout definition sent to hub.");
}

// ==========================================
// Telemetry Packet
// ==========================================
// Reads the DS18B20 sensor and sends a full telemetry snapshot.

void sendTelemetry() {
  // Request temperature conversion from all sensors on the bus
  sensors.requestTemperatures();
  currentTempC = sensors.getTempCByIndex(0);

  // Guard against disconnected sensor reads (-127°C is the error sentinel)
  if (currentTempC == DEVICE_DISCONNECTED_C) {
    hasFault = true;
    Serial.println("[Sensor] DS18B20 read error — sensor disconnected?");
  } else {
    hasFault = false;
  }

  // Format uptime as human-readable string
  unsigned long uptimeSec = millis() / 1000;
  char uptimeBuf[32];
  snprintf(uptimeBuf, sizeof(uptimeBuf), "%lud %luh %lum %lus",
           uptimeSec / 86400, (uptimeSec % 86400) / 3600,
           (uptimeSec % 3600) / 60, uptimeSec % 60);

  // Build telemetry JSON
  JsonDocument doc;
  doc["type"]      = "telemetry";
  doc["device_id"] = cfgDeviceId.c_str();

  JsonObject data = doc["data"].to<JsonObject>();
  data["temperature"] = round(currentTempC * 10.0) / 10.0;
  data["uptime"]      = uptimeBuf;
  data["status_text"] = hasFault ? "SENSOR FAULT: DS18B20 disconnected" : "Running normally";

  String output;
  serializeJson(doc, output);
  webSocket.sendTXT(output);

  Serial.printf("[Telemetry] Temp: %.1f°C | Uptime: %s\n", currentTempC, uptimeBuf);
}

// ==========================================
// WebSocket Event Handler
// ==========================================

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {

    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from hub.");
      connected  = false;
      layoutSent = false;
      break;

    case WStype_ERROR:
      Serial.printf("[WS] Connection Error! Payload: %s\n", payload ? (const char*)payload : "None");
      break;

    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to hub: %s\n", cfgHubUrl.c_str());
      connected = true;
      break;

    case WStype_TEXT: {
      // Parse incoming JSON message from the hub
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        Serial.printf("[WS] JSON parse error: %s\n", err.c_str());
        break;
      }

      const char* msgType = doc["type"];

      // Heartbeat: respond to server pings
      if (strcmp(msgType, "ping") == 0) {
        webSocket.sendTXT("{\"type\":\"pong\"}");
      }

      // Command: process remote control actions from browser clients (logging only)
      else if (strcmp(msgType, "command") == 0) {
        const char* target = doc["target"];
        Serial.printf("[Command] Target: %s, Value: ", target);
        serializeJson(doc["value"], Serial);
        Serial.println();
      }
      break;
    }

    default:
      break;
  }
}

// ==========================================
// Arduino Setup
// ==========================================

void setup() {
  Serial.begin(115200);
  delay(1000);  // Allow Serial Monitor time to attach
  Serial.println();
  Serial.println("=== Every-Panel ESP32 DS18B20 Node ===");
  Serial.printf("[System] Unique Chip UUID: %s\n", getBuiltinUUID().c_str());

  // Initialize 1-Wire temperature sensor bus
  sensors.begin();
  int sensorCount = sensors.getDS18Count();
  Serial.printf("[Sensor] Found %d DS18B20 sensor(s) on GPIO%d\n", sensorCount, ONE_WIRE_PIN);

  if (sensorCount == 0) {
    Serial.println("[Sensor] WARNING: No DS18B20 detected! Check wiring.");
  }

  // --- Configuration & WiFi Provisioning ---
  bool hasConfig = loadConfig();

  // Allow typing 'reset' within 3 seconds to wipe stored config
  if (hasConfig) {
    Serial.println("[Config] Stored config found. Type 'reset' within 3s to reconfigure...");
    unsigned long waitStart = millis();
    while (millis() - waitStart < 3000) {
      if (Serial.available()) {
        String cmd = serialReadLine();
        cmd.trim();
        if (cmd.equalsIgnoreCase("reset")) {
          clearConfig();
          hasConfig = false;
        }
        break;
      }
      delay(50);
    }
  }

  // Provision via serial if no stored config or WiFi fails
  while (true) {
    if (!hasConfig) {
      runSerialProvisioning();
    }
    if (connectWiFi()) break;
    Serial.println("[Config] WiFi failed. Re-entering configuration...");
    hasConfig = false;  // Force re-provisioning
  }

  // Parse the Hub URL configuration parameters
  String protocol, host, path;
  int port;
  parseUrl(cfgHubUrl, protocol, host, port, path);

  // Build the WebSocket path with device role and UUID parameters
  String wsPath = path;
  if (wsPath.indexOf('?') == -1) {
    wsPath += "?role=device&device_id=" + cfgDeviceId;
  } else {
    wsPath += "&role=device&device_id=" + cfgDeviceId;
  }

  // Print WebSocket connection diagnostic details
  Serial.println("[WS] Target Parameter Diagnostics:");
  Serial.printf("  - Host: %s | Port: %d | Protocol: %s\n", host.c_str(), port, protocol.c_str());
  Serial.printf("  - Device UUID: %s\n", cfgDeviceId.c_str());
  Serial.printf("  - Device Key Length: %d chars\n", cfgDeviceKey.length());
  Serial.printf("  - Request Headers Extra: X-Device-Key: [len: %d]\n", cfgDeviceKey.length());

  // Initialize WebSocket connection with User-Agent and Origin to bypass CDN/routing firewall filters
  cfgExtraHeaders = "X-Device-Key: " + cfgDeviceKey + "\r\n" +
                    "User-Agent: Mozilla/5.0 (ESP32; CPU IoT Node)\r\n" +
                    "Origin: https://" + host + "\r\n";
  webSocket.setExtraHeaders(cfgExtraHeaders.c_str());

  if (protocol.equalsIgnoreCase("wss")) {
    // Sync time via NTP (required for validating certificate expiration dates)
    Serial.print("[Time] Syncing time via NTP...");
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    time_t nowTime = time(nullptr);
    while (nowTime < 8 * 3600 * 2) {
      delay(500);
      Serial.print(".");
      nowTime = time(nullptr);
    }
    Serial.println(" OK");

    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
      Serial.print("[Time] Authenticated time: ");
      Serial.println(asctime(&timeinfo));
    }

    // Connect using secure TLS with Let's Encrypt Root CA validation and subprotocol negotiation
    webSocket.beginSslWithCA(host.c_str(), port, wsPath.c_str(), LETS_ENCRYPT_ROOT_CA, "every-panel-device-auth");
    Serial.printf("[WS] Connecting securely (SSL Certificate Verified) to wss://%s:%d%s\n", host.c_str(), port, wsPath.c_str());
  } else {
    webSocket.begin(host.c_str(), port, wsPath.c_str(), "every-panel-device-auth");
    Serial.printf("[WS] Connecting to ws://%s:%d%s\n", host.c_str(), port, wsPath.c_str());
  }

  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

// ==========================================
// Arduino Main Loop
// ==========================================

void loop() {
  webSocket.loop();

  unsigned long now = millis();

  // Print system memory and network debug statistics every 60 seconds
  static unsigned long lastDebugPrint = 0;
  if (now - lastDebugPrint >= 60000) {
    lastDebugPrint = now;
    uint32_t totalHeap = ESP.getHeapSize();
    uint32_t freeHeap = ESP.getFreeHeap();
    uint32_t minFreeHeap = ESP.getMinFreeHeap();
    float pctUsed = (totalHeap > 0) ? ((float)(totalHeap - freeHeap) / totalHeap * 100.0) : 0.0;
    float minPctUsed = (totalHeap > 0) ? ((float)(totalHeap - minFreeHeap) / totalHeap * 100.0) : 0.0;
    int rssi = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : 0;
    
    Serial.println();
    Serial.println("--- [System Debug Status] ---");
    Serial.printf("  Free Heap: %u bytes (%u KB) - Used: %.1f%%\n", freeHeap, freeHeap / 1024, pctUsed);
    Serial.printf("  Min Free Heap: %u bytes (%u KB) - Max Used: %.1f%%\n", minFreeHeap, minFreeHeap / 1024, minPctUsed);
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("  WiFi RSSI: %d dBm (IP: %s)\n", rssi, WiFi.localIP().toString().c_str());
    } else {
      Serial.println("  WiFi Status: Disconnected");
    }
    Serial.printf("  WebSocket Status: %s\n", connected ? "CONNECTED" : "DISCONNECTED");
    Serial.println("-----------------------------");
    Serial.println();
  }

  if (!connected) return;

  // Send layout definition once after connection
  if (!layoutSent) {
    sendLayoutDefinition();
    layoutSent = true;
  }

  // Stream telemetry at the configured interval
  if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
    lastTelemetry = now;
    sendTelemetry();
  }
}
