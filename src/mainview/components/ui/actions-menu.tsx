import { useRef, useState } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";

export interface ActionsMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * "More" button for secondary page actions (FO-UX02-E). Reuses the existing
 * `ContextMenu` — portaled above every layer, arrow-key roving focus, Escape closes
 * and returns focus to this button — anchored under the button instead of a cursor.
 * Critical actions (approve, confirm) must never be hidden in here.
 */
export function ActionsMenu({ items, label, triggerLabel, testId }: { items: ActionsMenuItem[]; label: string; triggerLabel?: string; testId: string }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuItems: ContextMenuItem[] = items.map((item) => ({ id: item.id, label: item.label, icon: item.icon, disabled: item.disabled, onSelect: item.onSelect }));
  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.right - 176, y: rect.bottom + 4 });
  };
  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        aria-label={triggerLabel ?? label}
        onClick={() => (anchor ? setAnchor(null) : openMenu())}
        data-testid={testId}
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </Button>
      <ContextMenu open={anchor != null} x={anchor?.x ?? 0} y={anchor?.y ?? 0} items={menuItems} onClose={() => setAnchor(null)} label={label} testId={`${testId}-menu`} />
    </>
  );
}
