"use client";

import { useId, useState, type KeyboardEvent, type FocusEvent } from "react";

export interface Option<T> {
  value: T;
  label: string;
}

interface SelectProps<T> {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  /** Visible text for the closed control instead of the selected label (which stays available to AT). */
  display?: string;
  /** Which way the list opens. */
  direction?: "down" | "up";
  className?: string;
}

/**
 * Select-only combobox (WAI-ARIA pattern): focus stays on the button, the active option is
 * announced via aria-activedescendant, arrows/Home/End move, Enter/Space pick, Escape closes,
 * and focus leaving the control closes it. No effects needed.
 */
export function Select<T extends string | number | null>({
  label,
  value,
  options,
  onChange,
  display,
  direction = "down",
  className = "",
}: SelectProps<T>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.findIndex((o) => o.value === value);

  const show = () => {
    setActive(Math.max(selected, 0));
    setOpen(true);
  };
  const choose = (index: number) => {
    onChange(options[index].value);
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
        if (open) setActive((a) => Math.max(a - 1, 0));
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
        if (open) choose(active);
        else show();
        break;
      case "Escape":
        setOpen(false);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <div className={`relative ${className}`} onBlur={onBlur}>
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className="flex cursor-pointer items-center gap-1.5 rounded-md outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <span>{display ?? options[selected]?.label}</span>
        {display !== undefined && <span className="sr-only">{options[selected]?.label}</span>}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          className={`shrink-0 text-muted transition-transform ${(direction === "up") !== open ? "rotate-180" : ""}`}
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          id={id}
          aria-label={label}
          className={`absolute left-0 z-10 min-w-full overflow-hidden rounded-lg border border-line bg-[#17191c] py-1 text-sm shadow-xl ${
            direction === "up" ? "bottom-full mb-2" : "top-full mt-2"
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
              className={`cursor-pointer whitespace-nowrap px-3 py-1.5 ${i === active ? "bg-white/8" : ""} ${
                i === selected ? "text-accent" : i === active ? "text-white" : ""
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
