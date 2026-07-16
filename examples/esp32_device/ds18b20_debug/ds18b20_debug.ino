/**
 * DS18B20 GPIO Scanner — Scans ALL usable ESP32 pins for 1-Wire devices
 * 
 * Useful when you're unsure which GPIO your sensor is wired to.
 * Opens Serial Monitor at 115200 and reports any DS18B20 found on each pin.
 */

#include <OneWire.h>
#include <DallasTemperature.h>

// All GPIOs safe to use as 1-Wire input on ESP32
// Excludes: 0 (boot), 1 (TX), 3 (RX), 6-11 (flash), 20, 24 (not exposed)
const int SCAN_PINS[] = {
  2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39
};
const int NUM_PINS = sizeof(SCAN_PINS) / sizeof(SCAN_PINS[0]);

void setup() {
  Serial.begin(115200);
  delay(2000);  // Extra time to open Serial Monitor
  Serial.println();
  Serial.println("========================================");
  Serial.println("  DS18B20 GPIO Scanner for ESP32");
  Serial.println("========================================");
  Serial.println();
  Serial.printf("Scanning %d GPIO pins for 1-Wire devices...\n\n", NUM_PINS);

  int totalFound = 0;

  for (int i = 0; i < NUM_PINS; i++) {
    int pin = SCAN_PINS[i];

    OneWire ow(pin);
    DallasTemperature sensor(&ow);
    sensor.begin();

    int count = sensor.getDeviceCount();
    if (count > 0) {
      Serial.printf(">>> GPIO%d: FOUND %d device(s)! <<<\n", pin, count);

      // Print addresses
      DeviceAddress addr;
      ow.reset_search();
      while (ow.search(addr)) {
        Serial.print("    Address: ");
        for (int j = 0; j < 8; j++) {
          if (addr[j] < 0x10) Serial.print("0");
          Serial.print(addr[j], HEX);
        }
        Serial.println();
      }

      // Try a temperature read
      sensor.requestTemperatures();
      float tempC = sensor.getTempCByIndex(0);
      if (tempC != DEVICE_DISCONNECTED_C) {
        Serial.printf("    Temperature: %.2f °C\n", tempC);
      } else {
        Serial.println("    Temperature: read error");
      }

      Serial.println();
      totalFound += count;
    } else {
      Serial.printf("    GPIO%d: --\n", pin);
    }
  }

  Serial.println();
  Serial.println("========================================");
  Serial.printf("  Scan complete. Total devices: %d\n", totalFound);
  Serial.println("========================================");

  if (totalFound == 0) {
    Serial.println();
    Serial.println("No sensors found on any pin. Check:");
    Serial.println("  1. 4.7k pull-up resistor between DATA and 3.3V");
    Serial.println("  2. VCC on 3.3V, GND on GND");
    Serial.println("  3. USB cable supports data (not charge-only)");
  }
}

void loop() {
  // Nothing — scan runs once at boot
  delay(10000);
}
