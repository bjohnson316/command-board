import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" makes the build use relative asset paths, so it works
// whether it's served at the repo root or under /<repo-name>/ on
// GitHub Pages — no need to hardcode the repo name here.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
