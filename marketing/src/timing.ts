// Timeline constants for the demo. All scene lengths are in frames at FPS.
// The composition length is derived so it always matches the TransitionSeries
// (sum of scene durations minus the overlapping transitions).

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const SCENE = {
  intro: 78, // ~2.6s
  receive: 348, // ~11.6s
  read: 372, // ~12.4s
  addDomain: 450, // ~15.0s
  outro: 165, // ~5.5s
} as const;

export const TRANSITION = 14; // cross-fade length between scenes
const SCENE_COUNT = Object.keys(SCENE).length;

export const TOTAL_FRAMES =
  Object.values(SCENE).reduce((a, b) => a + b, 0) -
  (SCENE_COUNT - 1) * TRANSITION; // 1413 - 56 = 1357 frames (~45.2s)
