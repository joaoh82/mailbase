// A fake pointer that glides between UI targets and pulses on "click". Positions
// are the cursor tip in composition pixels. `click` (0..1) drives a ripple ring.
export function Cursor({
  x,
  y,
  click = 0,
}: {
  x: number;
  y: number;
  click?: number;
}) {
  return (
    <div
      className="absolute"
      style={{ left: x, top: y, zIndex: 60, pointerEvents: "none" }}
    >
      {click > 0 && (
        <div
          className="absolute rounded-full border-2 border-sky-400"
          style={{
            left: -10,
            top: -10,
            width: 20 + click * 46,
            height: 20 + click * 46,
            transform: "translate(-50%, -50%)",
            opacity: (1 - click) * 0.8,
          }}
        />
      )}
      <svg
        width="36"
        height="44"
        viewBox="0 0 36 44"
        fill="none"
        style={{
          filter: "drop-shadow(0 4px 6px rgba(2,6,23,0.55))",
          transform: `scale(${1 - click * 0.12})`,
          transformOrigin: "top left",
        }}
      >
        <path
          d="M5 3 L5 32 L12.5 25 L17.5 36.5 L22 34.5 L17 23.5 L27 23.5 Z"
          fill="#f8fafc"
          stroke="#0f172a"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
