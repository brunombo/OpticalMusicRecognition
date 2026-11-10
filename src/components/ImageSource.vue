<script setup>
// Choose a photo or take one with the camera.
import { onBeforeUnmount, ref } from "vue";
import { imageFromSource } from "../pipeline/index.js";
import { useOmrState } from "../useOmr.js";

const omr = useOmrState();

const cameraActive = ref(false);
const videoEl = ref(null);
let cameraStream = null;

async function onFileChange(event) {
	const file = event.target.files?.[0];
	if (!file) {
		return;
	}
	stopCamera();
	event.target.value = "";
	const bitmap = await createImageBitmap(file);
	omr.setSource(
		imageFromSource(bitmap, bitmap.width, bitmap.height),
		URL.createObjectURL(file),
	);
}

async function startCamera() {
	omr.resetResult();
	try {
		cameraStream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: "environment" },
		});
		cameraActive.value = true;
		// Wait a tick for the <video> element to exist
		requestAnimationFrame(() => {
			if (videoEl.value) {
				videoEl.value.srcObject = cameraStream;
			}
		});
	} catch (e) {
		omr.error = `Camera unavailable: ${e.message}`;
	}
}

function capturePhoto() {
	const video = videoEl.value;
	if (!video || video.videoWidth === 0) {
		return;
	}
	const image = imageFromSource(video, video.videoWidth, video.videoHeight);
	const canvas = document.createElement("canvas");
	canvas.width = image.width;
	canvas.height = image.height;
	canvas
		.getContext("2d")
		.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
	stopCamera();
	omr.setSource(image, canvas.toDataURL("image/png"));
}

function stopCamera() {
	if (cameraStream) {
		for (const track of cameraStream.getTracks()) {
			track.stop();
		}
		cameraStream = null;
	}
	cameraActive.value = false;
}

onBeforeUnmount(stopCamera);
</script>

<template>
	<div class="image-source">
		<div class="row">
			<label class="file-label">
				{{ omr.sourceImage ? "Choose another image" : "Choose image" }}
				<input type="file" accept="image/*" @change="onFileChange" />
			</label>
			<button v-if="!cameraActive" class="secondary" @click="startCamera">
				Use camera
			</button>
			<template v-else>
				<button @click="capturePhoto">Capture</button>
				<button class="secondary" @click="stopCamera">Cancel</button>
			</template>
		</div>
		<p class="hint">
			Printed music, flat page, even lighting, the whole page in frame. Phone
			photos work.
		</p>
		<video v-if="cameraActive" ref="videoEl" autoplay playsinline></video>
	</div>
</template>
