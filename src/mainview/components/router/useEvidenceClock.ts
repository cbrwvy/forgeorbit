import { useEffect, useState } from "react";
import type { RoutingPreview } from "../../../shared/model-router/types.ts";
import { evidenceBoundaries } from "@/lib/model-router-preview";

/** One-shot local expiry updates and wake-up checks. No polling or network IO. */
export function useEvidenceClock(previews: RoutingPreview | readonly RoutingPreview[] | null): number {
  const [now, setNow] = useState(Date.now);
  const boundariesKey = evidenceBoundaries(previews === null ? [] : Array.isArray(previews) ? previews : [previews as RoutingPreview]).join(",");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const boundaries = boundariesKey ? boundariesKey.split(",").map(Number) : [];
    const update = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      const next = boundaries.find(value => value > current);
      if (next !== undefined) timer = setTimeout(update, Math.min(2_147_483_647, next - current + 1));
    };
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [boundariesKey]);
  return Math.max(now, Date.now());
}
