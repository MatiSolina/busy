import browser from "@agent-browser/eve";

// The image's `browser` wrapper boots the existing desktop Chrome and injects its CDP endpoint.
// Keep the extension stock: its generated tools stay aligned with agent-browser 0.41.1.
export default browser({
  autoInstall: false,
  binary: "browser",
  installBrowser: false,
  installSpec: "agent-browser@0.41.1",
  installSystemDependencies: false,
  session: "busy-live",
});
