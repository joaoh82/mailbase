import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { LogoMark } from "../components/Brand";

export function OutroScene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const markIn = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 28 });
  const reveal = interpolate(frame, [12, 34], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const repoReveal = interpolate(frame, [30, 52], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill className="items-center justify-center">
      <div className="flex flex-col items-center">
        <div style={{ transform: `scale(${markIn})`, opacity: markIn }}>
          <LogoMark size={132} />
        </div>
        <h1
          className="mt-6 text-[76px] font-semibold tracking-tight text-slate-50"
          style={{
            opacity: reveal,
            transform: `translateY(${(1 - reveal) * 16}px)`,
          }}
        >
          mailbase
        </h1>
        <p className="mt-1 text-[27px] text-slate-400" style={{ opacity: reveal }}>
          Multi-domain webmail on Cloudflare — yours to run for $0–5/mo.
        </p>
        <div
          className="mt-7 rounded-full border border-slate-700 bg-slate-900/70 px-6 py-2.5 text-[22px] text-sky-300"
          style={{ opacity: repoReveal }}
        >
          github.com/joaoh82/mailbase
        </div>
      </div>
    </AbsoluteFill>
  );
}
