import { interpolate } from "remotion";

// Combined fade-in / fade-out visibility for a lower-third caption, given the
// scene-local frame and the scene's total length.
export function captionVisibility(
  frame: number,
  total: number,
  inAt = 8,
  fade = 18,
): number {
  const enter = interpolate(frame, [inAt, inAt + fade], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exit = interpolate(frame, [total - fade, total], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return Math.min(enter, exit);
}

// A short symmetric "pop" pulse centred on `at` (1 at the centre, 0 at the edges).
export function pulse(frame: number, at: number, half = 8): number {
  const d = Math.abs(frame - at);
  return interpolate(d, [0, half], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

// Ease a value through a list of [frame, value] keyframes with smooth in/out.
export function keyframes(
  frame: number,
  points: [number, number][],
): number {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return interpolate(frame, xs, ys, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}
