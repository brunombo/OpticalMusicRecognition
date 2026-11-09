// The copista networks behind one small interface, for any ONNX Runtime
// flavour with the common API (onnxruntime-web in the browser,
// onnxruntime-node in tests and scripts). Tensors cross it as plain
// { data, dims } objects; ONNX tensors produced by one graph are passed to
// the next as they are (no copy).

const MODEL_FILES = {
	trunk: (size) => `copista-${size}-trunk.onnx`,
	verifier: (size) => `copista-${size}-verifier.onnx`,
	evidence: () => "copista-evidence.onnx",
};

export const META_FILE = "copista-meta.json";

/** File names of the graphs a detector size needs. */
export function modelFiles(size) {
	return {
		trunk: MODEL_FILES.trunk(size),
		verifier: MODEL_FILES.verifier(size),
		evidence: MODEL_FILES.evidence(),
	};
}

const plain = (t) => ({ data: t.data, dims: t.dims, tensor: t });

/**
 * Wrap three InferenceSessions. `ort` is the runtime module (for Tensor).
 * Returns { trunk, verifier, evidence } async functions.
 */
export function createModels(ort, sessions, meta) {
	const tensor = (t, type) => t.tensor ?? new ort.Tensor(type, t.data, t.dims);
	const types = meta.evidence.inputs;
	return {
		async trunk(image) {
			const o = await sessions.trunk.run({ image: tensor(image, "float32") });
			return { f: plain(o.f), obj: plain(o.obj), reg: plain(o.reg) };
		},
		async verifier({ f, reg, cy, cx }) {
			const o = await sessions.verifier.run({
				f: tensor(f, "float32"),
				reg: tensor(reg, "float32"),
				cy: tensor(cy, "int64"),
				cx: tensor(cx, "int64"),
			});
			return {
				cls: plain(o.cls),
				refine: plain(o.refine),
				attr: plain(o.attr),
				r: plain(o.r),
			};
		},
		/** feeds: name → { data, dims } typed like meta.evidence.inputs. */
		async evidence(feeds) {
			const input = {};
			for (const [name, type] of Object.entries(types)) {
				input[name] = tensor(feeds[name], type);
			}
			const o = await sessions.evidence.run(input);
			const out = {};
			for (const name of meta.evidence.outputs) {
				out[name] = plain(o[name]);
			}
			return out;
		},
	};
}
