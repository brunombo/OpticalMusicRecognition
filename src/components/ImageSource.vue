<script setup>
// Add pages: images picked (several at once: in file-name order) or
// photographed with the camera.
import { onBeforeUnmount, ref } from "vue";
import { imageFromSource } from "../pipeline/index.js";
import { useOmrState } from "../useOmr.js";

const omr = useOmrState();

const cameraActive = ref(false);
const videoEl = ref(null);
let cameraStream = null;

const byName = new Intl.Collator(undefined, { numeric: true }).compare;

async function onFileChange(event) {
	const files = [...(event.target.files ?? [])].sort((a, b) =>
		byName(a.name, b.name),
	);
	event.target.value = "";
	if (files.length === 0) {
		return;
	}
	stopCamera();
	const images = [];
	for (const file of files) {
		const bitmap = await createImageBitmap(file);
		images.push({
			image: imageFromSource(bitmap, bitmap.width, bitmap.height),
			url: URL.createObjectURL(file),
		});
		bitmap.close();
	}
	omr.addImages(images);
}

async function startCamera() {
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
	omr.addImages([{ image, url: canvas.toDataURL("image/png") }]);
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
				{{ omr.pages.length ? "Add images" : "Choose images" }}
				<input type="file" accept="image/*" multiple @change="onFileChange" />
			</label>
			<button v-if="!cameraActive" class="secondary" @click="startCamera">
				{{ omr.pages.length ? "Add a photo" : "Use camera" }}
			</button>
			<template v-else>
				<button @click="capturePhoto">Capture</button>
				<button class="secondary" @click="stopCamera">Cancel</button>
			</template>
		</div>
		<p class="hint">
			One image per page, several for a longer piece. Printed music, flat
			page, even lighting, the whole page in frame. Phone photos work.
		</p>
		<video v-if="cameraActive" ref="videoEl" autoplay playsinline></video>
	</div>
</template>
