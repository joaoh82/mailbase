import { Check, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ApiError,
  createLabel,
  deleteLabel,
  type Label,
  listLabels,
  type Mailbox,
  updateLabel,
} from "../api";
import { cn } from "../lib/utils";
import { DEFAULT_LABEL_COLOR } from "./LabelChip";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Preset palette: '' is the default chip color; the rest are mid-tones that
// stay legible with the white chip text. Keeping it a fixed set means the
// server's #rrggbb validation never trips on a hand-typed value.
const LABEL_COLORS = [
  "",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
];

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {LABEL_COLORS.map((c) => (
        <button
          key={c || "default"}
          type="button"
          aria-label={c || "Default color"}
          onClick={() => onChange(c)}
          className={cn(
            "h-5 w-5 rounded-full border border-slate-600",
            value === c && "ring-2 ring-sky-400 ring-offset-1 ring-offset-slate-900",
          )}
          style={{ backgroundColor: c || DEFAULT_LABEL_COLOR }}
        />
      ))}
    </div>
  );
}

// Manage the labels of one shared mailbox (MAIL-16): any member may create,
// rename, recolor, and delete them — they're shared, like the mailbox
// signature. Changes call onChanged so the sidebar list stays in step.
export function LabelsModal({
  mailbox,
  onClose,
  onChanged,
}: {
  mailbox: Mailbox;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listLabels(mailbox.id)
      .then((r) => setLabels(r.labels))
      .catch((err) => setError(message(err)));
  }, [mailbox.id]);

  function message(err: unknown): string {
    return err instanceof ApiError ? err.message : String(err);
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const { label } = await createLabel(mailbox.id, name, newColor);
      setLabels((prev) =>
        [...(prev ?? []), label].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setNewName("");
      setNewColor("");
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdate(id: string, patch: { name?: string; color?: string }) {
    setError(null);
    try {
      const { label } = await updateLabel(id, patch);
      setLabels((prev) =>
        (prev ?? [])
          .map((l) => (l.id === id ? label : l))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      onChanged();
    } catch (err) {
      setError(message(err));
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteLabel(id);
      setLabels((prev) => (prev ?? []).filter((l) => l.id !== id));
      onChanged();
    } catch (err) {
      setError(message(err));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold">Labels</h2>
          <p className="text-sm text-slate-400">
            Shared across everyone in{" "}
            <span className="text-slate-300">{mailbox.address}</span>. Apply them
            to messages and filter the inbox by label.
          </p>
        </div>

        {/* Create */}
        <div className="space-y-2 rounded-lg border border-slate-800 p-3">
          <Input
            placeholder="New label name"
            value={newName}
            maxLength={64}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <ColorPicker value={newColor} onChange={setNewColor} />
            <Button size="sm" disabled={busy || !newName.trim()} onClick={handleCreate}>
              Add
            </Button>
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {/* Existing */}
        <div className="-mx-1 flex-1 space-y-2 overflow-y-auto px-1">
          {labels === null ? (
            <p className="flex items-center gap-2 px-1 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : labels.length === 0 ? (
            <p className="px-1 text-sm text-slate-500">No labels yet.</p>
          ) : (
            labels.map((label) => (
              <LabelRow
                key={label.id}
                label={label}
                onRename={(name) => handleUpdate(label.id, { name })}
                onRecolor={(color) => handleUpdate(label.id, { color })}
                onDelete={() => handleDelete(label.id)}
              />
            ))
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function LabelRow({
  label,
  onRename,
  onRecolor,
  onDelete,
}: {
  label: Label;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(label.name);
  const dirty = name.trim() !== "" && name.trim() !== label.name;

  return (
    <div className="space-y-2 rounded-lg border border-slate-800 p-3">
      <div className="flex items-center gap-2">
        <span
          className="h-4 w-4 shrink-0 rounded"
          style={{ backgroundColor: label.color || DEFAULT_LABEL_COLOR }}
        />
        <Input
          className="h-8"
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) onRename(name.trim());
          }}
        />
        {dirty && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Save name"
            onClick={() => onRename(name.trim())}
          >
            <Check className="h-4 w-4 text-emerald-400" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Delete label ${label.name}`}
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4 text-red-400" />
        </Button>
      </div>
      <ColorPicker value={label.color} onChange={onRecolor} />
    </div>
  );
}
