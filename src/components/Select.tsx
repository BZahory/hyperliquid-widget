"use client";

import { useId, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";

export interface Option<T> {
  value: T;
  label: string;
}

interface SelectProps<T> {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  /** Visible text for the closed control; the selected label stays exposed to AT. */
  display?: string;
  /** Icon-only trigger; the selected label stays exposed to AT. */
  icon?: ReactNode;
  align?: "left" | "right";
}

/** WAI-ARIA select-only combobox: focus stays on the button, aria-activedescendant tracks the option. */
export function Select<T extends string | number | null>({
  label,
  value,
  options,
  onChange,
  display,
  icon,
  align = "left",
}: SelectProps<T>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.findIndex((o) => o.value === value);
  // Options can shrink while open; never point past the end.
  const at = Math.min(active, options.length - 1);

  const show = () => {
    setActive(Math.max(selected, 0));
    setOpen(true);
  };
  const choose = (index: number) => {
    if (index >= 0 && index !== selected) onChange(options[index].value);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1;
    switch (e.key) {
      case "ArrowDown":
        if (open) setActive((a) => Math.min(a + 1, last));
        else show();
        break;
      case "ArrowUp":
        if (open) setActive(Math.max(at - 1, 0));
        else show();
        break;
      case "Home":
        setOpen(true);
        setActive(0);
        break;
      case "End":
        setOpen(true);
        setActive(last);
        break;
      case "Enter":
      case " ":
        if (open) choose(at);
        else show();
        break;
      case "Escape":
        setOpen(false);
        break;
      case "Tab":
        if (open) choose(at); // APG select-only combobox: Tab commits, then focus moves on
        return;
      default:
        return;
    }
    e.preventDefault();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <div className="relative" onBlur={onBlur}>
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={open && at >= 0 ? `${id}-${at}` : undefined}
        // WebKit won't focus a clicked button without this, so onBlur would never close.
        tabIndex={0}
        disabled={options.length === 0}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={`flex cursor-pointer items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${
          icon ? "p-1.5 text-muted hover:bg-white/6 hover:text-ink" : "hover:text-white"
        }`}
      >
        {icon ?? <span aria-hidden={display !== undefined || undefined}>{display ?? options[selected]?.label}</span>}
        {(icon || display !== undefined) && <span className="sr-only">{options[selected]?.label}</span>}
        {!icon && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            aria-hidden="true"
            className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
      </button>
      {open && (
        <ul
          role="listbox"
          id={id}
          aria-label={label}
          // Tab commits the active option, so reset it when the pointer leaves.
          onMouseLeave={() => setActive(Math.max(selected, 0))}
          className={`absolute top-full z-10 mt-2 min-w-full overflow-hidden rounded-lg border border-line bg-[#17191c] py-1 text-sm shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {options.map((o, i) => (
            <li
              key={String(o.value)}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === selected}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(i)}
              className={`cursor-pointer whitespace-nowrap px-3 py-1.5 ${i === at ? "bg-white/8" : ""} ${
                i === selected ? "text-accent-text" : i === at ? "text-white" : ""
              }`}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
