// Copies onnxruntime-web's WASM binaries into public/ort/ so the app is fully
// self-hosted (no CDN fetch at runtime).
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const dest = join(root, "public", "ort");

mkdirSync(dest, { recursive: true });
let count = 0;
for (const file of readdirSync(src)) {
	if (file.endsWith(".wasm") || file.endsWith(".mjs")) {
		copyFileSync(join(src, file), join(dest, file));
		count++;
	}
}
console.log(`Copied ${count} ONNX Runtime assets to public/ort/`);
