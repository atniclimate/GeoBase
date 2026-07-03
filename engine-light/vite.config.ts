import { defineConfig } from "vite";

// Base path is set for GitHub Pages project-site hosting (/GeoBase/).
// Override with GEOBASE_BASE=/ for local root serving.
const base = process.env.GEOBASE_BASE ?? "/GeoBase/";

export default defineConfig({
  base,
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
