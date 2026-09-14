import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function SettingsToolbar({
  canBack,
  canForward,
  onBack,
  onForward,
  trailing,
}: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="settings-toolbar" data-tauri-drag-region>
      <div className="settings-toolbar-nav" role="group" aria-label="Section history">
        <button
          type="button"
          className="settings-toolbar-btn"
          disabled={!canBack}
          aria-label="Back"
          onClick={onBack}
        >
          <ChevronLeft size={15} strokeWidth={2.25} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="settings-toolbar-btn"
          disabled={!canForward}
          aria-label="Forward"
          onClick={onForward}
        >
          <ChevronRight size={15} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
      {trailing ? <div className="settings-toolbar-trailing">{trailing}</div> : null}
    </div>
  );
}

export function SettingsGroup({
  label,
  children,
  "aria-label": ariaLabel,
}: {
  label?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <>
      {label ? <p className="settings-section-label">{label}</p> : null}
      <section className="settings-group" aria-label={ariaLabel ?? label}>
        {children}
      </section>
    </>
  );
}

export function SettingsRow({
  title,
  subtitle,
  children,
  onClick,
  chevron = false,
  disabled = false,
  htmlFor,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  disabled?: boolean;
  htmlFor?: string;
}) {
  const body = (
    <>
      <span className="settings-row-copy">
        <strong>{title}</strong>
        {subtitle ? <em>{subtitle}</em> : null}
      </span>
      {children}
      {chevron ? <span className="settings-chevron" aria-hidden="true" /> : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className="settings-row settings-row-button"
        disabled={disabled}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }

  if (htmlFor) {
    return (
      <label className="settings-row" htmlFor={htmlFor}>
        {body}
      </label>
    );
  }

  return <div className="settings-row">{body}</div>;
}

export function SettingsSegmented({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label?: string;
  hint?: string;
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (id: string) => void;
}) {
  return (
    <div className={label ? "settings-row settings-row-stack" : "settings-row"}>
      {label ? (
        <span className="settings-row-copy">
          <strong>{label}</strong>
          {hint ? <em>{hint}</em> : null}
        </span>
      ) : null}
      <div className="settings-presets full" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={value === option.id ? "selected" : undefined}
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsSwitch({
  checked,
  disabled,
  onChange,
  labelledBy,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  labelledBy?: string;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      aria-labelledby={labelledBy}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
