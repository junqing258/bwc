import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { CodeInspectorPlugin } from "code-inspector-plugin";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    // 按住 Shift + Option(Mac)/ Shift + Alt(Windows)点击页面元素,自动在编辑器中定位源码
    CodeInspectorPlugin({ bundler: "vite" }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 4301,
    proxy: { "/api": "http://127.0.0.1:4310" },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Vite 8 (rolldown) 移除了 manualChunks 对象形式，改用 advancedChunks
        advancedChunks: {
          groups: [
            { name: "three", test: /node_modules[\\/]three[\\/]/ },
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
