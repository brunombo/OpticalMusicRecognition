import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [vue()],
	// COOP/COEP headers enable SharedArrayBuffer → multithreaded ONNX WASM
	server: {
		port: 3000,
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
	preview: {
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
	// onnxruntime-web ships worker code that must not be pre-bundled
	optimizeDeps: {
		exclude: ["onnxruntime-web"],
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.js"],
	},
});
