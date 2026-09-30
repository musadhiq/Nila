/**
 * Settings UI primitives — one consistent visual language for every page.
 *
 * Section > Row(title, description, control). Controls: Switch, Segmented,
 * Select, Slider, TextField. All keyboard-accessible with visible focus.
 */
import type { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Section + Row                                                       */
/* ------------------------------------------------------------------ */

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="ssection" aria-label={title}>
      <h2 className="ssection-title">{title}</h2>
      <div className="sgroup">{children}</div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  control,
  onActivate,
  danger,
}: {
  title: string;
  description?: string;
  control?: ReactNode;
  /** Makes the whole row a button (e.g. reminder rows open the editor). */
  onActivate?: () => void;
  danger?: boolean;
}) {
  const body = (
    <>
      <span className="srow-text">
        <span className={danger ? "srow-title danger" : "srow-title"}>{title}</span>
        {description && <span className="srow-desc">{description}</span>}
      </span>
      {control && (
        <span
          className="srow-control"
          onClick={onActivate ? (e) => e.stopPropagation() : undefined}
        >
          {control}
        </span>
      )}
    </>
  );
  if (onActivate) {
    return (
      <button type="button" className="srow as-button" onClick={onActivate}>
        {body}
      </button>
    );
  }
  return <div className="srow">{body}</div>;
}

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Segmented control                                                   */
/* ------------------------------------------------------------------ */

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="seg-btn"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="select-wrap">
      <span className="sr-only">{label}</span>
      <select
        className="select"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Slider                                                              */
/* ------------------------------------------------------------------ */

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <span className="slider-wrap">
      <span className="slider-value" aria-live="polite">
        {format(value)}
      </span>
      <input
        type="range"
        className="slider"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Text fields (reminder editor)                                       */
/* ------------------------------------------------------------------ */

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  error,
  id,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  error?: string;
  id: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        type="text"
        className={error ? "text-input invalid" : "text-input"}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <span className="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
