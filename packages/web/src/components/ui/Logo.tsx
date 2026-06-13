import { cn } from "../../lib/utils";

/**
 * The mailbase brand mark: a minimal envelope drawn as an inline SVG so it stays
 * crisp at any size and is themed via `currentColor` — a single hue with a faint
 * fill for depth, so it reads in monochrome and sits cleanly in the slate + sky
 * palette. Defaults to sky to match the accent; pass `className` to resize
 * (`h-5 w-5`) or recolor. The same shape ships as the favicon
 * (`public/favicon.svg`); keep the two in sync if the mark changes.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-5 w-5 text-sky-500", className)}
    >
      <rect x="2" y="4" width="20" height="16" rx="3.2" fill="currentColor" opacity="0.16" />
      <rect x="2" y="4" width="20" height="16" rx="3.2" stroke="currentColor" strokeWidth="1.7" />
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
