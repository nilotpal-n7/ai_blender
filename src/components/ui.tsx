"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function IconButton({
  label,
  active,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cx(
        "grid size-7 shrink-0 place-items-center rounded-md transition-colors",
        "disabled:pointer-events-none disabled:opacity-35",
        active ? "bg-accent text-white" : "text-dim hover:bg-hover hover:text-text",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** A button that opens a small dropdown; closes on outside click, Escape, or choosing an item. */
export function Menu({
  trigger,
  align = "left",
  children,
}: {
  trigger: ReactNode;
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Captured, so Escape closes the menu without also reaching the editor's shortcuts.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors",
          open ? "bg-hover text-text" : "text-dim hover:bg-hover hover:text-text",
        )}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={cx(
            "absolute top-full z-30 mt-1 min-w-48 rounded-lg border border-line bg-raised p-1 shadow-xl shadow-black/40",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onSelect,
  hint,
  danger,
  children,
}: {
  onSelect: () => void;
  hint?: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cx(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover",
        danger ? "text-err" : "text-text",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-faint">{hint}</span>}
    </button>
  );
}

const inputClass =
  "h-7 w-full min-w-0 rounded-md border border-line bg-bg px-2 text-[13px] text-text " +
  "outline-none transition-colors focus:border-accent disabled:opacity-50";

/**
 * Numeric input that commits every valid keystroke. While focused it shows
 * what was typed, so "-" or "1." aren't rewritten mid-edit.
 */
export function NumberField({
  value,
  onChange,
  step = 0.1,
  min,
  max,
  label,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  label: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 1000) / 1000);
  return (
    <input
      type="number"
      aria-label={label}
      title={label}
      className={cx(inputClass, "!px-1.5 font-mono !text-xs tabular-nums")}
      value={shown}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => {
        setDraft(e.target.value);
        const next = e.target.valueAsNumber;
        if (!Number.isFinite(next)) return;
        const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
        if (clamped !== value) onChange(clamped);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

export function TextField({
  value,
  onCommit,
  label,
  className,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      aria-label={label}
      className={cx(inputClass, className)}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() && draft !== value) onCommit(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function ColorField({
  value,
  onChange,
  label,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        "flex h-7 items-center gap-2 rounded-md border border-line bg-bg px-1.5",
        disabled && "opacity-50",
      )}
    >
      <input
        type="color"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="size-4 shrink-0 cursor-pointer appearance-none rounded border-0 bg-transparent p-0"
      />
      <span className="font-mono text-xs text-dim uppercase">{value}</span>
    </label>
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        aria-label={label}
        className="h-7 min-w-0 flex-1 accent-accent"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
      <span className="w-9 text-right font-mono text-xs text-dim tabular-nums">
        {value.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}
      </span>
    </div>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      className={cx(inputClass, "capitalize")}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

/** A labelled row in a property panel. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[62px_1fr] items-center gap-2">
      <span className="truncate text-xs text-dim">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-b border-line px-3 py-3 last:border-b-0">
      <header className="flex h-5 items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wider text-faint uppercase">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}
