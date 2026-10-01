export type Lang = "el" | "en";
export type Speaker = "purser" | "captain";
export type ChimeKind = "pa" | "crew";

export type AnnouncementId =
  | "welcome"
  | "doors_arm"
  | "safety"
  | "seats_takeoff"
  | "after_takeoff"
  | "captain_cruise"
  | "top_of_descent"
  | "prepare_landing"
  | "seats_landing"
  | "go_around"
  | "landed"
  | "doors_disarm"
  | "farewell"
  | "turbulence";

export type ClipPart = { file: string; durationMs: number; text: string };

export type ClipManifest = Record<
  AnnouncementId,
  {
    speaker: Speaker;
    chime: ChimeKind;
    parts: Partial<Record<Lang, ClipPart>>;
  }
>;

/** Which group a pilot can switch on/off in settings. */
export type AnnouncementGroup = "cabin" | "captain" | "crew" | "safety";

/** Language order the pilot picked in settings. */
export type LanguageMode = "el_en" | "en_el" | "en" | "el";

export type Settings = {
  enabled: boolean;
  language: LanguageMode;
  chime: boolean;
  cabin: boolean;
  captain: boolean;
  crew: boolean;
  safety: boolean;
  cruiseDelaySec: number;
};

export type AnnouncementStatus =
  | "waiting" // not triggered yet this flight
  | "scheduled" // triggered, waiting for its delay
  | "queued" // waiting for the PA to be free
  | "playing"
  | "played"
  | "skipped"; // flight was already past this point, or it was switched off

export type AnnouncementState = {
  id: AnnouncementId;
  status: AnnouncementStatus;
  /** Epoch ms of the last time this announcement started playing. */
  playedAt: number | null;
  /** How many times it has played this flight (go-around can repeat). */
  count: number;
  /** Why it was skipped, if it was. */
  note: string | null;
};

export type EngineSnapshot = {
  tracking: boolean;
  callsign: string | null;
  departure: string | null;
  arrival: string | null;
  phase: string;
  /** Announcement currently on the PA, if any. */
  nowPlaying: { id: AnnouncementId; lang: Lang | "chime"; endsAt: number } | null;
  queue: AnnouncementId[];
  announcements: AnnouncementState[];
  settings: Settings;
  updatedAt: number;
};
