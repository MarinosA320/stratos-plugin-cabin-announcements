/**
 * The announcement engine: decides *what* plays *when*.
 *
 * Pure TypeScript with no Stratos or Electron imports, so it can be unit
 * tested with a fake clock (see engine.test.ts). The background module feeds it
 * flight-phase changes and simulator frames and calls tick() on a timer; the
 * engine calls `player.play(file)` and reports state through `onChange`.
 *
 * Rules of thumb it follows:
 *  - every announcement plays at most once per flight (go-around excepted);
 *  - only one thing is on the PA at a time — the rest wait in a queue, and
 *    short crew commands jump ahead of long passenger announcements;
 *  - an announcement that is no longer relevant by the time the PA is free
 *    (e.g. the safety demo when you are already rolling) is dropped;
 *  - if tracking starts mid-flight, everything before that point is skipped.
 */
import { CATALOG, CATALOG_BY_ID } from "./catalog";
import { CHIMES, CLIPS } from "./clips.generated";
import type {
  AnnouncementId,
  AnnouncementState,
  EngineSnapshot,
  Lang,
  Settings,
} from "./types";

/** Flight phases as Stratos reports them (FlightPhase enum string values). */
export type Phase =
  | "unknown"
  | "boarding"
  | "push_back"
  | "taxi"
  | "take_off"
  | "rejected_take_off"
  | "climb"
  | "cruise"
  | "descent"
  | "approach"
  | "final"
  | "landed"
  | "go_around"
  | "taxi_in"
  | "arrived"
  | "deboarding";

/** The subset of Stratos FlightData the engine looks at. */
export type SimFrame = {
  altitude: number; // ft MSL
  altitudeAgl: number; // ft
  verticalSpeed: number; // fpm
  groundSpeed: number; // kt
  planeOnground: boolean;
  gearControl: boolean;
  lightStrobe?: boolean;
  lightLanding?: boolean;
  enginesCount: number;
  engine1On: boolean;
  engine2On: boolean;
  engine3On: boolean;
  engine4On: boolean;
  pauseFlag?: boolean;
};

export type FlightInfo = {
  key: string; // something unique per flight (tracking id / startedAt)
  callsign: string | null;
  departure: string | null;
  arrival: string | null;
};

export type EngineDeps = {
  now: () => number;
  play: (file: string) => void;
  onChange?: (snap: EngineSnapshot) => void;
  log?: (msg: string) => void;
};

type Step = { file: string; durationMs: number; lang: Lang | "chime" };
type QueueItem = { id: AnnouncementId; manual: boolean };
type Scheduled = { id: AnnouncementId; dueAt: number };

const GAP_AFTER_CHIME_MS = 150;
const GAP_BETWEEN_LANGS_MS = 700;
const GAP_BETWEEN_ANNOUNCEMENTS_MS = 2500;
const SIM_SAMPLE_MS = 1000;

/** Stage the flight is at when tracking begins, by phase. Earlier stages get skipped. */
const STAGE_AT_PHASE: Record<Phase, number> = {
  unknown: 0,
  boarding: 0,
  push_back: 1,
  taxi: 1,
  take_off: 4,
  rejected_take_off: 1,
  climb: 4,
  cruise: 5,
  descent: 6,
  approach: 7,
  final: 8,
  go_around: 7,
  landed: 9,
  taxi_in: 9,
  arrived: 10,
  deboarding: 11,
};

export class AnnouncementEngine {
  private settings: Settings;
  private flight: FlightInfo | null = null;
  private phase: Phase = "unknown";
  private states = new Map<AnnouncementId, AnnouncementState>();
  private scheduled: Scheduled[] = [];
  private queue: QueueItem[] = [];
  private steps: Step[] = [];
  private current: { id: AnnouncementId; step: Step; endsAt: number } | null = null;
  private paFreeAt = 0;
  private hold = false;

  // Flight memory used by the rules.
  private airborne = false;
  private hasBeenAirborne = false;
  private landedSinceAirborne = false;
  private lastFrame: SimFrame | null = null;
  private lastSampleAt = 0;
  private lightsOnAtTaxiStart: boolean | null = null;

  constructor(
    private readonly deps: EngineDeps,
    settings: Settings,
  ) {
    this.settings = settings;
    this.resetStates();
  }

