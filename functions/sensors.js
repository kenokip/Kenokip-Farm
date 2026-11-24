// Kenokip Farm — poultry-house sensors (ESP32 sensor box).
//
// The sensor box in the poultry house posts its readings here every few
// minutes over HTTPS. Each box has its own device id + secret key: the key
// is made once by an administrator in the app (createSensorDevice), shown
// a single time to copy into the box's firmware, and only its SHA-256 hash
// is ever stored. A request with a wrong or revoked key is refused.
//
// What gets written (all read-only for the app; only this file writes):
//   sensorLatest/{deviceId}   newest reading + today's running totals +
//                             alert state — one small doc the app listens to
//   sensorDays/{deviceId}_{YYYY-MM-DD}
//                             every reading of that (Nairobi) day as a
//                             compact point list, so a 24-hour chart is one
//                             document read and a week is seven
//   sensorAlerts/{auto}       each alert raised or cleared, newest first
//   sensorDevices/{deviceId}  name, key hash, created/last-seen times
// Settings (alert limits + the lighting schedule) live in
// sensorSettings/main, which an administrator edits from the app; they are
// also sent back to the box in every reply so it knows when to switch the
// lights on.
//
// Alerts go out as real push notifications (same helper as urgent team
// messages, see push.js) to the administrator/co-administrator and, unless
// turned off in settings, the Supervisor and Farmhand. Each kind of alert
// needs two readings in a row before it fires (so one odd reading doesn't
// wake anyone), repeats at most every 3 hours while it lasts, and sends a
// short "back to normal" once it clears. A scheduled watchdog raises an
// "offline" alert when a box goes quiet (power or internet down at the
// farm), and a daily 5 pm check compares today's water use with the
// previous days' — birds drinking much less is often the first sign of
// illness.
const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { sendUrgentPush } = require('./push');
const { timingSafeStringEqual } = require('./cryptoHelpers');

const TZ = 'Africa/Nairobi';
const DEFAULT_SETTINGS = {
  intervalSec: 300,
  houseTempHigh: 30, houseTempLow: 12,
  chickTempHigh: 34, chickTempLow: 18,
  humidityHigh: 85, humidityLow: 30,
  ammoniaHigh: 25,
  noWaterHours: 3,          // daytime hours with no water flow before alerting
  waterDropPercent: 60,     // alert if today's water by 5 pm is under this % of usual
  notifyTeam: true,         // also notify Supervisor + Farmhand (admins always)
  lights: { mode: 'off', morningOn: '04:00', morningOff: '07:00', eveningOn: '', eveningOff: '', luxThreshold: 50 },
};
const REPEAT_MS = 3 * 3600 * 1000;
const OFFLINE_AFTER_MS = 20 * 60 * 1000;

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function nairobiParts(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms));
  const o = {}; parts.forEach(function (p) { o[p.type] = p.value; });
  return { date: o.year + '-' + o.month + '-' + o.day, time: o.hour + ':' + o.minute, hour: Number(o.hour), minute: Number(o.minute) };
}
function num(v, lo, hi) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !isFinite(n) || n < lo || n > hi) return null;
  return Math.round(n * 10) / 10;
}
function cleanReading(r, nowMs) {
  let ts = Number(r.ts) * 1000;
  // Buffered readings carry their own time; anything missing, in the
  // future, or older than 2 days is treated as "now".
  if (!isFinite(ts) || ts > nowMs + 120000 || ts < nowMs - 2 * 86400000) ts = nowMs;
  return {
    ts: ts,
    ht: num(r.ht, -10, 60), hh: num(r.hh, 0, 100),       // house temp °C / humidity %
    ct: num(r.ct, -10, 60), ch: num(r.ch, 0, 100),       // chick corner temp / humidity
    nh3: num(r.nh3, 0, 500),                             // ammonia, estimated ppm
    wl: num(r.wl, 0, 1000),                              // litres since the last reading
    wd: num(r.wd, 0, 5000),                              // litres so far today (box's own count)
    lx: num(r.lx, 0, 120000),                            // light, lux
    lt: r.lt === 1 || r.lt === true ? 1 : (r.lt === 0 || r.lt === false ? 0 : null), // lights relay on/off
  };
}
const ALERT_LABELS = { houseHot: 'Poultry house temperature', houseCold: 'Poultry house temperature', chickCold: 'Chick corner temperature',
  chickHot: 'Chick corner temperature', humidHigh: 'Humidity', ammoniaHigh: 'Ammonia', noWater: 'Water flow' };
