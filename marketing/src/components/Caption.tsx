// Lower-third caption for each beat ("01 — Receive", subtitle). Designed to be
// legible on mute and at README scale: large, high-contrast, sky accent.
export function Caption({
  index,
  label,
  subtitle,
  visible,
}: {
  index: string;
  label: string;
  subtitle: string;
  // 0..1 — combined enter/exit visibility, drives fade + slide-up.
  visible: number;
}) {
  return (
    <div
      className="absolute flex items-stretch gap-5"
      style={{
        left: 96,
        bottom: 92,
        opacity: visible,
        transform: `translateY(${(1 - visible) * 36}px)`,
        zIndex: 55,
      }}
    >
      <div className="w-1.5 rounded-full bg-sky-500" />
      <div className="flex items-end gap-5">
        <span
          className="text-[64px] font-bold leading-none text-sky-400"
          style={{ textShadow: "0 2px 24px rgba(2,6,23,0.8)" }}
        >
          {index}
        </span>
        <div className="pb-1">
          <div
            className="text-[46px] font-semibold leading-tight text-white"
            style={{ textShadow: "0 2px 24px rgba(2,6,23,0.9)" }}
          >
            {label}
          </div>
          <div
            className="text-[23px] text-slate-300"
            style={{ textShadow: "0 2px 18px rgba(2,6,23,0.9)" }}
          >
            {subtitle}
          </div>
        </div>
      </div>
    </div>
  );
}
