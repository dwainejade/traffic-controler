import { useEffect, type ReactNode } from "react";

/**
 * A panel that becomes a bottom sheet on a phone.
 *
 * On a wide screen the HUD can afford to put things in corners; on a narrow one
 * there is exactly one place a panel can go without covering the map you are
 * trying to read, and that is the bottom, temporarily, over a scrim.
 *
 * The desktop form is the caller's business — this is only the mobile one — so
 * callers render `<Sheet>` or their own popover and pass the same children to
 * both.
 */
export function Sheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stop here: the HUD's own Escape handler would clear the junction
        // selection underneath, which is not what closing a sheet means.
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet" role="dialog">
        <div className="sheet-grip" />
        <div className="sheet-body">{children}</div>
      </div>
    </>
  );
}
