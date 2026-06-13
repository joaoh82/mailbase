import type { ReactNode } from "react";
import { Lock } from "lucide-react";

// A subtle browser-window chrome around the app, so the mock reads as "a real
// web app in a tab" rather than a flat screenshot. Fills most of the 1920x1080
// frame; the app UI renders into the content area below the title bar.
export function Window({
  children,
  url,
}: {
  children: ReactNode;
  url: string;
}) {
  return (
    <div
      className="absolute overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl"
      style={{
        left: 60,
        top: 54,
        width: 1800,
        height: 972,
        boxShadow: "0 40px 120px -20px rgba(2, 6, 23, 0.9)",
      }}
    >
      <div className="flex h-12 items-center gap-2 border-b border-slate-800 bg-slate-900 px-5">
        <span className="h-3.5 w-3.5 rounded-full bg-red-400/80" />
        <span className="h-3.5 w-3.5 rounded-full bg-amber-400/80" />
        <span className="h-3.5 w-3.5 rounded-full bg-emerald-400/80" />
        <div className="ml-4 flex h-7 max-w-md flex-1 items-center gap-2 rounded-md bg-slate-800/70 px-3 text-[15px] text-slate-400">
          <Lock className="h-3.5 w-3.5 text-emerald-400/80" />
          {url}
        </div>
      </div>
      <div className="relative h-[924px] w-full">{children}</div>
    </div>
  );
}
