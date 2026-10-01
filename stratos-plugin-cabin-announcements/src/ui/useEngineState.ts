import { useCallback, useEffect, useState } from "react";
import { usePluginContext } from "@skyvexsoftware/stratos-sdk";
import { STRATOS_APP_BASE } from "@skyvexsoftware/stratos-sdk/helpers";
import { CHANNELS, ROUTES } from "@/shared/catalog";
import type { AnnouncementId, EngineSnapshot } from "@/shared/types";

const url = (route: string) => `${STRATOS_APP_BASE}${route}`;

async function call(route: string, method: "GET" | "POST" = "GET"): Promise<EngineSnapshot> {
  const res = await fetch(url(route), { method });
  const body = (await res.json().catch(() => null)) as EngineSnapshot | { error?: string } | null;
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return body as EngineSnapshot;
}

/** Live engine state: initial HTTP fetch, then pushes from the background. */
export function useEngineState() {
  const { socket, toast } = usePluginContext();
  const [state, setState] = useState<EngineSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    call(ROUTES.state)
      .then((s) => alive && (setState(s), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    const onState = (payload: unknown) => {
      if (alive && payload && typeof payload === "object") setState(payload as EngineSnapshot);
    };
    socket.on(CHANNELS.state, onState);
    return () => {
      alive = false;
      socket.off(CHANNELS.state, onState);
    };
  }, [socket]);

  const play = useCallback(
    (id: AnnouncementId) =>
      call(ROUTES.play(id), "POST").then(setState).catch((e: unknown) => toast.error(String(e))),
    [toast],
  );
  const clear = useCallback(
    () => call(ROUTES.clear, "POST").then(setState).catch((e: unknown) => toast.error(String(e))),
    [toast],
  );

  return { state, error, play, clear };
}

/** Re-render every `ms` while `active`, for countdowns. */
export function useNow(active: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
