import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { LogoMark } from "../components/Brand";

export function IntroScene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const markIn = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 30 });
  const markScale = interpolate(markIn, [0, 1], [0.6, 1]);

  const wordReveal = interpolate(frame, [10, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const tagReveal = interpolate(frame, [26, 46], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill className="items-center justify-center">
      <div className="flex flex-col items-center">
        <div style={{ transform: `scale(${markScale})`, opacity: markIn }}>
          <LogoMark size={150} />
        </div>
        <h1
          className="mt-7 text-[88px] font-semibold tracking-tight text-slate-50"
          style={{
            opacity: wordReveal,
            transform: `translateY(${(1 - wordReveal) * 20}px)`,
          }}
        >
          mailbase
        </h1>
        <p
          className="mt-2 text-[30px] text-slate-400"
          style={{ opacity: tagReveal }}
        >
          Self-hosted email for all your domains.
        </p>
      </div>
    </AbsoluteFill>
  );
}
