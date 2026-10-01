import { useState, type ReactNode } from "react";
import {
  Ban,
  Check,
  ChevronDown,
  Clock,
  ListOrdered,
  Megaphone,
  Play,
  PlaneTakeoff,
  Settings2,
  Volume2,
} from "lucide-react";
import { Badge, Button, cn } from "@skyvexsoftware/stratos-sdk";
import { CATALOG, CATALOG_BY_ID, type CatalogEntry } from "@/shared/catalog";
import { CHIMES, CLIPS } from "@/shared/clips.generated";
import type { AnnouncementState, EngineSnapshot, Lang, LanguageMode } from "@/shared/types";
import { useEngineState, useNow } from "./useEngineState";
import "./styles.css";

const LANG_LABEL: Record<LanguageMode, string> = {
  el_en: "ΕΛ → EN",
  en_el: "EN → ΕΛ",
  el: "ΕΛ only",
  en: "EN only",
};

const PHASE_LABEL: Record<string, string> = {
  unknown: "—",
  boarding: "Boarding",
  push_back: "Pushback",
  taxi: "Taxi",
  take_off: "Take-off",
  rejected_take_off: "Rejected take-off",
  climb: "Climb",
  cruise: "Cruise",
  descent: "Descent",
  approach: "Approach",
  final: "Final",
  landed: "Landed",
  go_around: "Go-around",
  taxi_in: "Taxi-in",
  arrived: "Arrived",
  deboarding: "Deboarding",
};

