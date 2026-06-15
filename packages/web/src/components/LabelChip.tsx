import { X } from "lucide-react";
import type { Label } from "../api";

/** Default chip color when a label has none ('') — slate-600. */
export const DEFAULT_LABEL_COLOR = "#475569";

// A label pill (MAIL-16). Read-only on list rows; pass onRemove in the reading
// pane to show a detach "×". White text on the label's color reads on the
// preset mid-tone palette the labels manager offers.
export function LabelChip({
  label,
  onRemove,
}: {
  label: Label;
  onRemove?: () => void;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
      style={{ backgroundColor: label.color || DEFAULT_LABEL_COLOR }}
    >
      <span className="truncate">{label.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove label ${label.name}`}
          className="-mr-0.5 shrink-0 opacity-80 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