function currentValueText(k, r) {
  if (k === 'houseHot' || k === 'houseCold') return fmtC(r.ht) + ', ' + (r.hh === null ? '—' : r.hh + '%');
  if (k === 'chickCold' || k === 'chickHot') return fmtC(r.ct);
  if (k === 'humidHigh') return (r.hh === null ? '—' : r.hh + '%');
  if (k === 'ammoniaHigh') return 'about ' + Math.round(r.nh3 || 0) + ' ppm';
  if (k === 'noWater') return 'water is flowing again';
  return '';
}
function fmtC(v) { return v === null || v === undefined ? '—' : (Math.round(v * 10) / 10) + '°C'; }

module.exports = function (admin, db) {
  const FieldValue = admin.firestore.FieldValue;
  let settingsCache = null, settingsCacheAt = 0;
  async function getSettings() {
    if (settingsCache && Date.now() - settingsCacheAt < 60000) return settingsCache;
    const snap = await db.collection('sensorSettings').doc('main').get();
    const s = Object.assign({}, DEFAULT_SETTINGS, snap.exists ? snap.data() : {});
    s.lights = Object.assign({}, DEFAULT_SETTINGS.lights, (snap.exists && snap.data().lights) || {});
    settingsCache = s; settingsCacheAt = Date.now();
    return s;
  }
  async function recipients(settings) {
    const snap = await db.collection('users').get();
    const out = [];
    snap.forEach(function (d) {
      const u = d.data() || {};
      if (u.role === 'administrator' || u.role === 'coadmin') out.push(d.id);
      else if (settings.notifyTeam && u.role === 'employee' && (u.jobTitle === 'supervisor' || u.jobTitle === 'farmhand')) out.push(d.id);
    });
    return out;
  }
  async function notify(settings, deviceId, key, level, title, body) {
    try {
      await db.collection('sensorAlerts').add({ deviceId, key, level, title, body, at: FieldValue.serverTimestamp(), atMs: Date.now() });
    } catch (e) { logger.error('sensorAlerts write failed', e); }
    try {
      const uids = await recipients(settings);
      await sendUrgentPush(admin, db, uids, title, body, { urgency: level === 'alert' ? 'urgent' : 'normal', kind: 'sensor' });
    } catch (e) { logger.error('sensor push failed', e); }
  }

  // Which alert conditions hold for this reading: {key: {on, title, body}}
  function evaluate(r, latest, settings, nowMs) {
    const out = {};
    function cond(key, on, title, body) { out[key] = { on: !!on, title, body }; }
    if (r.ht !== null) {
      cond('houseHot', r.ht >= settings.houseTempHigh, '🔥 Poultry house too hot: ' + fmtC(r.ht), 'Above ' + settings.houseTempHigh + '°C — open the sides for air, give cool water and shade. Hens lay less when it\'s this hot.');
      cond('houseCold', r.ht <= settings.houseTempLow, '🥶 Poultry house cold: ' + fmtC(r.ht), 'Below ' + settings.houseTempLow + '°C — close the side curtains against the wind and check the chicks are under their mothers.');
    }
    if (r.ct !== null) {
      cond('chickCold', r.ct <= settings.chickTempLow, '🐥 Chick corner cold: ' + fmtC(r.ct), 'Below ' + settings.chickTempLow + '°C where the chicks are — check they are under the hens and out of any draught.');
      cond('chickHot', r.ct >= settings.chickTempHigh, '🐥 Chick corner hot: ' + fmtC(r.ct), 'Above ' + settings.chickTempHigh + '°C where the chicks are — give shade and fresh water.');
    }
    if (r.hh !== null) {
      cond('humidHigh', r.hh >= settings.humidityHigh, '💧 Very damp poultry house: ' + r.hh + '%', 'Humidity above ' + settings.humidityHigh + '% — wet litter breeds coccidiosis and ammonia. Improve airflow and replace wet litter.');
    }
    if (r.nh3 !== null) {
      cond('ammoniaHigh', r.nh3 >= settings.ammoniaHigh, '🫧 Strong ammonia: about ' + Math.round(r.nh3) + ' ppm', 'Above ' + settings.ammoniaHigh + ' ppm — remove wet/caked litter, add fresh dry litter and open up for airflow.');
    }
    // Only boxes with a water meter fitted report wl; the clock starts at
    // 7 am each day so last night's quiet hours never count.
    const p = nairobiParts(nowMs);
    const daytime = p.hour >= 7 && p.hour < 18;
    const sevenAm = nowMs - ((p.hour - 7) * 60 + p.minute) * 60000;
    const lastFlow = Math.max(latest.lastFlowAtMs || 0, sevenAm);
    if (r.wl !== null) cond('noWater', daytime && nowMs - lastFlow >= settings.noWaterHours * 3600000,
      '🚰 No water used for ' + settings.noWaterHours + '+ hours',
      'The water meter has not moved since ' + nairobiParts(lastFlow).time + ' — check the tank, the pipe and the drinkers.');
    return out;
  }

  const sensorIngest = onRequest({ region: 'us-central1', cors: false, maxInstances: 3 }, async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
    const body = (typeof req.body === 'object' && req.body) ? req.body : {};
    const deviceId = String(req.get('x-device-id') || body.deviceId || '').trim();
    const key = String(req.get('x-device-key') || body.key || '').trim();
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(deviceId) || !key) { res.status(401).json({ ok: false, error: 'missing device id/key' }); return; }
    const devRef = db.collection('sensorDevices').doc(deviceId);
    const dev = await devRef.get();
    if (!dev.exists || dev.data().revoked || !timingSafeStringEqual(sha256(key), dev.data().keyHash || '')) {
      logger.warn('sensorIngest: rejected device', { deviceId });
      res.status(403).json({ ok: false, error: 'unknown or revoked device' });
      return;
    }
    const nowMs = Date.now();
    const list = Array.isArray(body.readings) ? body.readings.slice(0, 60) : [body];
    const readings = list.map(function (r) { return cleanReading(r || {}, nowMs); }).sort(function (a, b) { return a.ts - b.ts; });
    if (!readings.length) { res.status(400).json({ ok: false, error: 'no readings' }); return; }
    const settings = await getSettings();

    try {
      // 1) Day documents — one write per (Nairobi) day touched.
      const byDay = {};
      readings.forEach(function (r) {
        const p = nairobiParts(r.ts);
        const point = { t: p.time };
        ['ht', 'hh', 'ct', 'ch', 'nh3', 'wl', 'wd', 'lx', 'lt'].forEach(function (k) { if (r[k] !== null) point[k] = r[k]; });
        if (Object.keys(point).length > 1) (byDay[p.date] = byDay[p.date] || []).push(point);
      });
      await Promise.all(Object.keys(byDay).map(function (date) {
        return db.collection('sensorDays').doc(deviceId + '_' + date).set({
          deviceId, date, points: FieldValue.arrayUnion.apply(null, byDay[date]), updatedAtMs: nowMs,
        }, { merge: true });
      }));

      // 2) Latest doc + running totals + alerts (in a transaction so two
      //    overlapping posts can't double-count water or double-alert).
      const latestRef = db.collection('sensorLatest').doc(deviceId);
      const toSend = [];
      await db.runTransaction(async function (tx) {
        const snap = await tx.get(latestRef);
        const latest = snap.exists ? snap.data() : {};
        const today = nairobiParts(nowMs).date;
        const sameDay = latest.date === today;
        let waterToday = sameDay ? (latest.waterToday || 0) : 0;
        let lightMinutes = sameDay ? (latest.lightMinutesToday || 0) : 0;
        let lastFlowAtMs = latest.lastFlowAtMs || null;
        let prevTs = latest.atMs || null;
        readings.forEach(function (r) {
          if (nairobiParts(r.ts).date !== today) { prevTs = r.ts; return; }
          if (r.wl) { waterToday += r.wl; lastFlowAtMs = r.ts; }
          if (r.lt === 1 && prevTs && r.ts > prevTs) lightMinutes += Math.min(30, (r.ts - prevTs) / 60000);
          prevTs = r.ts;
        });
        const newest = readings[readings.length - 1];
        const next = {
          deviceId, name: dev.data().name || 'Sensor box', atMs: newest.ts, at: FieldValue.serverTimestamp(), date: today,
          firstSeenTodayMs: sameDay ? (latest.firstSeenTodayMs || newest.ts) : newest.ts,
          waterToday: Math.round(waterToday * 10) / 10, lightMinutesToday: Math.round(lightMinutes), lastFlowAtMs: lastFlowAtMs,
          fw: String(body.fw || '').slice(0, 20), rssi: num(body.rssi, -120, 0), uptimeSec: num(body.uptime, 0, 1e9),
        };
        ['ht', 'hh', 'ct', 'ch', 'nh3', 'lx', 'lt'].forEach(function (k) { next[k] = newest[k]; });
        if (newest.wd !== null) next.boxWaterToday = newest.wd;

        // Alerts
        const alerts = Object.assign({}, latest.alerts || {});
        const results = evaluate(newest, Object.assign({}, latest, next), settings, nowMs);
        Object.keys(results).forEach(function (k) {
          const r = results[k], a = Object.assign({ count: 0, active: false, lastSentMs: 0 }, alerts[k] || {});
          if (r.on) {
            a.count += 1;
            if (a.count >= 2 && (!a.active || nowMs - a.lastSentMs >= REPEAT_MS)) {
              toSend.push({ key: k, level: 'alert', title: r.title, body: r.body });
              a.active = true; a.lastSentMs = nowMs; a.sinceMs = a.sinceMs || nowMs;
            }
          } else {
            if (a.active) toSend.push({ key: k, level: 'clear', title: '✅ ' + (ALERT_LABELS[k] || 'Reading') + ' back to normal', body: 'Now: ' + currentValueText(k, newest) + '.' });
            a.count = 0; a.active = false; a.sinceMs = null;
          }
          alerts[k] = a;
        });
        if (latest.offline) toSend.push({ key: 'offline', level: 'clear', title: '✅ Farm sensors back online', body: 'Readings are coming in again.' });
        next.alerts = alerts; next.offline = false;
        tx.set(latestRef, next, { merge: true });
      });
      await devRef.set({ lastSeenMs: nowMs, fw: String(body.fw || '').slice(0, 20) }, { merge: true });
      for (const n of toSend) await notify(settings, deviceId, n.key, n.level, n.title, n.body);
    } catch (e) {
      logger.error('sensorIngest failed', e);
      res.status(500).json({ ok: false, error: 'server error' });
      return;
    }
    res.json({ ok: true, serverTime: Math.floor(nowMs / 1000), config: { intervalSec: settings.intervalSec, lights: settings.lights } });
  });

  function requireAdminLevel(request) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const role = request.auth.token.role;
    if (role !== 'administrator' && role !== 'coadmin') throw new HttpsError('permission-denied', 'Only the administrator or co-administrator can do this.');
  }

  // Makes a new sensor box identity. The key is returned ONCE — only its
  // hash is stored, so it can't be shown again (make a new box to replace it).
  const createSensorDevice = onCall({ region: 'us-central1' }, async (request) => {
    requireAdminLevel(request);
    const name = String((request.data && request.data.name) || 'Poultry house').trim().slice(0, 40) || 'Poultry house';
    const deviceId = 'box-' + crypto.randomBytes(4).toString('hex');
    const key = crypto.randomBytes(16).toString('hex'); // 32 characters
    await db.collection('sensorDevices').doc(deviceId).set({
      name, keyHash: sha256(key), createdAtMs: Date.now(), createdBy: request.auth.uid, revoked: false,
    });
    return { deviceId, key, name };
  });

  const revokeSensorDevice = onCall({ region: 'us-central1' }, async (request) => {
    requireAdminLevel(request);
    const deviceId = String((request.data && request.data.deviceId) || '');
    if (!deviceId) throw new HttpsError('invalid-argument', 'Which box?');
    await db.collection('sensorDevices').doc(deviceId).set({ revoked: true, revokedAtMs: Date.now() }, { merge: true });
    await db.collection('sensorLatest').doc(deviceId).delete().catch(function () {});
    return { ok: true };
  });

  // Every 10 minutes: a box silent for 20+ minutes means power or internet
  // is down at the farm (or the box itself has a problem).
  const sensorWatchdog = onSchedule({ schedule: 'every 10 minutes', timeZone: TZ, region: 'us-central1' }, async () => {
    try {
      const nowMs = Date.now();
      const snap = await db.collection('sensorLatest').get();
      if (snap.empty) return;
      const settings = await getSettings();
      for (const d of snap.docs) {
        const l = d.data() || {};
        if (!l.atMs || l.offline || nowMs - l.atMs < OFFLINE_AFTER_MS) continue;
        await d.ref.set({ offline: true, offlineSinceMs: l.atMs }, { merge: true });
        await notify(settings, d.id, 'offline', 'alert', '📡 Farm sensors offline',
          'No readings since ' + nairobiParts(l.atMs).time + ' — the power or the internet at the farm may be off.');
      }
    } catch (e) { logger.error('sensorWatchdog failed', e); }
  });

  // Every day at 5 pm: compare water used so far today with the same time
  // on the previous three days.
  const sensorWaterCheck = onSchedule({ schedule: '0 17 * * *', timeZone: TZ, region: 'us-central1' }, async () => {
    try {
      const settings = await getSettings();
      const latestSnap = await db.collection('sensorLatest').get();
      for (const d of latestSnap.docs) {
        const l = d.data() || {};
        const today = nairobiParts(Date.now()).date;
        if (l.date !== today) continue;
        const usual = [];
        for (let i = 1; i <= 3; i++) {
          const day = nairobiParts(Date.now() - i * 86400000).date;
          const ds = await db.collection('sensorDays').doc(d.id + '_' + day).get();
          if (!ds.exists) continue;
          const total = (ds.data().points || []).filter(function (p) { return p.t <= '17:00'; })
            .reduce(function (a, p) { return a + (Number(p.wl) || 0); }, 0);
          if (total > 0) usual.push(total);
        }
        if (usual.length < 2) continue;
        const avg = usual.reduce(function (a, b) { return a + b; }, 0) / usual.length;
        const now = l.waterToday || 0;
        if (avg >= 5 && now < avg * settings.waterDropPercent / 100) {
          await notify(settings, d.id, 'waterDrop', 'alert', '🚰 Birds are drinking less today',
            Math.round(now) + ' L by 5 pm, usually about ' + Math.round(avg) + ' L. Check the drinkers and watch for sick birds.');
        }
      }
    } catch (e) { logger.error('sensorWaterCheck failed', e); }
  });

  return { triggers: { sensorIngest, createSensorDevice, revokeSensorDevice, sensorWatchdog, sensorWaterCheck } };
};
