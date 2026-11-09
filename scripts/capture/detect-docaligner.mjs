// Page corners with DocAligner in node (onnxruntime-node), through the same
// pre/post-processing as the app (src/pipeline/capture/docaligner.js).
// The ONNX file is passed by path (default: public/models/, from
// `npm run fetch:docaligner`).

import {
	DOCALIGNER_FILE,
	detectCorners,
} from "../../src/pipeline/capture/docaligner.js";

export async function createDocAligner(
	modelPath = `public/models/${DOCALIGNER_FILE}`,
) {
	const ort = await import("onnxruntime-node");
	const session = await ort.InferenceSession.create(modelPath);
	return ({ rgba, width, height }) =>
		detectCorners(ort, session, { data: rgba, width, height });
}
