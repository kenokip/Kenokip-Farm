# Poultry-house sensor box — setup guide

The sensor box is an ESP32 board in the poultry house. Every 5 minutes it reads:

- temperature and humidity in the house
- temperature and humidity in the chick corner
- ammonia
- water used
- light level

It sends the readings to the app's **Sensors** page and switches the laying-house lights on a schedule. You and the team get a push alert when something is wrong: too hot or too cold, too damp, strong ammonia, no water flowing, birds drinking much less than usual, or the box going offline.

Total parts cost is about **KSh 7,000–9,000** (plus the office router if you don't have one).

---

## 1. Parts

| Part | Qty | Notes |
|---|---|---|
| ESP32 DevKit (38-pin, "ESP32-WROOM-32") | 1 | The brain, with Wi-Fi |
| DHT22 temperature/humidity module | 2 | One for the house, one for the chick corner |
| MQ-135 gas sensor module | 1 | Ammonia (rough estimate) |
| YF-S201 water flow sensor, ½ inch | 1 | Plus 2 × ½" adapters to fit your drinker pipe |
| BH1750 light sensor module | 1 | Lets the lights come on only while it's still dark |
| 1-channel 5 V relay module (10 A) | 1 | Only if you want automatic lights |
| Resistors 10 kΩ ×2 and 20 kΩ ×2 | — | Voltage dividers (the 5 V signals must not go straight into the ESP32) |
| 5 V 2 A USB phone charger + good micro-USB/USB-C cable | 1 | Power |
| Plastic junction box (with a few holes for air), jumper wires, small perfboard or breadboard | — | |
| 3-core cable (alarm/telephone cable) | ~10 m | To reach the chick-corner DHT22 |

---

## 2. Wiring

```
ESP32 pin        Goes to
---------        -------------------------------------------------------------
3V3              DHT22 (house) +, DHT22 (chick) +, BH1750 VCC
5V / VIN         MQ-135 VCC, YF-S201 red, relay VCC
GND              every sensor's GND / – / black
GPIO 4           DHT22 (house) "out"
GPIO 16          DHT22 (chick corner) "out"
GPIO 21 (SDA)    BH1750 SDA
GPIO 22 (SCL)    BH1750 SCL
GPIO 34          MQ-135 "AO"  through the divider below
GPIO 27          YF-S201 yellow through the divider below
GPIO 26          relay "IN"
```

**Voltage divider** (one for MQ-135, one for the flow sensor). The signal goes into a 10 kΩ resistor. The far end of that resistor connects to the ESP32 pin, and also through a 20 kΩ resistor to GND:

```
sensor signal ──[10 kΩ]──┬── ESP32 pin
                         └──[20 kΩ]── GND
```

This brings 5 V down to about 3.3 V. Without it you can damage the ESP32.

**Lights (mains — get an electrician):**
- The relay's **COM** and **NO** terminals go in series with the *live* wire to the bulbs.
- Use LED bulbs and keep the relay inside the closed box.
- Never work on the mains side while it is plugged in.

---

## 3. Where to put things

- **House DHT22:** middle of the house at hen height (about 50 cm off the floor). Keep it out of direct sun and rain. Hang it *outside* the box, under a small shade, so the box's own warmth doesn't affect it.
- **Chick-corner DHT22:** low down, where the hens sit with their chicks, out of reach of pecking.
- **MQ-135:** at bird height in the middle of the house, inside the box but next to the air holes.
- **Water meter:** on the pipe from the tank to the drinkers, so every litre the birds drink goes through it. The arrow on the meter points in the direction the water flows.
- **BH1750:** facing a window or open side, not facing the bulbs.
- **Box:** under the roof, away from splashing water, close to a socket and within reach of the office Wi-Fi.

---

## 4. Get a device ID and key from the app

1. Deploy the app update and the backend (section 6).
2. In the app, go to **Sensors** and tap **Add sensor box**. Give it a name, e.g. "Layer house".
3. The app shows a few lines starting with `#define`. **Copy them now.** The key is only shown once.

---

## 5. Put the program on the ESP32

1. Install the **Arduino IDE** (arduino.cc).
2. **Boards Manager:** search "esp32" and install **esp32 by Espressif Systems** (version 3.x).
3. **Library Manager:** install:
   - **DHT sensor library** by Adafruit (accept "Adafruit Unified Sensor" too)
   - **BH1750** by Christopher Laws
   - **ArduinoJson** by Benoit Blanchon (version 7)
4. Open `kenokip-sensor-box/kenokip-sensor-box.ino`.
5. In the same folder, copy `secrets.example.h` to `secrets.h`. Paste the lines from the app, then fill in your Wi-Fi name and password.
6. Choose board **ESP32 Dev Module** and the right COM port, then **Upload**.
7. Open **Serial Monitor** at 115200. You should see "connected" and then "Upload: 1 reading(s) → HTTP 200". The Sensors page fills in within a few minutes.

Keep `secrets.h` private, and don't put the firmware folder inside `pwa-build`. That folder is published as the website.

### Ammonia calibration (once)

The MQ-135 needs about **24 hours powered on** before it settles. Then:

1. Carry the box outside into fresh air and wait 5 minutes.
2. Hold the **BOOT** button for 5 seconds, until the blue light flashes quickly.

Until you've done this, the app shows "No reading" for ammonia rather than a wrong number. The reading is an estimate, good for spotting when ammonia is rising, not a lab measurement.

---

## 6. Deploy (once)

From `pwa-build`:

```
firebase deploy --only firestore:rules
firebase deploy --only functions:sensorIngest,functions:createSensorDevice,functions:revokeSensorDevice,functions:sensorWatchdog,functions:sensorWaterCheck
```

Push the app files to GitHub as usual so Netlify publishes the Sensors page.

---

## 7. Lights schedule

On the Sensors page, under **Alert limits & lights**:

- set **Lights control** to **Automatic**;
- set a morning window, e.g. **04:00 → 07:00**.

The box switches the bulbs on in that window only while it's dark (below the lux level you set). It keeps following the schedule even if the internet is down. Laying hens do best with about **16 hours of light** a day. Don't give growing pullets extra light before they start laying.

---

## 8. Troubleshooting

| What you see | What to check |
|---|---|
| Sensors page says **Offline** | Power at the farm, office router on, Wi-Fi name/password in `secrets.h`. Box restarts itself if Wi-Fi is stuck for 30 min. |
| Serial Monitor: **HTTP 403** | Wrong DEVICE_ID/KEY, or the box was removed in the app. Add a new box and update `secrets.h`. |
| Temperature shows **—** | DHT22 wiring (+, out, –); cable to the chick corner too long (keep under ~10 m). |
| Water always 0 | Meter arrow direction; yellow wire divider; water actually flowing through that pipe. |
| Lights never switch | Lights control set to Automatic; relay wiring; some relays switch the other way — change `RELAY_ACTIVE_LOW` to `false`. |
