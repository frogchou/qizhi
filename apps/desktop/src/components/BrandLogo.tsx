export function BrandLogo({ className = "" }: { className?: string }) {
  const classes = ["brand-logo", className].filter(Boolean).join(" ");

  return (
    <svg
      className={classes}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="brand-logo-leaf"
        d="M27.4 4.4C17.8 4.3 10.5 7 6.6 12.4 3.3 17 4.1 22.2 8.2 25.3c4.8-2.8 8.6-7.1 11.2-12.6-1.6 5.8-4.9 10.7-9.5 14.5 4.7 1.1 9.7-.9 12.5-5.4 3.2-5 4.4-11 5-17.4Z"
      />
      <path
        className="brand-logo-vein"
        d="M8.7 26.7c2.8-6.5 7.2-11.5 13.1-15.1"
      />
    </svg>
  );
}
