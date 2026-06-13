import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { AppShell } from "../components/AppShell";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { Window } from "../components/Window";
import { APP_URL, INBOX, NEW_MAIL } from "../data";
import { SCENE } from "../timing";
import { captionVisibility, keyframes, pulse } from "./anim";

const CLICK_AT = 40;

export function ReadScene() {
  const frame = useCurrentFrame();
  const total = SCENE.read;

  const opened = frame >= CLICK_AT;

  // Reading pane content reveal once the row is clicked.
  const readingReveal = interpolate(frame, [CLICK_AT + 6, CLICK_AT + 52], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Camera pans + zooms into the reading pane (origin top-left so the math is
  // a simple affine map of pre-transform app coords).
  const z = interpolate(frame, [58, 150], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const s = 1 + 0.17 * z;
  const dx = z * -700;
  const dy = z * -46;

  // Cursor: glide to the new row, click, then fade as the camera moves in.
  const cx = keyframes(frame, [
    [0, 760],
    [36, 560],
  ]);
  const cy = keyframes(frame, [
    [0, 470],
    [36, 262],
  ]);
  const cursorOpacity = interpolate(frame, [96, 128], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          transform: `translate(${dx}px, ${dy}px) scale(${s})`,
          transformOrigin: "0 0",
        }}
      >
        <Window url={APP_URL}>
          <AppShell
            unread={opened ? 2 : 3}
            messages={[NEW_MAIL, ...INBOX]}
            selectedId={opened ? NEW_MAIL.id : null}
            reading={opened ? NEW_MAIL : null}
            readingReveal={readingReveal}
          />
        </Window>

        <div style={{ opacity: cursorOpacity }}>
          <Cursor x={cx} y={cy} click={pulse(frame, CLICK_AT, 9)} />
        </div>
      </AbsoluteFill>

      <Caption
        index="02"
        label="Read"
        subtitle="Open it in the three-pane webmail — HTML sandboxed, images blocked."
        visible={captionVisibility(frame, total)}
      />
    </AbsoluteFill>
  );
}