export default function Plugin() {
  const { state, error, play, clear } = useEngineState();

  if (!state) {
    return (
      <div className="min-h-full bg-background text-foreground p-6">
        <p className="text-sm text-muted-foreground">
          {error ? `Couldn't reach the announcement engine: ${error}` : "Loading…"}
        </p>
      </div>
    );
  }

  const byId = Object.fromEntries(state.announcements.map((a) => [a.id, a]));
  const flow = CATALOG.filter((c) => c.stage !== null);
  const onDemand = CATALOG.filter((c) => c.stage === null);

  return (
    <div className="min-h-full bg-background text-foreground p-6 flex flex-col gap-5">
      <Header state={state} onClear={clear} />
      <NowPlaying state={state} />

      <section className="flex flex-col gap-2">
        <SectionTitle icon={<PlaneTakeoff className="w-3.5 h-3.5" />} title="Flight sequence" />
        <ol className="flex flex-col rounded-lg border border-border overflow-hidden">
          {flow.map((c) => (
            <Row key={c.id} entry={c} st={byId[c.id]} queued={state.queue.includes(c.id)} onPlay={play} />
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle icon={<Megaphone className="w-3.5 h-3.5" />} title="On demand" />
        <ol className="flex flex-col rounded-lg border border-border overflow-hidden">
          {onDemand.map((c) => (
            <Row key={c.id} entry={c} st={byId[c.id]} queued={state.queue.includes(c.id)} onPlay={play} />
          ))}
        </ol>
      </section>

      <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
        <Settings2 className="w-3.5 h-3.5 mt-px shrink-0" />
        <span>
          Language, chimes and which groups play automatically are in this plugin's settings. Announcements use
          Stratos's notification sound — if that's muted, the PA is too. Play works any time, even without a flight.
        </span>
      </p>
    </div>
  );
}

function Header({ state, onClear }: { state: EngineSnapshot; onClear: () => void }) {
  const s = state.settings;
  return (
    <header className="flex items-center justify-between gap-3 flex-wrap pb-4 border-b border-border">
      <div className="flex items-center gap-2 min-w-0 text-[12px]">
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            state.tracking ? "bg-emerald-400" : "bg-muted-foreground/40",
          )}
          aria-hidden
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {state.tracking ? "Tracking" : "No flight"}
        </span>
        {state.tracking && (
          <>
            <Sep />
            <span className="font-semibold">{state.callsign ?? "—"}</span>
            {state.departure && state.arrival && (
              <>
                <Sep />
                <span className="truncate">
                  {state.departure}
                  <span className="text-muted-foreground/60 mx-1.5">→</span>
                  {state.arrival}
                </span>
              </>
            )}
            <Sep />
            <span className="font-mono text-[10.5px] text-muted-foreground uppercase">
              {PHASE_LABEL[state.phase] ?? state.phase}
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        {!s.enabled && <Badge variant="destructive">Auto off</Badge>}
        <Badge variant="outline" className="font-mono">
          {LANG_LABEL[s.language]}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          disabled={state.queue.length === 0}
          onClick={onClear}
          title="Drop announcements waiting for the PA"
        >
          <ListOrdered className="w-3.5 h-3.5 mr-1.5" />
          Clear queue{state.queue.length ? ` (${state.queue.length})` : ""}
        </Button>
      </div>
    </header>
  );
}

function NowPlaying({ state }: { state: EngineSnapshot }) {
  const np = state.nowPlaying;
  const now = useNow(Boolean(np));
  if (!np) {
    const next = state.queue[0];
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-3 text-[12px] text-muted-foreground flex items-center gap-2">
        <Volume2 className="w-4 h-4 opacity-50" />
        {next ? `Next on the PA: ${CATALOG_BY_ID[next].title}` : "PA is quiet"}
      </div>
    );
  }

  const clip = CLIPS[np.id];
  const entry = CATALOG_BY_ID[np.id];
  const part = np.lang === "chime" ? null : clip.parts[np.lang as Lang];
  const total = np.lang === "chime" ? CHIMES[clip.chime].durationMs : (part?.durationMs ?? 1);
  const pct = Math.min(100, Math.max(0, 100 - ((np.endsAt - now) / total) * 100));

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Volume2 className="w-4 h-4 text-primary animate-pulse" />
        <span className="font-semibold text-[13px]">{entry.title}</span>
        <span className="text-[11px] text-muted-foreground">{entry.titleEl}</span>
        <Badge variant="secondary" className="ml-auto font-mono uppercase">
          {np.lang === "chime" ? "chime" : np.lang === "el" ? "ΕΛ" : "EN"}
        </Badge>
      </div>
      <div className="h-1 rounded-full bg-border overflow-hidden">
        <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      {part && <p className="text-[12px] leading-relaxed text-foreground/80">{part.text}</p>}
    </div>
  );
}

function Row({
  entry,
  st,
  queued,
  onPlay,
}: {
  entry: CatalogEntry;
  st: AnnouncementState;
  queued: boolean;
  onPlay: (id: CatalogEntry["id"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const clip = CLIPS[entry.id];
  const playing = st.status === "playing";

  return (
    <li className="border-b border-border last:border-b-0">
      <div className={cn("flex items-center gap-3 px-3 py-2.5", playing && "bg-primary/5")}>
        <StatusIcon status={st.status} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex-1 min-w-0 text-left flex flex-col gap-0.5"
          aria-expanded={open}
        >
          <span className="flex items-baseline gap-2 min-w-0">
            <span className={cn("text-[13px] font-medium truncate", st.status === "skipped" && "text-muted-foreground")}>
              {entry.title}
            </span>
            <span className="text-[11px] text-muted-foreground truncate">{entry.titleEl}</span>
            <ChevronDown className={cn("w-3 h-3 text-muted-foreground shrink-0 transition-transform", open && "rotate-180")} />
          </span>
          <span className="text-[11px] text-muted-foreground truncate">
            {st.note && st.status === "skipped" ? `Skipped — ${st.note}` : entry.when}
          </span>
        </button>
        <GroupTag group={entry.group} />
        <Button
          size="icon"
          variant="ghost"
          className="w-8 h-8 shrink-0"
          disabled={playing || queued}
          onClick={() => onPlay(entry.id)}
          title={`Play "${entry.title}" now`}
          aria-label={`Play ${entry.title} now`}
        >
          <Play className="w-3.5 h-3.5" />
        </Button>
      </div>
      {open && (
        <div className="px-3 pb-3 pl-10 flex flex-col gap-2">
          {(["el", "en"] as const).map((lang) =>
            clip.parts[lang] ? (
              <p key={lang} className="text-[12px] leading-relaxed text-foreground/80">
                <span className="font-mono text-[10px] text-muted-foreground mr-2">{lang === "el" ? "ΕΛ" : "EN"}</span>
                {clip.parts[lang]!.text}
              </p>
            ) : null,
          )}
        </div>
      )}
    </li>
  );
}

function StatusIcon({ status }: { status: AnnouncementState["status"] }) {
  const base = "w-4 h-4 shrink-0";
  switch (status) {
    case "played":
      return <Check className={cn(base, "text-emerald-400")} aria-label="Played" />;
    case "playing":
      return <Volume2 className={cn(base, "text-primary animate-pulse")} aria-label="Playing" />;
    case "queued":
      return <ListOrdered className={cn(base, "text-amber-400")} aria-label="Queued" />;
    case "scheduled":
      return <Clock className={cn(base, "text-amber-400")} aria-label="Scheduled" />;
    case "skipped":
      return <Ban className={cn(base, "text-muted-foreground/50")} aria-label="Skipped" />;
    default:
      return <span className={cn(base, "rounded-full border border-muted-foreground/40 scale-50")} aria-label="Waiting" />;
  }
}

const GROUP_LABEL: Record<CatalogEntry["group"], string> = {
  cabin: "Cabin",
  captain: "Captain",
  crew: "Crew",
  safety: "Safety",
};

function GroupTag({ group }: { group: CatalogEntry["group"] }) {
  return (
    <span className="hidden sm:inline font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground border border-border rounded px-1.5 py-0.5">
      {GROUP_LABEL[group]}
    </span>
  );
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <h2 className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
      {icon}
      {title}
    </h2>
  );
}

function Sep() {
  return <span className="text-muted-foreground/40">·</span>;
}
