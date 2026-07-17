/**
 * ============================================================================
 * EVERY-PANEL TELEMETRY & BUSINESS LOGIC
 * ============================================================================
 * Clean C++ business logic class decoupled from target hardware/network
 * libraries (WiFi, WebSocketsClient, etc.) to allow unit testing on both
 * host machines and target processors.
 * ============================================================================
 */

#ifndef TELEMETRY_LOGIC_H
#define TELEMETRY_LOGIC_H

#include <Arduino.h>
#include <ArduinoJson.h>

struct DeviceState {
  bool connected = false;
  bool layoutSent = false;
  bool viewersActive = false;
  bool triggerTelemetry = false;
};

class TelemetryLogic {
public:
  // Decodes a standard WebSocket URL string into protocol, host, port, and path variables
  static void parseUrl(String url, String &protocol, String &host, int &port, String &path) {
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

  // Format uptime into a human-readable duration string (Days Hours Minutes Seconds)
  static String formatUptime(unsigned long uptimeSec) {
    char uptimeBuf[32];
    snprintf(uptimeBuf, sizeof(uptimeBuf), "%lud %luh %lum %lus",
             uptimeSec / 86400, (uptimeSec % 86400) / 3600,
             (uptimeSec % 3600) / 60, uptimeSec % 60);
    return String(uptimeBuf);
  }

  // Returns standard system status text based on sensor state
  static String getStatusText(bool hasFault) {
    return hasFault ? "SENSOR FAULT: DS18B20 disconnected" : "Running normally";
  }

  // Generates JSON Layout Definition document to describe widgets to the server
  static String buildLayoutJson(const String& deviceId, float initialTemp) {
    JsonDocument doc;
    doc["type"]      = "ui_definition";
    doc["device_id"] = deviceId.c_str();

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

    // Temperature widget (read-only)
    JsonObject tempWidget = rootLayout.add<JsonObject>();
    tempWidget["type"] = "number";
    JsonObject tempProps = tempWidget["properties"].to<JsonObject>();
    tempProps["label"]    = "DS18B20 Temperature (°C)";
    tempProps["id"]       = "temperature";
    tempProps["step"]     = ".1";
    tempProps["value"]    = String(initialTemp, 1);
    tempProps["update"]   = "false";
    tempProps["readonly"] = "true";

    // Divider
    JsonObject divider = rootLayout.add<JsonObject>();
    divider["type"] = "divider";
    JsonObject divProps = divider["properties"].to<JsonObject>();
    divProps["id"] = "divider_1";

    // Uptime text widget
    JsonObject uptimeWidget = rootLayout.add<JsonObject>();
    uptimeWidget["type"] = "text";
    JsonObject uptimeProps = uptimeWidget["properties"].to<JsonObject>();
    uptimeProps["label"]    = "Device Uptime";
    uptimeProps["id"]       = "uptime";
    uptimeProps["value"]    = "0s";
    uptimeProps["update"]   = "false";
    uptimeProps["readonly"] = "true";

    // Device status logs
    JsonObject statusWidget = rootLayout.add<JsonObject>();
    statusWidget["type"] = "text";
    JsonObject statusProps = statusWidget["properties"].to<JsonObject>();
    statusProps["label"]    = "Device Status";
    statusProps["id"]       = "status_text";
    statusProps["value"]    = "Booting...";
    statusProps["update"]   = "false";
    statusProps["readonly"] = "true";

    String output;
    serializeJson(doc, output);
    return output;
  }

  // Generates JSON Telemetry snapshot payloads
  static String buildTelemetryJson(const String& deviceId, float temp, const String& uptime, bool hasFault) {
    JsonDocument doc;
    doc["type"]      = "telemetry";
    doc["device_id"] = deviceId.c_str();

    JsonObject data = doc["data"].to<JsonObject>();
    data["temperature"] = round(temp * 10.0) / 10.0;
    data["uptime"]      = uptime;
    data["status_text"] = getStatusText(hasFault);

    String output;
    serializeJson(doc, output);
    return output;
  }

  // Updates DeviceState fields based on incoming JSON text message frames from Every-Panel hub
  static void handleEventText(const String& jsonPayload, DeviceState& state) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, jsonPayload);
    if (err) return;

    const char* msgType = doc["type"];
    if (msgType == nullptr) return;

    if (strcmp(msgType, "viewers_active") == 0) {
      state.viewersActive = true;
      state.triggerTelemetry = true;
    } else if (strcmp(msgType, "viewers_inactive") == 0) {
      state.viewersActive = false;
    }
  }
};

#endif
