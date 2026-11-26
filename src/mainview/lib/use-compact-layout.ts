import { useEffect, useState } from "react";

/** Compact rails switch to overlays without changing the desktop preference. */
export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}
