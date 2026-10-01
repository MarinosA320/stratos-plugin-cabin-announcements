import { describe, expect, it } from "vitest";
import { AnnouncementEngine, type Phase, type SimFrame } from "./engine";
import { DEFAULT_SETTINGS } from "./catalog";
import type { Settings } from "./types";

function frame(p: Partial<SimFrame> = {}): SimFrame {
  return {
    altitude: 300,
    altitudeAgl: 0,
    verticalSpeed: 0,
    groundSpeed: 0,
    planeOnground: true,
    gearControl: true,
    lightStrobe: false,
    lightLanding: false,
    enginesCount: 2,
    engine1On: true,
    engine2On: true,
    engine3On: false,
    engine4On: false,
    ...p,
  };
}

function harness(settings: Partial<Settings> = {}) {
  let t = 1_000_000;
  const played: { at: number; file: string }[] = [];
  const engine = new AnnouncementEngine(
    { now: () => t, play: (file) => played.push({ at: t, file }) },
    { ...DEFAULT_SETTINGS, ...settings },
  );
  let phase: Phase = "unknown";
  let cur = frame();
  const advance = (sec: number) => {
    for (let i = 0; i < sec * 4; i++) {
      t += 250;
      engine.onSimFrame(cur);
      engine.tick();
    }
  };
  const setPhase = (p: Phase) => {
    engine.onPhase(phase, p);
    phase = p;
  };
  const setFrame = (p: Partial<SimFrame>) => {
    cur = { ...cur, ...p };
  };
  const ids = () =>
    played
      .filter((p) => !p.file.includes("chime"))
      .map((p) => p.file.replace("assets/audio/", "").replace(".mp3", ""));
  return { engine, advance, setPhase, setFrame, ids, played, start: (p: Phase) => {
    phase = p;
    engine.startFlight({ key: "f1", callsign: "GCA101", departure: "LGAV", arrival: "LGIR" }, p, cur);
  } };
}

function flyFullFlight(h: ReturnType<typeof harness>) {
  h.start("boarding");
  h.advance(40);
  h.setPhase("push_back");
  h.advance(60);
  h.setPhase("taxi");
  h.setFrame({ groundSpeed: 15 });
  h.advance(200);
  h.setFrame({ lightStrobe: true, lightLanding: true });
  h.advance(10);
  h.setPhase("take_off");
  h.setFrame({ groundSpeed: 140 });
  h.advance(30);
  h.setPhase("climb");
  h.setFrame({ planeOnground: false, altitude: 5000, altitudeAgl: 4700, verticalSpeed: 2500, gearControl: false });
  h.advance(60);
  h.setFrame({ altitude: 11000, altitudeAgl: 10700 });
  h.advance(120);
  h.setPhase("cruise");
  h.setFrame({ altitude: 35000, verticalSpeed: 0 });
  h.advance(300);
  h.setPhase("descent");
  h.setFrame({ verticalSpeed: -2000 });
  h.advance(300);
  h.setFrame({ altitude: 9000, altitudeAgl: 8800 });
  h.advance(120);
  h.setPhase("approach");
  h.setFrame({ altitude: 3000, altitudeAgl: 2800, verticalSpeed: -800 });
  h.advance(60);
  h.setFrame({ gearControl: true, altitudeAgl: 1800 });
  h.advance(30);
  h.setPhase("final");
  h.advance(60);
  h.setPhase("landed");
  h.setFrame({ planeOnground: true, altitude: 100, altitudeAgl: 0, verticalSpeed: 0, groundSpeed: 60 });
  h.advance(20);
  h.setPhase("taxi_in");
  h.setFrame({ groundSpeed: 15 });
  h.advance(120);
  h.setPhase("arrived");
  h.setFrame({ groundSpeed: 0, engine1On: false, engine2On: false });
  h.advance(200);
}