  // ── public API ────────────────────────────────────────────────────────────

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.emit();
  }

  /** A flight started tracking (or the engine attached to one already running). */
  startFlight(info: FlightInfo, phase: Phase, frame: SimFrame | null): void {
    if (this.flight?.key === info.key) return;
    this.flight = info;
    this.resetFlightMemory();
    this.phase = phase;
    if (frame) this.observe(frame, true);

    // Mid-flight start: skip everything the flight is already past.
    let stage = STAGE_AT_PHASE[phase] ?? 0;
    if (phase === "unknown" && frame && !frame.planeOnground) stage = 4;
    for (const c of CATALOG) {
      if (c.stage !== null && c.stage < stage) this.skip(c.id, "Flight was already past this point");
    }
    this.log(`Flight ${info.callsign ?? info.key} started in phase ${phase} (stage ${stage})`);
    this.enterPhase(phase, "unknown");
    this.emit();
  }

  /** Tracking ended (completed, cancelled, crashed). */
  endFlight(): void {
    if (!this.flight) return;
    this.log(`Flight ${this.flight.callsign ?? this.flight.key} ended`);
    this.flight = null;
    this.scheduled = [];
    this.queue = this.queue.filter((q) => q.manual);
    this.resetFlightMemory();
    this.emit();
  }

  onPhase(prev: Phase, cur: Phase): void {
    if (cur === this.phase) return;
    this.phase = cur;
    if (this.flight) this.enterPhase(cur, prev);
    this.emit();
  }

  onSimFrame(frame: SimFrame): void {
    const now = this.deps.now();
    if (now - this.lastSampleAt < SIM_SAMPLE_MS) return;
    this.lastSampleAt = now;
    this.observe(frame, false);
  }

  /** Pilot pressed Play in the UI. Goes to the front of the queue. */
  playNow(id: AnnouncementId): void {
    this.queue = this.queue.filter((q) => q.id !== id);
    this.queue.unshift({ id, manual: true });
    this.scheduled = this.scheduled.filter((s) => s.id !== id);
    this.setStatus(id, "queued");
    this.tick();
  }

  /** Drop everything waiting (does not cut off what is already playing). */
  clearQueue(): void {
    for (const q of this.queue) this.skip(q.id, "Cleared by pilot");
    for (const s of this.scheduled) this.skip(s.id, "Cleared by pilot");
    this.queue = [];
    this.scheduled = [];
    this.emit();
  }

  /** While held (sim or flight paused) nothing new starts; the current clip finishes. */
  setHold(hold: boolean): void {
    if (hold === this.hold) return;
    this.hold = hold;
    this.log(hold ? "Holding announcements (paused)" : "Resuming announcements");
  }

  /** Call every ~250 ms. */
  tick(): void {
    const now = this.deps.now();
    let changed = false;

    // 1. Scheduled → queue when due.
    const due = this.hold ? [] : this.scheduled.filter((s) => s.dueAt <= now);
    if (due.length) {
      this.scheduled = this.scheduled.filter((s) => s.dueAt > now);
      for (const s of due) {
        this.enqueue(s.id);
        changed = true;
      }
    }

    // 2. Advance the PA.
    if (this.current && now >= this.current.endsAt) {
      const finished = this.current;
      this.current = null;
      changed = true;
      if (this.steps.length === 0) {
        this.setStatus(finished.id, "played", false);
        this.paFreeAt = now + GAP_BETWEEN_ANNOUNCEMENTS_MS;
      }
    }

    if (!this.current && this.steps.length > 0) {
      this.startStep(this.current_id!, now);
      changed = true;
    } else if (!this.current && !this.hold && now >= this.paFreeAt) {
      const next = this.nextPlayable();
      if (next) {
        this.beginAnnouncement(next, now);
        changed = true;
      }
    }

    if (changed) this.emit();
  }

  snapshot(): EngineSnapshot {
    return {
      tracking: this.flight !== null,
      callsign: this.flight?.callsign ?? null,
      departure: this.flight?.departure ?? null,
      arrival: this.flight?.arrival ?? null,
      phase: this.phase,
      nowPlaying: this.current
        ? { id: this.current.id, lang: this.current.step.lang, endsAt: this.current.endsAt }
        : null,
      queue: this.queue.map((q) => q.id),
      announcements: CATALOG.map((c) => ({ ...this.states.get(c.id)! })),
      settings: this.settings,
      updatedAt: this.deps.now(),
    };
  }

  // ── rules ─────────────────────────────────────────────────────────────────

  private enterPhase(cur: Phase, prev: Phase): void {
    switch (cur) {
      case "boarding":
        this.schedule("welcome", 15_000);
        break;
      case "push_back":
        this.schedule("welcome", 0); // never got a boarding phase
        this.schedule("doors_arm", 3_000);
        break;
      case "taxi":
        if (!this.hasBeenAirborne) {
          this.schedule("doors_arm", 2_000);
          this.schedule("safety", 6_000);
          this.lightsOnAtTaxiStart = this.lastFrame ? lightsOn(this.lastFrame) : null;
        }
        break;
      case "take_off":
        this.schedule("seats_takeoff", 0);
        break;
      case "cruise":
        this.schedule("after_takeoff", 3_000);
        this.schedule("captain_cruise", this.settings.cruiseDelaySec * 1000);
        break;
      case "descent":
        if (this.hasBeenAirborne) this.schedule("top_of_descent", 3_000);
        break;
      case "approach":
        this.schedule("prepare_landing", 2_000);
        break;
      case "final":
        this.schedule("seats_landing", 0);
        break;
      case "go_around":
        this.rearm("go_around");
        this.rearm("seats_landing");
        this.schedule("go_around", 20_000);
        break;
      case "taxi_in":
        this.schedule("landed", 4_000);
        break;
      case "arrived":
        this.schedule("landed", 0);
        this.schedule("doors_disarm", 3_000);
        this.schedule("farewell", 25_000);
        break;
      case "deboarding":
        this.schedule("doors_disarm", 0);
        this.schedule("farewell", 2_000);
        break;
      default:
        break;
    }
    void prev;
  }

  private observe(f: SimFrame, initial: boolean): void {
    const prev = this.lastFrame;
    this.lastFrame = f;
    if (f.pauseFlag) return;

    if (!f.planeOnground) {
      this.airborne = true;
      this.hasBeenAirborne = true;
    } else if (this.airborne) {
      this.airborne = false;
      this.landedSinceAirborne = true;
    }
    if (initial || !this.flight) return;

    // Seats for take-off: strobe/landing lights switched on while taxiing out.
    if (!this.hasBeenAirborne && f.planeOnground && this.phase === "taxi" && prev) {
      if (!lightsOn(prev) && lightsOn(f) && this.lightsOnAtTaxiStart !== true) {
        this.schedule("seats_takeoff", 0);
      }
    }

    // After take-off: climbing through 10,000 ft.
    if (this.airborne && f.verticalSpeed > 300 && f.altitude > 10_000) {
      this.schedule("after_takeoff", 0);
    }

    // Prepare for landing: descending through 10,000 ft in descent/approach.
    if (
      this.airborne &&
      (this.phase === "descent" || this.phase === "approach") &&
      f.verticalSpeed < -300 &&
      f.altitude < 10_000
    ) {
      this.schedule("prepare_landing", 0);
    }

    // Seats for landing: gear down below 2,000 ft AGL on approach.
    if (this.airborne && this.phase === "approach" && f.gearControl && f.altitudeAgl < 2_000) {
      this.schedule("seats_landing", 0);
    }

    // Engines off at the gate without an "arrived" phase.
    if (this.landedSinceAirborne && f.planeOnground && f.groundSpeed < 1 && !anyEngineOn(f)) {
      this.schedule("landed", 0);
      this.schedule("doors_disarm", 2_000);
      this.schedule("farewell", 20_000);
    }
  }

  /** Is the announcement still sensible right now? Checked when the PA frees up. */
  private stillRelevant(id: AnnouncementId): string | null {
    const ground = this.lastFrame ? this.lastFrame.planeOnground : !this.airborne;
    switch (id) {
      case "welcome":
      case "doors_arm":
      case "safety":
        if (this.hasBeenAirborne || this.phase === "take_off") return "Already taking off";
        return null;
      case "seats_takeoff":
        return this.hasBeenAirborne && this.phase !== "take_off" ? "Already airborne" : null;
      case "after_takeoff":
        return this.phase === "descent" || this.phase === "approach" || this.phase === "final" || ground
          ? "Already descending"
          : null;
      case "captain_cruise":
        return this.phase === "cruise" ? null : "No longer in cruise";
      case "top_of_descent":
        return this.phase === "final" || ground ? "Too close to landing" : null;
      case "prepare_landing":
        return ground ? "Already landed" : null;
      case "seats_landing":
      case "go_around":
        return ground ? "Already landed" : null;
      case "landed":
      case "doors_disarm":
      case "farewell":
        return ground ? null : "Not on the ground";
      default:
        return null;
    }
  }

  // ── machinery ─────────────────────────────────────────────────────────────

  private schedule(id: AnnouncementId, delayMs: number): void {
    const st = this.states.get(id)!;
    if (st.status !== "waiting") return;
    const entry = CATALOG_BY_ID[id];
    if (entry.manualOnly) return;
    const off = this.disabledReason(id);
    if (off) {
      this.skip(id, off);
      return;
    }
    this.scheduled.push({ id, dueAt: this.deps.now() + delayMs });
    this.setStatus(id, "scheduled");
  }

  /** Let a repeatable announcement fire again. */
  private rearm(id: AnnouncementId): void {
    const st = this.states.get(id)!;
    if (st.status === "played" || st.status === "skipped") {
      st.status = "waiting";
      st.note = null;
    }
  }

  private enqueue(id: AnnouncementId): void {
    if (this.queue.some((q) => q.id === id)) return;
    const isCrew = CATALOG_BY_ID[id].group === "crew";
    if (isCrew) {
      // Crew commands are short and time-critical: put them ahead of
      // automatic passenger announcements (but behind manual requests).
      const idx = this.queue.findIndex((q) => !q.manual && CATALOG_BY_ID[q.id].group !== "crew");
      if (idx === -1) this.queue.push({ id, manual: false });
      else this.queue.splice(idx, 0, { id, manual: false });
    } else {
      this.queue.push({ id, manual: false });
    }
    this.setStatus(id, "queued", false);
  }

  private nextPlayable(): QueueItem | null {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      if (item.manual) return item;
      if (!this.settings.enabled) {
        this.skip(item.id, "Announcements are switched off");
        continue;
      }
      const off = this.disabledReason(item.id);
      if (off) {
        this.skip(item.id, off);
        continue;
      }
      const stale = this.stillRelevant(item.id);
      if (stale) {
        this.skip(item.id, stale);
        continue;
      }
      return item;
    }
    return null;
  }

  private current_id: AnnouncementId | null = null;

  private beginAnnouncement(item: QueueItem, now: number): void {
    const clip = CLIPS[item.id];
    const steps: Step[] = [];
    if (this.settings.chime) {
      const c = CHIMES[clip.chime];
      steps.push({ file: c.file, durationMs: c.durationMs + GAP_AFTER_CHIME_MS, lang: "chime" });
    }
    for (const lang of this.languageOrder()) {
      const part = clip.parts[lang];
      if (part) steps.push({ file: part.file, durationMs: part.durationMs + GAP_BETWEEN_LANGS_MS, lang });
    }
    // Crew commands exist only in English; Greek-only mode still plays them.
    if (!steps.some((s) => s.lang !== "chime") && clip.parts.en) {
      steps.push({ file: clip.parts.en.file, durationMs: clip.parts.en.durationMs, lang: "en" });
    }
    this.steps = steps;
    this.current_id = item.id;
    const st = this.states.get(item.id)!;
    st.count += 1;
    st.playedAt = now;
    st.note = item.manual ? "Played manually" : null;
    this.setStatus(item.id, "playing", false);
    this.log(`PA: ${item.id}${item.manual ? " (manual)" : ""}`);
    this.startStep(item.id, now);
  }

  private startStep(id: AnnouncementId, now: number): void {
    const step = this.steps.shift()!;
    this.current = { id, step, endsAt: now + step.durationMs };
    try {
      this.deps.play(step.file);
    } catch (err) {
      this.log(`play failed for ${step.file}: ${String(err)}`);
    }
  }

  private languageOrder(): Lang[] {
    switch (this.settings.language) {
      case "el_en":
        return ["el", "en"];
      case "en_el":
        return ["en", "el"];
      case "el":
        return ["el"];
      case "en":
        return ["en"];
    }
  }

  private disabledReason(id: AnnouncementId): string | null {
    const g = CATALOG_BY_ID[id].group;
    if (!this.settings.enabled) return "Announcements are switched off";
    if (g === "cabin" && !this.settings.cabin) return "Cabin announcements switched off";
    if (g === "captain" && !this.settings.captain) return "Captain announcements switched off";
    if (g === "crew" && !this.settings.crew) return "Crew commands switched off";
    if (g === "safety" && !this.settings.safety) return "Safety demo switched off";
    return null;
  }

  private skip(id: AnnouncementId, note: string): void {
    const st = this.states.get(id)!;
    if (st.status === "played" || st.status === "playing") return;
    st.status = "skipped";
    st.note = note;
  }

  private setStatus(id: AnnouncementId, status: AnnouncementState["status"], emit = true): void {
    this.states.get(id)!.status = status;
    if (emit) this.emit();
  }

  private resetStates(): void {
    this.states.clear();
    for (const c of CATALOG) {
      this.states.set(c.id, { id: c.id, status: "waiting", playedAt: null, count: 0, note: null });
    }
  }

  private resetFlightMemory(): void {
    this.resetStates();
    this.scheduled = [];
    this.airborne = false;
    this.hasBeenAirborne = false;
    this.landedSinceAirborne = false;
    this.lastFrame = null;
    this.lastSampleAt = 0;
    this.lightsOnAtTaxiStart = null;
    this.phase = "unknown";
  }

  private emit(): void {
    this.deps.onChange?.(this.snapshot());
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }
}

function lightsOn(f: SimFrame): boolean {
  return Boolean(f.lightStrobe) || Boolean(f.lightLanding);
}

function anyEngineOn(f: SimFrame): boolean {
  const on = [f.engine1On, f.engine2On, f.engine3On, f.engine4On].slice(0, Math.max(1, f.enginesCount || 1));
  return on.some(Boolean);
}
