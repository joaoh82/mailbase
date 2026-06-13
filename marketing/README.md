# marketing — the README demo video

The short demo at the top of the project [README](../README.md) is built here with
[Remotion](https://www.remotion.dev/) (React-rendered, programmatic video). It walks the
core loop in ~45s — **Receive → Read in the three-pane webmail → Add a domain from the UI**
— and ends on the brand mark.

This is a **standalone project**, deliberately *not* an npm workspace: Remotion bundles a
headless Chromium, which we keep out of the root `npm install` and CI. It has its own
`package.json`, `package-lock.json`, and `node_modules`.

## Why mockups, not a screen recording

The scenes are faithful React mockups of the real `packages/web` UI (same slate + sky
palette, `lucide-react` icons, and component structure), not a live capture. That gives
precise pacing, captions, and deterministic headless renders without standing up a seeded
backend — and it avoids the slow, real-time feel the ticket called out.

## Develop

```sh
nvm use            # Node 24 (repo .nvmrc) — required for the toolchain
cd marketing
npm install
npm run studio     # opens Remotion Studio with a live preview + timeline
```

Edit the storyboard in `src/`:

- `src/Demo.tsx` — the top-level timeline (`TransitionSeries` of the five scenes).
- `src/scenes/*` — Intro, Receive, Read, AddDomain, Outro.
- `src/components/*` — the faithful app mocks (`AppShell`, `DomainsModal`, `Window`, …).
- `src/timing.ts` — scene lengths / fps / dimensions (composition length is derived).
- `src/data.ts` — the mock inbox + domains content.

## Render the README artifacts

Renders straight into `../images/` (the committed README assets):

```sh
npm run render        # MP4 + WebM + GIF + poster (everything below, in order)

npm run render:mp4    # images/mailbase-demo.mp4    (1920x1080 h264, crf 23 — primary)
npm run render:webm   # images/mailbase-demo.webm   (vp9, crf 34 — small autoplay fallback)
npm run render:gif    # images/mailbase-demo.gif     (760px, 10fps, palette-optimized loop)
npm run render:poster # images/mailbase-demo-poster.png (still for the <video> poster)
```

From the repo root, `make demo` runs the full render.

The GIF is the autoplaying README hero, so it has to stay light enough for GitHub's image
proxy (~10 MB). Plain `remotion --codec=gif` of a 45s motion clip lands ~15 MB, so
`render:gif` instead derives a palette-optimized GIF **from the rendered MP4 with `ffmpeg`**
(`fps=10`, `scale=760`, 80-colour diff palette → ~6.5 MB). Two consequences:

- It requires **`ffmpeg` on your `PATH`** (the only step that does; `brew install ffmpeg`).
- It must run **after** `render:mp4` — `npm run render` already orders them correctly.

If you grow the storyboard and the GIF gets too heavy, drop `fps`, `scale`, or the palette
`max_colors` in the `render:gif` script.

## Type-check

```sh
npm run typecheck
```
