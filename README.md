# MusicOCR

Fully client-side Optical Music Recognition (OMR) web app: photograph or upload
printed sheet music, get MusicXML and MIDI — everything runs in the browser,
no image ever leaves the device.

See [`LITERATURE_REVIEW.md`](LITERATURE_REVIEW.md) for the research behind the
design and the full implementation plan.

## Architecture

Two swappable recognition engines behind one pipeline interface:

- **Classical CV** — projection-profile staff detection + connected-component
  noteheads. Instant, no download, clean printed scores only. Dev stub/fallback.
- **oemer neural network** — [oemer](https://github.com/BreezeWhite/oemer)'s two
  UNet segmentation models (MIT) running in **ONNX Runtime Web** (WebGPU when
  available, WASM otherwise), followed by rule-based reconstruction in JS.

Rendering and export via **Verovio** (WASM): MusicXML → SVG preview + MIDI.

```
image → preprocess (resize 3–4.35 Mpx, tiles) → segmentation (ONNX) →
reconstruction (staves, noteheads, pitch) → MusicXML → Verovio (SVG, MIDI)
```

## Development

```bash
npm install
npm run fetch:models   # downloads oemer's ONNX models (~110 MB) into public/models/
npm run dev            # http://localhost:3000
```

The classical engine works without the model download.

```bash
npm test               # vitest unit tests
npm run lint:fix       # biome format + lint
npm run build          # production build in dist/
```

Enable the pre-commit hook (biome + fast tests):

```bash
git config core.hooksPath .githooks
```

## Status / roadmap

Phases (see plan §5.3): ✅ 0 scaffold · ✅ 1 app shell + classical engine ·
✅ 2 oemer ONNX inference · 🚧 3 reconstruction (pitch only, all notes quarter) ·
⬜ 4 durations/accidentals/clefs, correction editor, PWA, quantized models ·
⬜ 5 homr transformer engine for camera photos.

Known limitations: printed Western notation only; all notes currently exported
as quarter notes; single voice per staff; treble/bass clef by position only.

## Licenses

App: MIT. oemer models: MIT. Verovio: LGPL-3.0. ONNX Runtime Web: MIT.
