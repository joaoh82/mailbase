import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill } from "remotion";
import { IntroScene } from "./scenes/IntroScene";
import { ReceiveScene } from "./scenes/ReceiveScene";
import { ReadScene } from "./scenes/ReadScene";
import { AddDomainScene } from "./scenes/AddDomainScene";
import { OutroScene } from "./scenes/OutroScene";
import { SCENE, TRANSITION } from "./timing";

// Branded backdrop shared by every scene (scenes render transparently on top of
// it, so the slate gradient + sky glow persist through the cross-fades).
function Background() {
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(120% 90% at 50% 0%, #0b1220 0%, #020617 55%, #020617 100%)",
      }}
    >
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(50% 38% at 50% 8%, rgba(56,189,248,0.16) 0%, rgba(56,189,248,0) 70%)",
        }}
      />
    </AbsoluteFill>
  );
}

export function Demo() {
  const t = linearTiming({ durationInFrames: TRANSITION });
  return (
    <AbsoluteFill>
      <Background />
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={SCENE.intro}>
          <IntroScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />

        <TransitionSeries.Sequence durationInFrames={SCENE.receive}>
          <ReceiveScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />

        <TransitionSeries.Sequence durationInFrames={SCENE.read}>
          <ReadScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />

        <TransitionSeries.Sequence durationInFrames={SCENE.addDomain}>
          <AddDomainScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={t} />

        <TransitionSeries.Sequence durationInFrames={SCENE.outro}>
          <OutroScene />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
}
