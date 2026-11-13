/**
 * Network Flow mark: two nodes joined by a flowing link with a packet in transit. Mirrors
 * `public/favicon.svg`; keep the two in sync.
 */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient
          id="nf-logo-flow"
          x1="7"
          y1="23"
          x2="25"
          y2="9"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#c8f169" />
          <stop offset="1" stopColor="#5fd4e8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="#141925" />
      <rect
        x=".75"
        y=".75"
        width="30.5"
        height="30.5"
        rx="7.25"
        fill="none"
        stroke="#323a4e"
        strokeWidth="1.5"
      />
      <path
        d="M8 23C8 11 24 21 24 9"
        fill="none"
        stroke="url(#nf-logo-flow)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <circle cx="8" cy="23" r="3.6" fill="#c8f169" />
      <circle cx="24" cy="9" r="3.6" fill="#5fd4e8" />
      <circle cx="16" cy="16" r="4.6" fill="#fff" opacity=".22" />
      <circle cx="16" cy="16" r="2.4" fill="#fff" />
    </svg>
  );
}
