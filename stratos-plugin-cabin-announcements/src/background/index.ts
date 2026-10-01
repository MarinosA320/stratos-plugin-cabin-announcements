import { createPlugin } from "@skyvexsoftware/stratos-sdk/helpers";
import type { FlightManagerPayload, PluginContext } from "@skyvexsoftware/stratos-sdk";
import { Router, json } from "express";
import { AnnouncementEngine, type Phase, type SimFrame } from "@/shared/engine";
import { API_PREFIX, CATALOG_BY_ID, CHANNELS, DEFAULT_SETTINGS, SETTING_KEYS } from "@/shared/catalog";
import type { AnnouncementId, EngineSnapshot, LanguageMode, Settings } from "@/shared/types";

const TICK_MS = 250;
const SETTINGS_REFRESH_MS = 5_000;
const ACTIVE = new Set(["starting", "active", "paused", "completing"]);

type Runtime = {
  engine: AnnouncementEngine;
  timers: ReturnType<typeof setInterval>[];
  unsubs: (() => void)[];
};

let runtime: Runtime | null = null;

async function readSettings(ctx: PluginContext): Promise<Settings> {
  const c = ctx.config;
  const d = DEFAULT_SETTINGS;
  const lang = await c.get<string>(SETTING_KEYS.language, d.language);
  const delay = Number(await c.get<number | string>(SETTING_KEYS.cruiseDelaySec, d.cruiseDelaySec));
  return {
    enabled: bool(await c.get(SETTING_KEYS.enabled, d.enabled)),
    language: (["el_en", "en_el", "en", "el"].includes(lang) ? lang : d.language) as LanguageMode,
    chime: bool(await c.get(SETTING_KEYS.chime, d.chime)),
    cabin: bool(await c.get(SETTING_KEYS.cabin, d.cabin)),
    captain: bool(await c.get(SETTING_KEYS.captain, d.captain)),
    crew: bool(await c.get(SETTING_KEYS.crew, d.crew)),
    safety: bool(await c.get(SETTING_KEYS.safety, d.safety)),
    cruiseDelaySec: Number.isFinite(delay) ? Math.min(900, Math.max(0, delay)) : d.cruiseDelaySec,
  };
}

function bool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

function flightKey(state: FlightManagerPayload): string | null {
  const f = state.flight;
  if (!f || !ACTIVE.has(f.status)) return null;
  return f.vaTrackingId ?? f.stratosFlightId ?? String(f.startedAt ?? f.flightPlan.callsign);
}

export default createPlugin({
  async onStart(ctx) {
    const log = (msg: string) => ctx.logger.info("Announcements", msg);

    let lastSnap: EngineSnapshot | null = null;
    let lastEmit = 0;
    let pendingEmit: ReturnType<typeof setTimeout> | null = null;
    const broadcast = (snap: EngineSnapshot) => {
      lastSnap = snap;
      const now = Date.now();
      const send = () => {
        lastEmit = Date.now();
        pendingEmit = null;
        if (lastSnap) ctx.ipc.send(CHANNELS.state, lastSnap);
      };
      if (now - lastEmit > 250) send();
      else if (!pendingEmit) pendingEmit = setTimeout(send, 250);
    };

    const engine = new AnnouncementEngine(
      {
        now: () => Date.now(),
        play: (file) => {
          ctx.notify.playCustomSound(file).catch((err: unknown) => {
            ctx.logger.error("Announcements", `Could not play ${file}: ${String(err)}`);
          });
        },
        onChange: broadcast,
        log,
      },
      await readSettings(ctx),
    );

    let flightPaused = false;
    let simPaused = false;
    const updateHold = () => engine.setHold(flightPaused || simPaused);

    let currentKey: string | null = null;
    const handleFlight = async (state: FlightManagerPayload) => {
      const key = flightKey(state);
      if (!key) {
        currentKey = null;
        engine.endFlight();
        return;
      }
      flightPaused = state.flight?.status === "paused" || state.simDisconnected;
      updateHold();
      if (key === currentKey) return; // routine position update
      currentKey = key;
      const f = state.flight!;
      const [phaseSnap, simSnap] = await Promise.all([
        ctx.flight.getPhase().catch(() => null),
        ctx.flight.getSnapshot().catch(() => null),
      ]);
      engine.startFlight(
        {
          key,
          callsign: f.flightPlan.callsign ?? null,
          departure: f.flightPlan.departureIcao ?? null,
          arrival: f.flightPlan.arrivalIcao ?? null,
        },
        (phaseSnap?.currentPhase ?? f.currentPhase ?? "unknown") as Phase,
        (simSnap?.data as SimFrame | null) ?? null,
      );
    };

    const unsubs: (() => void)[] = [];
    unsubs.push(ctx.flight.onUpdate((s) => void handleFlight(s)));
    unsubs.push(
      ctx.flight.onPhaseChange((p) => engine.onPhase(p.previousPhase as Phase, p.currentPhase as Phase)),
    );
    unsubs.push(
      ctx.flight.onSimData((snap) => {
        if (!snap?.data) return;
        const paused = Boolean(snap.data.pauseFlag) || Boolean(snap.data.isInMenu);
        if (paused !== simPaused) {
          simPaused = paused;
          updateHold();
        }
        engine.onSimFrame(snap.data as SimFrame);
      }),
    );

    // Attach to a flight that was already running when the plugin started.
    void ctx.flight.getState().then(handleFlight).catch(() => {});

    const timers = [
      setInterval(() => engine.tick(), TICK_MS),
      setInterval(() => {
        void readSettings(ctx).then((s) => {
          if (JSON.stringify(s) !== JSON.stringify(engine.snapshot().settings)) engine.setSettings(s);
        });
      }, SETTINGS_REFRESH_MS),
    ];

    // ── HTTP routes for the UI ─────────────────────────────────────────────
    const router = Router();
    router.use(json({ limit: "16kb" }));
    router.use((_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    router.get("/state", (_req, res) => {
      res.json(engine.snapshot());
    });
    router.post("/play/:id", (req, res) => {
      const id = req.params.id as AnnouncementId;
      if (!CATALOG_BY_ID[id]) {
        res.status(404).json({ error: `Unknown announcement "${req.params.id}"` });
        return;
      }
      engine.playNow(id);
      res.json(engine.snapshot());
    });
    router.post("/queue/clear", (_req, res) => {
      engine.clearQueue();
      res.json(engine.snapshot());
    });
    ctx.server.registerRouter(API_PREFIX, router);

    runtime = { engine, timers, unsubs };
    log(`Started; routes at ${API_PREFIX}`);
  },

  async onStop(ctx) {
    if (runtime) {
      runtime.timers.forEach(clearInterval);
      runtime.unsubs.forEach((u) => u());
      runtime = null;
    }
    ctx.logger.info("Announcements", "Stopped");
  },
});
