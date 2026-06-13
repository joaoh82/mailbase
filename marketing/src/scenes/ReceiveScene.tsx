import { Mail } from "lucide-react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { AppShell } from "../components/AppShell";
import { Caption } from "../components/Caption";
import { Window } from "../components/Window";
import { APP_URL, INBOX, NEW_MAIL } from "../data";
import { SCENE } from "../timing";
import { captionVisibility, pulse } from "./anim";

const POP_AT = 112;

export function ReceiveScene() {
  const frame = useCurrentFrame();
  const total = SCENE.receive;

  // New mail slides into the top of the list.
  const incoming = interpolate(frame, [54, 120], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const unread = frame < POP_AT ? 2 : 3;
  const badgePop = pulse(frame, POP_AT, 11);

  // Gentle camera push toward the message list.
  const camScale = interpolate(frame, [0, total], [1.0, 1.06], {
    extrapolateRight: "clamp",
  });
  const camX = interpolate(frame, [0, total], [0, -34], {
    extrapolateRight: "clamp",
  });

  // "New message" toast, lower-right of the list pane.
  const toast = Math.min(
    interpolate(frame, [70, 92], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }),
    interpolate(frame, [270, 300], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          transform: `scale(${camScale}) translateX(${camX}px)`,
          transformOrigin: "50% 46%",
        }}
      >
        <Window url={APP_URL}>
          <AppShell
            unread={unread}
            badgePop={badgePop}
            messages={[NEW_MAIL, ...INBOX]}
            incoming={incoming}
            reading={null}
          />
        </Window>

        <div
          className="absolute flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900 px-5 py-3.5 shadow-2xl"
          style={{
            left: 470,
            top: 858,
            opacity: toast,
            transform: `translateY(${(1 - toast) * 24}px)`,
            boxShadow: "0 20px 50px -10px rgba(2,6,23,0.8)",
          }}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-600">
            <Mail className="h-5 w-5 text-white" />
          </div>
          <div>
            <p className="text-[18px] font-medium text-slate-100">
              New message
            </p>
            <p className="text-[15px] text-slate-400">
              {NEW_MAIL.fromName} · {NEW_MAIL.subject}
            </p>
          </div>
        </div>
      </AbsoluteFill>

      <Caption
        index="01"
        label="Receive"
        subtitle="Mail lands in your inbox — on any domain you own."
        visible={captionVisibility(frame, total)}
      />
    </AbsoluteFill>
  );
}
