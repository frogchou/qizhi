import type { ReactNode } from "react";

const icons = {
  basket: (
    <>
      <path d="M3.5 9h17l-2 10.5h-13L3.5 9Zm3.8 0L11 4m5.7 5L13 4M9.2 12.5l.7 4m4.9-4-.7 4" />
    </>
  ),
  x: <path d="m6.5 6.5 11 11m0-11-11 11" />,
  upload: (
    <>
      <path d="M12 15V3.8M7.5 8.3 12 3.8l4.5 4.5M4.5 14.2v4.2a1.6 1.6 0 0 0 1.6 1.6h11.8a1.6 1.6 0 0 0 1.6-1.6v-4.2" />
    </>
  ),
  file: (
    <>
      <path d="M14 3.5H6.5a1.5 1.5 0 0 0-1.5 1.5v14a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5Zm-.5.5v5h5M8.5 13h7m-7 3.5h5" />
    </>
  ),
  chevron: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4.5 6.5h15M9 6.5v-2h6v2m-9 0 1 13h10l1-13M10 10v6m4-6v6" />
    </>
  ),
  folder: (
    <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z" />
  ),
  paperclip: (
    <path d="m8.7 13.5 6.5-6.6a2.3 2.3 0 0 1 3.3 3.3l-8 8a4.2 4.2 0 0 1-6-6l8.3-8.3a2.8 2.8 0 0 1 4 0" />
  ),
  check: <path d="m4.5 12 5 5 10-10" />,
  layers: (
    <>
      <path d="m3 8 9-5 9 5-9 5-9-5Zm0 4 9 5 9-5m-18 4 9 5 9-5" />
    </>
  ),
  factory: (
    <>
      <path d="M3.5 19.5v-9l6 2.3V8.4l5.7 2.6.7-7h3l1.6 15.5H3.5ZM7 16h1.5m3 0H13m3 0h1.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5m0-8v.15" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5.8" />
      <path d="m15 15 4.3 4.3" />
    </>
  ),
  connection: (
    <>
      <path d="m9.2 14.8 5.6-5.6m-3.1-1.4 2.4-2.4a3.5 3.5 0 0 1 5 5l-2.4 2.4m-4.5 3.4-2.4 2.4a3.5 3.5 0 0 1-5-5l2.4-2.4" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h6m4 0h6M4 17h10m4 0h2" />
      <circle cx="12" cy="7" r="2" />
      <circle cx="16" cy="17" r="2" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="m7 9 3 3-3 3m5 0h4" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type ControlIconName = keyof typeof icons;

/** Decorative glyph; the surrounding control supplies the accessible name. */
export function ControlIcon({
  name,
  size = 16,
  className,
}: {
  name: ControlIconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? "ui-glyph " + className : "ui-glyph"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icons[name]}
    </svg>
  );
}
