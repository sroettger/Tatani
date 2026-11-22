import { defineConfig, type Plugin, type ResolvedConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "node:fs";
import path from "node:path";

function spa404FallbackPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig | null = null;
  return {
    name: "tatani-spa-404-fallback",
    apply: "build",
    configResolved(config) {
      resolvedConfig = config;
    },
    closeBundle() {
      if (!resolvedConfig) return;
      const base = resolvedConfig.base || "/";
      const pathSegmentsToKeep = base.split("/").filter(Boolean).length;
      const outDir = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      if (!fs.existsSync(outDir)) return;
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Tatani</title>
    <script>
      // Single Page App static host fallback (preserves deep links & OAuth/recovery fragments; >512 bytes for browser compatibility)
      var pathSegmentsToKeep = ${pathSegmentsToKeep};
      var l = window.location;
      l.replace(
        l.protocol + "//" + l.hostname + (l.port ? ":" + l.port : "") +
        l.pathname.split("/").slice(0, 1 + pathSegmentsToKeep).join("/") + "/?/" +
        l.pathname.slice(1).split("/").slice(pathSegmentsToKeep).join("/").replace(/&/g, "~and~") +
        (l.search ? "&" + l.search.slice(1).replace(/&/g, "~and~") : "") +
        l.hash
      );
    </script>
  </head>
  <body></body>
</html>
`;
      fs.writeFileSync(path.join(outDir, "404.html"), html, "utf8");
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(() => ({
  base: process.env.VITE_BASE_PATH || "/",
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), spa404FallbackPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
