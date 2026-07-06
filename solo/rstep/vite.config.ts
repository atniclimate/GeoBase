import { defineConfig } from "vite";

// RStep serves locally (dev + the RStep gate's vite preview); no Pages
// hosting, so the base is root.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
