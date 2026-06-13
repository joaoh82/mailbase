import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { AppShell } from "../components/AppShell";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { DomainsModal } from "../components/DomainsModal";
import { Window } from "../components/Window";
import { APP_URL, INBOX, NEW_DOMAIN, NEW_MAIL } from "../data";
import { SCENE } from "../timing";
import { captionVisibility, keyframes, pulse } from "./anim";

// Choreography beats (scene-local frames).
const CLICK_DOMAINS = 40;
const CLICK_ADD = 122;
const TYPE_START = 158;
const TYPE_END = 248;
const CLICK_CTA = 300;

// On-frame cursor targets (no camera in this scene, so these are composition px).
const TARGET = {
  domains: { x: 120, y: 866 },
  addBtn: { x: 1360, y: 286 },
  field: { x: 560, y: 392 },
  cta: { x: 1360, y: 720 },
};

export function AddDomainScene() {
  const frame = useCurrentFrame();
  const total = SCENE.addDomain;

  const view: "list" | "add" | "success" =
    frame < CLICK_ADD + 4 ? "list" : frame < CLICK_CTA + 6 ? "add" : "success";

  const appear = interpolate(frame, [CLICK_DOMAINS + 4, CLICK_DOMAINS + 32], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Typewriter for the domain field.
  const typedCount = Math.round(
    interpolate(frame, [TYPE_START, TYPE_END], [0, NEW_DOMAIN.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );
  const typed = view === "success" ? NEW_DOMAIN : NEW_DOMAIN.slice(0, typedCount);
  const caretBlink = Math.floor(frame / 11) % 2 === 0 ? 1 : 0.25;

  const highlightDomains = interpolate(frame, [18, 38], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Cursor path across the four targets.
  const cx = keyframes(frame, [
    [0, 780],
    [CLICK_DOMAINS - 4, TARGET.domains.x],
    [CLICK_ADD - 10, TARGET.addBtn.x],
    [TYPE_START - 8, TARGET.field.x],
    [CLICK_CTA - 10, TARGET.cta.x],
  ]);
  const cy = keyframes(frame, [
    [0, 430],
    [CLICK_DOMAINS - 4, TARGET.domains.y],
    [CLICK_ADD - 10, TARGET.addBtn.y],
    [TYPE_START - 8, TARGET.field.y],
    [CLICK_CTA - 10, TARGET.cta.y],
  ]);
  const click = Math.max(
    pulse(frame, CLICK_DOMAINS, 9),
    pulse(frame, CLICK_ADD, 9),
    pulse(frame, CLICK_CTA, 9),
  );
  const cursorOpacity = interpolate(frame, [CLICK_CTA + 18, CLICK_CTA + 44], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <AbsoluteFill>
        <Window url={APP_URL}>
          <AppShell
            unread={2}
            highlightDomains={highlightDomains}
            messages={[NEW_MAIL, ...INBOX]}
            selectedId={NEW_MAIL.id}
            reading={NEW_MAIL}
            readingReveal={1}
          />
          {appear > 0.01 && (
            <DomainsModal
              view={view}
              typed={typed}
              caret={view === "add" ? caretBlink : 0}
              appear={appear}
              ctaPress={pulse(frame, CLICK_CTA, 8)}
            />
          )}
        </Window>

        <div style={{ opacity: cursorOpacity }}>
          <Cursor x={cx} y={cy} click={click} />
        </div>
      </AbsoluteFill>

      <Caption
        index="03"
        label="Add a domain"
        subtitle="Domains are database rows — add one from the UI, no redeploy."
        visible={captionVisibility(frame, total)}
      />
    </AbsoluteFill>
  );
}
