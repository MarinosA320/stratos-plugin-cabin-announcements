// Loads the BUILT background module (dist/background/index.js) with a fake
// Stratos context and checks the wiring end to end: settings, flight/phase/sim
// subscriptions, playCustomSound calls, IPC broadcasts and HTTP routes.
//   pnpm build && node scripts/smoke-test.mjs
import express from "express";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";

const mod = (await import("../dist/background/index.js")).default;

const played = [];
const ipc = [];
const subs = { update: [], phase: [], sim: [] };
const config = new Map([["language", "el_en"], ["cruiseDelaySec", 90]]);
const app = express();

const ctx = {
  logger: { info: (c, m) => console.log(`  [${c}] ${m}`), warn: console.warn, error: console.error, debug() {} },
  config: {
    get: async (k, d) => (config.has(k) ? config.get(k) : d),
    set: async (k, v) => void config.set(k, v),
    delete: async (k) => void config.delete(k),
    getAll: async () => Object.fromEntries(config),
  },
  ipc: { handle() {}, removeHandler() {}, send: (ch, payload) => ipc.push({ ch, payload }) },
  notify: {
    playCustomSound: async (p) => {
      assert.ok(existsSync(new URL(`../dist/${p}`, import.meta.url)), `asset missing in dist: ${p}`);
      played.push(p);
    },
    toast: async () => {},
    playSound: async () => {},
  },
  server: { registerRouter: (prefix, router) => app.use(prefix, router) },
  plugin: { setIndicator: async () => {}, clearIndicator: async () => {} },
  flight: {
    getState: async () => ({ flight: null, pendingRecovery: null, simDisconnected: false, reconnecting: false, timestamp: Date.now() }),
    getPhase: async () => ({ currentPhase: "boarding", previousPhase: null, pendingTransition: null, trends: null, isTracking: true }),
    getSnapshot: async () => ({ isConnected: true, simulatorType: "msfs", data: frame() }),
    onUpdate: (cb) => (subs.update.push(cb), () => {}),
    onPhaseChange: (cb) => (subs.phase.push(cb), () => {}),
    onSimData: (cb) => (subs.sim.push(cb), () => {}),
  },
};

function frame(p = {}) {
  return { altitude: 300, altitudeAgl: 0, verticalSpeed: 0, groundSpeed: 0, planeOnground: true, gearControl: true,
    enginesCount: 2, engine1On: true, engine2On: true, engine3On: false, engine4On: false, pauseFlag: false, isInMenu: false, ...p };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mod.onStart(ctx);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/cabin-announcements`;

// 1. State route
let res = await fetch(`${base}/state`);
let state = await res.json();
assert.equal(res.status, 200);
assert.equal(state.tracking, false);
assert.equal(state.announcements.length, 14);
console.log("✓ GET /state");

// 2. Manual play: chime first, then Greek
res = await fetch(`${base}/play/turbulence`, { method: "POST" });
assert.equal(res.status, 200);
await sleep(400);
assert.deepEqual(played, ["assets/audio/chime_pa.mp3"]);
await sleep(3200);
assert.deepEqual(played, ["assets/audio/chime_pa.mp3", "assets/audio/turbulence.el.mp3"]);
console.log("✓ POST /play/turbulence → chime, then ΕΛ part");

res = await fetch(`${base}/play/nope`, { method: "POST" });
assert.equal(res.status, 404);
console.log("✓ unknown id → 404");

// 3. A flight starts at the gate → welcome gets scheduled
const flight = { flightPlan: { callsign: "GCA101", departureIcao: "LGAV", arrivalIcao: "LGIR" }, status: "active",
  vaTrackingId: "pirep-1", stratosFlightId: null, startedAt: Date.now(), currentPhase: "boarding" };
for (const cb of subs.update) cb({ flight, pendingRecovery: null, simDisconnected: false, reconnecting: false, timestamp: Date.now() });
await sleep(300);
state = await (await fetch(`${base}/state`)).json();
assert.equal(state.tracking, true);
assert.equal(state.callsign, "GCA101");
assert.equal(state.announcements.find((a) => a.id === "welcome").status, "scheduled");
console.log("✓ flight start → welcome scheduled");

// 4. UI gets live state pushes
assert.ok(ipc.length > 0 && ipc.every((m) => m.ch === "state"));
console.log(`✓ ${ipc.length} state broadcasts on channel "state"`);

// 5. Flight ends → engine resets
for (const cb of subs.update) cb({ flight: { ...flight, status: "completed" }, pendingRecovery: null, simDisconnected: false, reconnecting: false, timestamp: Date.now() });
await sleep(100);
state = await (await fetch(`${base}/state`)).json();
assert.equal(state.tracking, false);
console.log("✓ flight end → reset");

await mod.onStop(ctx);
server.close();
console.log("\nSmoke test passed.");
process.exit(0);
