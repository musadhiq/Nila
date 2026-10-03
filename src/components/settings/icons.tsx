/**
 * Nila settings icon set — original inline SVGs (stroke, currentColor).
 * Deliberately generic geometric icons; no platform artwork.
 */

interface IconProps {
  className?: string;
}

function base(props: IconProps, children: React.ReactNode) {
  return (
    <svg
      className={props.className}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconGeneral = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8" />
    </>,
  );

export const IconReminders = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M6 9.5a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14.5 6 9.5" />
      <path d="M10 20a2.2 2.2 0 0 0 4 0" />
    </>,
  );

export const IconCharacter = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5" />
    </>,
  );

export const IconAppearance = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" opacity={0.85} />
    </>,
  );

export const IconWelcome = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M4 21V5a1 1 0 0 1 1-1h9v16" />
      <path d="M4 21h11" />
      <path d="M13 12h7m-2.2-2.2 2.2 2.2-2.2 2.2" />
    </>,
  );

export const IconAccessibility = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="7.6" r="1.4" fill="currentColor" stroke="none" />
      <path d="M7.5 10.5h9M12 10.8v4.2m0 0-2.6 4.2m2.6-4.2 2.6 4.2" />
    </>,
  );

export const IconAbout = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
    </>,
  );

/** Spark / command glyph for the AI / Jev settings page. */
export const IconJev = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3z" />
      <path d="M18.5 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z" />
    </>,
  );

export const IconCommands = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1.2" />
      <circle cx="4" cy="12" r="1.2" />
      <circle cx="4" cy="18" r="1.2" />
    </>,
  );

export const IconPlus = (p: IconProps) =>
  base(p, <path d="M12 5v14M5 12h14" />);

export const IconClose = (p: IconProps) =>
  base(p, <path d="M6 6l12 12M18 6L6 18" />);

export const IconMinus = (p: IconProps) =>
  base(p, <path d="M5 12h14" />);

export const IconTrash = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>,
  );

export const IconChevronRight = (p: IconProps) =>
  base(p, <path d="M9 5l7 7-7 7" />);

export const IconCheck = (p: IconProps) =>
  base(p, <path d="M4.5 12.5l5 5 10-11" />);
