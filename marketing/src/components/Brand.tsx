// The mailbase brand mark, ported verbatim from images/logo.svg so the video's
// logo stays pixel-identical to the README/favicon: a rounded slate-900 square
// with a sky envelope (body rect + flap path).
export function LogoMark({ size = 64 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="mailbase logo"
    >
      <rect width="64" height="64" rx="14" fill="#0f172a" />
      <rect
        x="12"
        y="18"
        width="40"
        height="28"
        rx="6.4"
        fill="#38bdf8"
        opacity="0.16"
      />
      <rect
        x="12"
        y="18"
        width="40"
        height="28"
        rx="6.4"
        stroke="#38bdf8"
        strokeWidth="3.4"
      />
      <path
        d="M15.2 24 L29.8 33.2 a4 4 0 0 0 4.4 0 L48.8 24"
        stroke="#38bdf8"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Small inline envelope mark themed via currentColor — matches ui/Logo.tsx. */
export function LogoGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="2"
        y="4"
        width="20"
        height="16"
        rx="3.2"
        fill="currentColor"
        opacity="0.16"
      />
      <rect
        x="2"
        y="4"
        width="20"
        height="16"
        rx="3.2"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M3 7.6 L11.03 12.7 a1.8 1.8 0 0 0 1.94 0 L21 7.6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
