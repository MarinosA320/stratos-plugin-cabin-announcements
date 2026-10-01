import type { AnnouncementGroup, AnnouncementId, Settings } from "./types";

export const PLUGIN_ID = "cabin-announcements";
export const API_PREFIX = `/api/${PLUGIN_ID}`;

export const ROUTES = {
  state: `${API_PREFIX}/state`,
  play: (id: AnnouncementId) => `${API_PREFIX}/play/${id}`,
  clear: `${API_PREFIX}/queue/clear`,
} as const;

/** Leaf channel names — the shell prefixes them with the plugin id. */
export const CHANNELS = {
  state: "state",
} as const;

export type CatalogEntry = {
  id: AnnouncementId;
  title: string;
  titleEl: string;
  group: AnnouncementGroup;
  /** Plain-language description of when it plays automatically. */
  when: string;
  /** Position in a normal flight; null = event-driven (go-around, turbulence). */
  stage: number | null;
  /** Manual-only announcements never fire on their own. */
  manualOnly?: boolean;
};

export const CATALOG: CatalogEntry[] = [
  { id: "welcome", title: "Welcome on board", titleEl: "Καλωσόρισμα", group: "cabin", stage: 0,
    when: "Boarding, about 15 s after the flight starts at the gate" },
  { id: "doors_arm", title: "Arm doors and cross-check", titleEl: "Όπλιση θυρών", group: "crew", stage: 1,
    when: "Pushback (or start of taxi if you don't push)" },
  { id: "safety", title: "Safety demonstration", titleEl: "Οδηγίες ασφαλείας", group: "safety", stage: 2,
    when: "Start of taxi-out" },
  { id: "seats_takeoff", title: "Seats for take-off", titleEl: "Θέσεις για απογείωση", group: "crew", stage: 3,
    when: "Strobe or landing lights switched on during taxi (falls back to the take-off roll)" },
  { id: "after_takeoff", title: "After take-off", titleEl: "Μετά την απογείωση", group: "cabin", stage: 4,
    when: "Climbing through 10,000 ft (or reaching cruise, whichever comes first)" },
  { id: "captain_cruise", title: "Captain's cruise welcome", titleEl: "Χαιρετισμός κυβερνήτη", group: "captain", stage: 5,
    when: "Shortly after reaching cruise (delay set in settings)" },
  { id: "top_of_descent", title: "Top of descent", titleEl: "Έναρξη καθόδου", group: "captain", stage: 6,
    when: "Start of descent" },
  { id: "prepare_landing", title: "Prepare cabin for landing", titleEl: "Προετοιμασία για προσγείωση", group: "cabin", stage: 7,
    when: "Descending through 10,000 ft (or start of approach)" },
  { id: "seats_landing", title: "Seats for landing", titleEl: "Θέσεις για προσγείωση", group: "crew", stage: 8,
    when: "Final approach (or gear down below 2,000 ft AGL)" },
  { id: "landed", title: "Welcome to destination", titleEl: "Μετά την προσγείωση", group: "cabin", stage: 9,
    when: "Taxi-in after landing" },
  { id: "doors_disarm", title: "Disarm doors and cross-check", titleEl: "Αφόπλιση θυρών", group: "crew", stage: 10,
    when: "Arrived at the gate (or all engines off after landing)" },
  { id: "farewell", title: "Farewell", titleEl: "Αποχαιρετισμός", group: "cabin", stage: 11,
    when: "Deboarding, after the doors are disarmed" },
  { id: "go_around", title: "Go-around", titleEl: "Διακοπή προσέγγισης", group: "captain", stage: null,
    when: "About 20 s after a go-around — can repeat" },
  { id: "turbulence", title: "Turbulence", titleEl: "Αναταράξεις", group: "captain", stage: null, manualOnly: true,
    when: "Manual only — press Play when you need it" },
];

export const CATALOG_BY_ID = Object.fromEntries(CATALOG.map((c) => [c.id, c])) as Record<
  AnnouncementId,
  CatalogEntry
>;

/** Keys used both in plugin.json availableSettings and ctx.config. */
export const SETTING_KEYS = {
  enabled: "enabled",
  language: "language",
  chime: "chime",
  cabin: "cabinAnnouncements",
  captain: "captainAnnouncements",
  crew: "crewCommands",
  safety: "safetyDemo",
  cruiseDelaySec: "cruiseDelaySec",
} as const;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  language: "el_en",
  chime: true,
  cabin: true,
  captain: true,
  crew: true,
  safety: true,
  cruiseDelaySec: 90,
};
