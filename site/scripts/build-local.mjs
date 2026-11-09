import "./check-node.mjs";
import { fileURLToPath } from "node:url";

// Set this before importing Vite: the desktop terminal can inherit development mode.
process.env.NODE_ENV = "production";

const { build } = await import("vite");

// 本地工作台单独出一份产物：不进 dist，就不会跟着公开站点一起发布。
await build({
  mode: "production",
  build: {
    outDir: "dist-local",
    emptyOutDir: true,
    assetsDir: "local-assets",
    rollupOptions: {
      input: {
        local: fileURLToPath(new URL("../local.html", import.meta.url)),
      },
    },
  },
});
