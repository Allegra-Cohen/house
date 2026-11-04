import { defineConfig } from "vite";

// base: "./" makes built asset paths relative, so Electron can load dist/index.html
// over file:// (and a future GitHub Pages embed works under a subpath too).
export default defineConfig({
  base: "./",
});