describe("AnnouncementEngine", () => {
  it("plays a whole normal flight in order, Greek then English", () => {
    const h = harness();
    flyFullFlight(h);
    expect(h.ids()).toEqual([
      "welcome.el", "welcome.en",
      "doors_arm.en",
      "safety.el", "safety.en",
      "seats_takeoff.en",
      "after_takeoff.el", "after_takeoff.en",
      "captain_cruise.el", "captain_cruise.en",
      "top_of_descent.el", "top_of_descent.en",
      "prepare_landing.el", "prepare_landing.en",
      "seats_landing.en",
      "landed.el", "landed.en",
      "doors_disarm.en",
      "farewell.el", "farewell.en",
    ]);
  });

  it("never overlaps two clips", () => {
    const h = harness();
    flyFullFlight(h);
    const snap = h.engine.snapshot();
    expect(snap.announcements.every((a) => a.count <= 1)).toBe(true);
    // Every clip starts after the previous one's known duration.
    for (let i = 1; i < h.played.length; i++) {
      expect(h.played[i].at).toBeGreaterThan(h.played[i - 1].at);
    }
  });

  it("respects English-only and switched-off groups", () => {
    const h = harness({ language: "en", captain: false, chime: false });
    flyFullFlight(h);
    expect(h.ids()).not.toContain("captain_cruise.en");
    expect(h.ids().some((i) => i.endsWith(".el"))).toBe(false);
    expect(h.played.some((p) => p.file.includes("chime"))).toBe(false);
    const s = h.engine.snapshot().announcements.find((a) => a.id === "captain_cruise")!;
    expect(s.status).toBe("skipped");
  });

  it("Greek-only mode still plays English-only crew commands", () => {
    const h = harness({ language: "el" });
    flyFullFlight(h);
    expect(h.ids()).toContain("doors_arm.en");
    expect(h.ids()).toContain("welcome.el");
    expect(h.ids()).not.toContain("welcome.en");
  });

  it("skips earlier announcements when tracking starts in cruise", () => {
    const h = harness();
    h.setFrame({ planeOnground: false, altitude: 35000, altitudeAgl: 34000, gearControl: false });
    h.start("cruise");
    h.advance(200);
    expect(h.ids()).toEqual(["captain_cruise.el", "captain_cruise.en"]);
    const st = Object.fromEntries(h.engine.snapshot().announcements.map((a) => [a.id, a.status]));
    expect(st.welcome).toBe("skipped");
    expect(st.safety).toBe("skipped");
    expect(st.after_takeoff).toBe("skipped");
  });

  it("drops the safety demo if the take-off roll starts before it can play", () => {
    const h = harness();
    h.start("taxi");
    h.advance(3);
    h.setPhase("take_off");
    h.setFrame({ groundSpeed: 120 });
    h.advance(5);
    h.setFrame({ planeOnground: false, verticalSpeed: 2000, altitude: 1500, altitudeAgl: 1200 });
    h.setPhase("climb");
    h.advance(120);
    expect(h.ids()).not.toContain("safety.el");
    const st = Object.fromEntries(h.engine.snapshot().announcements.map((a) => [a.id, a]));
    expect(st.safety.status).toBe("skipped");
    // The PA was busy with "arm doors" until after lift-off, so the late
    // "seats for take-off" is dropped rather than played in the climb.
    expect(st.seats_takeoff.status).toBe("skipped");
  });

  it("re-plays seats-for-landing after a go-around", () => {
    const h = harness();
    h.setFrame({ planeOnground: false, altitude: 3000, altitudeAgl: 2800, gearControl: true, verticalSpeed: -700 });
    h.start("approach");
    h.advance(60);
    h.setPhase("final");
    h.advance(20);
    h.setPhase("go_around");
    h.setFrame({ verticalSpeed: 1500 });
    h.advance(90);
    h.setPhase("approach");
    h.setFrame({ verticalSpeed: -700 });
    h.advance(30);
    h.setPhase("final");
    h.advance(30);
    const ids = h.ids();
    expect(ids.filter((i) => i === "seats_landing.en").length).toBe(2);
    expect(ids).toContain("go_around.el");
  });

  it("manual play works with no flight and jumps the queue", () => {
    const h = harness();
    h.engine.playNow("turbulence");
    h.advance(60);
    expect(h.ids()).toEqual(["turbulence.el", "turbulence.en"]);
  });

  it("master switch off silences automatic announcements", () => {
    const h = harness({ enabled: false });
    flyFullFlight(h);
    expect(h.played.length).toBe(0);
  });
});
