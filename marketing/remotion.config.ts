import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

// Render config for the README demo. JPEG frames keep MP4/GIF renders fast; the
// Tailwind v4 webpack override lets the mock UI reuse the web app's exact classes.
Config.setVideoImageFormat("jpeg");
Config.overrideWebpackConfig((currentConfiguration) => {
  return enableTailwind(currentConfiguration);
});
