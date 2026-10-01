# Cabin Announcements — Stratos plugin

Automatic Greek + English cabin PA for Stratos ACARS. During every tracked flight, it plays the right announcement at the right moment. The trigger is the real flight phase, plus the aircraft's lights, altitude and engines.

| # | Announcement | Plays when | Voice |
|---|---|---|---|
| 1 | Welcome on board | Boarding, ~15 s after the flight starts | Purser · ΕΛ+EN |
| 2 | Arm doors and cross-check | Pushback (or start of taxi) | Purser · EN |
| 3 | Safety demonstration | Start of taxi-out | Purser · ΕΛ+EN |
| 4 | Seats for take-off | Strobes/landing lights switched on while taxiing (falls back to the take-off roll) | Captain · EN |
| 5 | After take-off | Climbing through 10,000 ft (or reaching cruise) | Purser · ΕΛ+EN |
| 6 | Captain's cruise welcome | Cruise + 90 s (configurable) | Captain · ΕΛ+EN |
| 7 | Top of descent | Start of descent | Captain · ΕΛ+EN |
| 8 | Prepare cabin for landing | Descending through 10,000 ft (or start of approach) | Purser · ΕΛ+EN |
| 9 | Seats for landing | Final (or gear down below 2,000 ft AGL) | Captain · EN |
| 10 | Welcome to destination | Taxi-in | Purser · ΕΛ+EN |
| 11 | Disarm doors and cross-check | Arrived at the gate (or engines off) | Purser · EN |
| 12 | Farewell | Deboarding | Purser · ΕΛ+EN |
| — | Go-around | ~20 s after a go-around (can repeat; re-arms "seats for landing") | Captain · ΕΛ+EN |
| — | Turbulence | Manual only | Captain · ΕΛ+EN |

How it behaves:

- **One voice at a time.** Only one announcement is on the PA at a time. The rest wait in a queue, and short crew commands go ahead of long passenger announcements.
- **Late announcements are dropped.** If an announcement is no longer relevant by the time the PA is free, it's skipped instead of played late. For example, the safety demo won't play once you're rolling.
- **Mid-flight starts.** If tracking starts mid-flight (for example after a crash recovery), everything before that point is marked as skipped.
- **Pausing.** Pausing the sim or the flight holds the queue.
- **Plugin panel.** The panel inside Stratos shows the live sequence, what's playing (with the text), and a Play button for every announcement. Play works any time, even without a flight.

## Pilot settings (Stratos → plugin settings)

- **Automatic announcements:** on/off.
- **Language:** Greek→English (default), English→Greek, English only, or Greek only. Crew commands are always in English, as on real Greek carriers.
- **PA chime:** on/off.
- **Groups:** cabin, captain, crew commands and safety demo can each be switched on or off.
- **Cruise announcement delay:** how long after reaching cruise the captain speaks.

Audio goes through Stratos's own sound system (`ctx.notify.playCustomSound`). If a pilot has muted Stratos notification sounds, the PA is muted too.

## Develop

```bash
pnpm install
pnpm test          # engine unit tests (a full simulated flight, go-around, mid-air start…)
pnpm typecheck
pnpm dev           # start Stratos with --dev first; the plugin hot-loads into it
```

## Publish to your pilots

1. On skyvexsoftware.com, create an API token with the `plugin:upload` scope.
2. Run:
   ```bash
   SKYVEX_API_TOKEN=xxxx pnpm bundle
   ```
   This builds the plugin, zips `dist/` and uploads it. Skyvex validates the manifest, signs the bundle and puts it on their CDN.
   If you don't set the token, it just creates `bundle.zip` so you can upload it by hand.
3. The plugin is `"type": "airline"`, so in your VA's Stratos admin you can push it to all pilots or to selected ones. It installs at their next login and updates automatically.

The plugin id `cabin-announcements` is generic. If Skyvex says it's taken, change `id` in `plugin.json` (for example to `greekconnect-cabin-announcements`) and `PLUGIN_ID` in `src/shared/catalog.ts`.

## GitHub repository

Skyvex asks for the plugin's GitHub repository. Put this folder in a repo, for example `greekconnect/stratos-plugin-cabin-announcements`.

The repo includes `.github/workflows/deploy.yml`, which can build and publish new versions for you:

1. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**. Add one called `SKYVEX_API_TOKEN` containing your Skyvex token.
2. To publish, open **Actions → Deploy plugin to Skyvex → Run workflow**. Remember to bump `version` in `plugin.json` first.

## Changing the words or the voices

All text lives in `scripts/announcements.json`.

- **To change wording:** edit the text, then run `pnpm audio`. This runs `python3 scripts/generate_audio.py`, which needs `pip install piper-tts numpy scipy` and `ffmpeg`. The voices download automatically. It regenerates every MP3 in `assets/audio/`, plus `src/shared/clips.generated.ts`, which holds the durations and transcripts the plugin uses.
- **To use real recordings:** overwrite `assets/audio/<id>.<el|en>.mp3` with your own files. Then run `python3 scripts/generate_audio.py --durations-only` so the plugin knows the new lengths. This matters because the queue uses the lengths to avoid two clips overlapping.
- **To regenerate one announcement:** run `python3 scripts/generate_audio.py --only welcome safety`.

Voices are [Piper](https://github.com/rhasspy/piper) TTS models:

| Role | Voice | Dataset licence |
|---|---|---|
| Greek | `el-gr-rapunzelina-low` | CC0 |
| English purser | `en-gb-southern_english_female-low` | CC BY-SA 4.0 (OpenSLR 83) |
| English captain | `en-gb-alan-low` | Mycroft mimic3 voice |

The audio is passed through a filter (band-limited speaker, light compression, short cabin reverb) to sound like an aircraft PA.

## Layout

```
plugin.json                      manifest + pilot settings
assets/audio/*.mp3               chimes + 26 voice clips (~4 MB)
scripts/announcements.json       all scripts, Greek + English
scripts/generate_audio.py        TTS + PA effect → MP3 + clips.generated.ts
scripts/smoke-test.mjs           loads the built background with a fake Stratos and checks the wiring
src/shared/engine.ts             trigger rules + PA queue (pure TS, unit-tested)
src/shared/catalog.ts            titles, groups, settings keys, routes
src/background/index.ts          Stratos glue: flight/phase/sim subscriptions, playCustomSound, HTTP routes
src/ui/                          the panel shown inside Stratos
```
