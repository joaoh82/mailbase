import { Composition } from "remotion";
import { Demo } from "./Demo";
import { FPS, HEIGHT, TOTAL_FRAMES, WIDTH } from "./timing";

export function RemotionRoot() {
  return (
    <Composition
      id="Demo"
      component={Demo}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
}
