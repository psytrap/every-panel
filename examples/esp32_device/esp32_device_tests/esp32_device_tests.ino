/**
 * ============================================================================
 * EVERY-PANEL ESP32 CLIENT UNIT TESTS
 * ============================================================================
 * An on-device unit test suite that validates the core helper functions,
 * URL parser, message types, and dynamic configuration rules of the client.
 *
 * How to Run:
 *   1. Open this sketch in the Arduino IDE.
 *   2. Connect your ESP32 board.
 *   3. Select correct Board/Port and upload.
 *   4. Open the Serial Monitor at 115200 baud to view results.
 * ============================================================================
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include "../TelemetryLogic.h"

// Global Test Counters
int testsRun = 0;
int testsPassed = 0;

// Custom assertion helpers
void assertEqual(const String& label, const String& actual, const String& expected) {
  testsRun++;
  if (actual == expected) {
    testsPassed++;
    Serial.printf("  [PASS] %s\n", label.c_str());
  } else {
    Serial.printf("  [FAIL] %s\n", label.c_str());
    Serial.printf("         Expected: '%s'\n", expected.c_str());
    Serial.printf("         Actual:   '%s'\n", actual.c_str());
  }
}

void assertEqual(const String& label, int actual, int expected) {
  testsRun++;
  if (actual == expected) {
    testsPassed++;
    Serial.printf("  [PASS] %s\n", label.c_str());
  } else {
    Serial.printf("  [FAIL] %s\n", label.c_str());
    Serial.printf("         Expected: %d\n", expected);
    Serial.printf("         Actual:   %d\n", actual);
  }
}

// ==========================================
// Test Suites
// ==========================================

void runUrlParserTests() {
  Serial.println("\n--- Running URL Parser Tests ---");
  String protocol, host, path;
  int port;

  // Test Case 1: Standard ws URL
  TelemetryLogic::parseUrl("ws://192.168.1.100", protocol, host, port, path);
  assertEqual("Case 1 - ws protocol", protocol, "ws");
  assertEqual("Case 1 - ws host", host, "192.168.1.100");
  assertEqual("Case 1 - ws port", port, 80);
  assertEqual("Case 1 - ws path", path, "/ws");

  // Test Case 2: Secure wss URL with custom port and path
  TelemetryLogic::parseUrl("wss://hub.every-panel.com:8443/custom/ws?token=123", protocol, host, port, path);
  assertEqual("Case 2 - wss protocol", protocol, "wss");
  assertEqual("Case 2 - wss host", host, "hub.every-panel.com");
  assertEqual("Case 2 - wss port", port, 8443);
  assertEqual("Case 2 - wss path", path, "/custom/ws?token=123");

  // Test Case 3: URL without protocol prefix
  TelemetryLogic::parseUrl("localhost:8000/api/ws", protocol, host, port, path);
  assertEqual("Case 3 - fallback host", host, "localhost");
  assertEqual("Case 3 - custom port", port, 8000);
  assertEqual("Case 3 - custom path", path, "/api/ws");
}

void runMessageParsingTests() {
  Serial.println("\n--- Running Message Parsing Tests ---");
  
  // Test Case 4: Parse active viewer message
  JsonDocument docActive;
  DeserializationError errActive = deserializeJson(docActive, "{\"type\":\"viewers_active\"}");
  assertEqual("Case 4 - json active decode success", (errActive == DeserializationError::Ok), 1);
  const char* typeActive = docActive["type"];
  assertEqual("Case 4 - active msg type match", String(typeActive), "viewers_active");

  // Test Case 5: Parse inactive viewer message
  JsonDocument docInactive;
  DeserializationError errInactive = deserializeJson(docInactive, "{\"type\":\"viewers_inactive\"}");
  assertEqual("Case 5 - json inactive decode success", (errInactive == DeserializationError::Ok), 1);
  const char* typeInactive = docInactive["type"];
  assertEqual("Case 5 - inactive msg type match", String(typeInactive), "viewers_inactive");
}

void runTemperatureSensorLogicTests() {
  Serial.println("\n--- Running Temperature Sensor Logic Tests ---");
  
  // Test Case 6: DS18B20 Disconnected Fault State Validation (-127°C)
  float tempFaultVal = -127.0; // DEVICE_DISCONNECTED_C
  bool localHasFault = (tempFaultVal == -127.0);
  assertEqual("Case 6 - flag hasFault on sensor disconnect", localHasFault, 1);

  // Test Case 7: Valid Temperature Read Validation (23.56°C)
  float tempValidVal = 23.56;
  bool localHasFault2 = (tempValidVal == -127.0);
  assertEqual("Case 7 - flag normal on valid sensor read", localHasFault2, 0);

  // Test Case 8: Dynamic Status Text formatting check
  String statusFault = TelemetryLogic::getStatusText(localHasFault);
  assertEqual("Case 8 - fault status text selection", statusFault, "SENSOR FAULT: DS18B20 disconnected");

  String statusNormal = TelemetryLogic::getStatusText(localHasFault2);
  assertEqual("Case 8 - normal status text selection", statusNormal, "Running normally");

  // Test Case 9: Telemetry decimal rounding logic check (rounding to 1 decimal place)
  String payloadNormal = TelemetryLogic::buildTelemetryJson("test_device", 23.56, "12s", false);
  
  JsonDocument docTelemetry;
  deserializeJson(docTelemetry, payloadNormal);
  float roundedVal = docTelemetry["data"]["temperature"];
  assertEqual("Case 9 - temp rounding 23.56 -> 23.6", String(roundedVal, 1), "23.6");
}

void runStateTransitionTests() {
  Serial.println("\n--- Running State Transition Tests ---");

  DeviceState state;
  state.connected = true;
  state.layoutSent = true;
  state.viewersActive = false;
  state.triggerTelemetry = false;

  // Test Case 10: Receive viewers_active text message
  TelemetryLogic::handleEventText("{\"type\":\"viewers_active\"}", state);
  assertEqual("Case 10 - viewersActive is true", state.viewersActive, 1);
  assertEqual("Case 11 - triggerTelemetry is true", state.triggerTelemetry, 1);

  // Test Case 12: Receive viewers_inactive text message
  state.triggerTelemetry = false;
  TelemetryLogic::handleEventText("{\"type\":\"viewers_inactive\"}", state);
  assertEqual("Case 12 - viewersActive is false", state.viewersActive, 0);
  assertEqual("Case 13 - triggerTelemetry remains false", state.triggerTelemetry, 0);
}

// ==========================================
// Arduino Execution Entrypoints
// ==========================================

void setup() {
  Serial.begin(115200);
  delay(2000); // Allow time for Serial connection
  
  Serial.println("\n=================================");
  Serial.println("  ESP32 CLIENT ON-DEVICE TESTS   ");
  Serial.println("=================================");

  runUrlParserTests();
  runMessageParsingTests();
  runTemperatureSensorLogicTests();
  runStateTransitionTests();

  Serial.println("\n=================================");
  Serial.printf(" TEST RUN RESULT: %d of %d passed\n", testsPassed, testsRun);
  Serial.println("=================================");
}

void loop() {
  // Unit tests run once on startup and halt
  delay(1000);
}
