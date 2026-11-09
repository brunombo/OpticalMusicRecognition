# Optical Music Recognition — Literature Review & Implementation Plan

*Compiled 2026-07-16, updated 2026-11-09. Sources were fetched and claim-checked against primary sources (arXiv papers, GitHub repositories, official docs); a few items noted below are unverified.*

> **November 2026 update:** see [§6](#6-update--november-2026) for what changed
> since July (copisteria, Transcoda, LEGATO 2, homr 0.7) and a measured
> comparison on this repo's test pages, and [§7](#7-upgrade-plan-november-2026)
> for the plan that supersedes §5: replace the oemer engine with a JS port of
> copisteria (Apache-2.0). Sections 1–5 are kept as written in July.

## 1. Academic state of the art

### 1.1 Classical pipelines (pre-≈2016)

Traditional OMR is a multi-stage pipeline: binarization → staff-line detection/removal →
symbol segmentation → symbol classification → notation reconstruction (semantics: pitch,
rhythm, voices). The canonical survey is Calvo-Zaragoza, Hajič & Pacha, *Understanding
Optical Music Recognition* (ACM Computing Surveys, 2020). The weakness of the classical
approach is error propagation: a mistake in staff removal corrupts every later stage.

**Audiveris** is the surviving production example of this school — a *hybrid* pipeline
(ad-hoc line detection, morphological operations for beams, template matching for note
heads, a small neural net for fixed-size shapes, Tesseract for text). Its own docs state
that 100% recognition is out of reach and ship a manual correction editor — a realistic
expectation to carry into any app design.

### 1.2 End-to-end deep learning

A 2025 survey (Castellanos, Gallego & Fujinaga, *Deep Learning for Optical Music
Recognition: A Review*, TechRxiv preprint, Feb 2025) documents the field-wide shift:
every classical stage, and OMR as a whole, is now done with deep learning.

Key milestones (all claim-checked against the papers):

| Year | System | Architecture | Scope | Reported accuracy |
|------|--------|-------------|-------|-------------------|
| 2018 | **Camera-PrIMuS** (Calvo-Zaragoza & Rizo, ISMIR) | CRNN (4 conv + 2 BLSTM) + CTC | Monophonic, printed, camera-distorted | ~2% symbol error rate (SER) |
| 2023 | **TrOMR** (NetEase, ICASSP) | Transformer image-to-sequence | Polyphonic, real camera photos | Outperforms prior work on real-world photos; basis of homr |
| 2023 | **e2e-pianoform** (Ríos-Vila et al., IJDAR) | CNN encoder + Transformer decoder | Pianoform (grand staff) | SER 5.8% clean / 6.5% distorted (GrandStaff) |
| 2024 | **SMT** (Ríos-Vila et al., ICDAR) | Transformer img2seq, 2D positional encoding, **kern output | Polyphonic without monophonic tricks | CER 3.9% / SER 5.1% (GrandStaff); SER 1.4% (Quartets) |
| 2024 | **SMT++** (arXiv 2405.12105) | Same + curriculum training | **Full page** pianoform, no layout-analysis step | CER 5.6% / SER 6.9% (FP-GrandStaff) |
| 2024 | **"Zeus" / OLiMPiC** (arXiv 2403.13763) | CNN + BLSTM + attention LSTM (deliberately no transformer), Linearized MusicXML output | Pianoform, real scans | SER 2.77% on GrandStaff (≥50% better than transformers); **18.4% TEDn on real scans even with heavy augmentation** |

Two important calibration points:

1. **The synthetic-to-real gap is the dominant problem.** Camera-PrIMuS showed models
   trained on clean images collapse on distorted ones (SER 44–60%); training on distorted
   data fixes both. The OLiMPiC paper showed even a state-of-the-art model goes from
   13.7% → 44.4% error when moving from synthetic renders to flatbed scans (18.4% with
   augmentation) — and scans are *easier* than phone photos.
2. **Standardized benchmarks are sobering.** The Sheet Music Benchmark (SMB, arXiv
   2506.10488, 2025; 685 real pages) reports SMT at **SER 31.4% on pianoform and 57.1% on
   monophony** — far worse than the papers' own synthetic-test numbers. Treat all OMR
   output as a draft requiring manual correction.

Also note: SER numbers are **not comparable across output encodings** (kern vs ekern vs
Linearized MusicXML give wildly different SER on the same model). The encoding-independent
metric is TEDn (tree edit distance on MusicXML).

### 1.3 Datasets

| Dataset | Content | Size | Notes |
|---------|---------|------|-------|
| **PrIMuS / Camera-PrIMuS** | Printed monophonic incipits | 87,678 | Clean + camera-distorted renders; MEI + semantic/agnostic encodings |
| **MUSCIMA++** | Handwritten | 140 fully annotated pages (of 1,000) | The handwritten reference; small |
| **DeepScoresV2** | Typeset symbol detection | 255,385 images / 151M symbols / 135 classes | CC-BY 4.0, Zenodo; object detection oriented |
| **DoReMi** | Typeset (Dorico-generated) | 6,432 images / ~1M objects / 94 classes | Ships MusicXML + MEI + MIDI ground truth |
| **GrandStaff** | Pianoform systems | 53,882 | Synthetic renders + distorted variants; kern/bekern |
| **FP-GrandStaff** | Full pages | 688 pages | For SMT++ |
| **OLiMPiC** | Pianoform (OpenScore Lieder) | 15k synthetic train + real IMSLP scan test sets | CC BY-SA; the "hard" realistic benchmark; Linearized MusicXML |
| **SMB** | Mixed textures, real pages | 685 pages | 2025 standardized evaluation benchmark, **kern ground truth |

### 1.4 Known limitations (field-wide)

- Printed ≫ handwritten (most systems fail on handwritten altogether).
- Scans ≫ phone photos (lighting, 3D page curvature).
- Monophonic ≫ polyphonic/pianoform ≫ dense orchestral.
- Dynamics, articulations, lyrics, tuplets are weak spots even in the best systems
  (homr explicitly ignores dynamics/articulation; tuplets account for a measurable
  chunk of residual error in the OLiMPiC work).

## 2. Open-source OMR software status (July 2026)

| Project | License | Runtime | Status (2026) | Browser-portable? |
|---------|---------|---------|---------------|-------------------|
| **Audiveris** | AGPL-3.0 | Java + Tesseract | Very active (v5.11.0, Jul 2026, 2.6k★) | ❌ No realistic path (Java, hybrid pipeline) |
| **oemer** | **MIT** | Python, **ONNX Runtime by default** | Low activity (last release v0.1.8, Nov 2024); README points to homr as successor | ✅ **Yes — models are already ONNX**; proven by QuickStave (commercial in-browser OMR built on oemer's nets) |
| **homr** | AGPL-3.0 | Python 3.11 / PyTorch | Active (release Jun 2026, 323★) | ✅ Proven on-device by **Andromr** (Android: segmentation + transformer-encoder via TFLite, decoder via ONNX Runtime, ~30 s/page on a phone) |
| **Mozart, cadenCV, SheetVision** | various | Python classical CV | Effectively abandoned (unverified — not re-checked this pass) | Only as algorithm references |

Architecture notes:

- **oemer**: two UNet segmentation models (staffline/symbol separation, then symbol
  types) + SVM classifiers + rule-based reconstruction → MusicXML. Printed Western
  notation only; slow in its Python form (minutes/page even with GPU).
- **homr**: reuses oemer's UNet segmentation, replaces recognition with a
  Polyphonic-TrOMR-style transformer per staff → MusicXML. Designed for **camera
  photos**. Scope limited to pitch + rhythm on treble/bass clefs.
- A third-party benchmark repo (notes2tone, Mar 2026) compares exactly Audiveris vs
  homr vs oemer on SMB — these three are the de-facto open-source contenders.
- The GitHub `optical-music-recognition` topic has ~58 repos, ~3 TypeScript / 1 JS —
  **there is essentially no browser-native open-source OMR today**. That's the gap
  this app fills.

## 3. Running OMR in the browser

### 3.1 Inference runtimes

| Runtime | Backend | Notes |
|---------|---------|-------|
| **ONNX Runtime Web** | WASM (CPU) + **WebGPU** EP | The default choice. WebGPU is out-of-the-box in Chrome/Edge (Windows/macOS/Android); Firefox/Safari support still partial → always keep the WASM fallback. Graph-capture optimization needs static shapes. |
| **TensorFlow.js** | WebGL/WebGPU/WASM | Viable but requires model conversion from ONNX/PyTorch; ecosystem momentum is with ORT-web. |
| **transformers.js** | wraps ORT-web | Only worth it if a model is packaged for it; adds convenience for autoregressive decoding + quantized dtypes. |
| **Rust → WASM** (tract, burn, candle) | WASM/WebGPU | Fits the Rust preference; realistic for the *preprocessing* stage (binarization, deskew, dewarping, connected components) and possibly UNet inference, but off the beaten path for transformer decoders. |
| **OpenCV.js / hand-rolled JS** | WASM | For classical CV fallback / preprocessing only. |

### 3.2 Feasibility evidence

- **QuickStave** (commercial, closed) runs OMR fully client-side in the browser —
  built on oemer's MIT models, "seconds per page". Direct existence proof for the goal.
- **Andromr** (AGPL, open) runs the full homr pipeline offline on Android phones at
  ~30 s/page, having converted homr's models to TFLite + ONNX. Direct proof that
  homr's models convert and fit consumer hardware.
- Model sizes (verified from the oemer release): `1st_model.onnx` (staff/symbol UNet)
  **70.8 MB**, `2nd_model.onnx` (symbol-type UNet) **38.4 MB** — ~110 MB total,
  acceptable for an offline-capable PWA with cached models; int8 quantization can
  shrink this substantially later.

### 3.3 oemer model interface (verified from oemer 0.1.8 source)

| Model | Input | Output | Classes (argmax) |
|-------|-------|--------|------------------|
| `unet_big` (1st) | `(N, 256, 256, 3)` RGB | `(N, 256, 256, 3)` | 0 background · 1 staff line · 2 symbol |
| `seg_net` (2nd) | `(N, 288, 288, 3)` RGB | `(N, 288, 288, 4)` | 0 background · 1 stems/rests · 2 notehead · 3 clefs/keys |

Inference protocol: resize page to ~3.0–4.35 Mpixels, slide a window (window = model
input size, step 128 px), batch the tiles, average overlapping predictions, argmax to
a per-pixel class map. Input tensor name `input`; outputs `prediction` / `conv2d_25`.

## 4. Output formats & rendering

Formats:
- **MusicXML** — the interchange standard (MuseScore/Sibelius/Dorico). Primary export.
- **MEI** — scholarly standard; Verovio's native format.
- **\*\*kern** (Humdrum) — compact token vocabulary; what SMT-family models emit.
- **MIDI** — playback only; cannot store layout or enharmonic spelling — never sufficient as the sole output.

Renderers (all open source, all actively maintained in 2026):

| Library | License | Input | Notes |
|---------|---------|-------|-------|
| **Verovio** | LGPL-3.0 | MEI native; **imports MusicXML, \*\*kern, ABC, PAE**; exports MIDI | C++20 → **WASM on npm**, ESM build works with Vite; v6.2.0 (May 2026). Humdrum support adds ~⅓ to bundle size. |
| **OpenSheetMusicDisplay** | BSD-3 | MusicXML / .mxl | TypeScript on top of VexFlow; v2.0.0 (Jun 2026, 1.9k★). Some notation gaps (cross-staff slurs, 2-note tremolo). |
| **VexFlow** | MIT | JS API only (no MusicXML) | Low-level engraving primitives; use via OSMD rather than directly. |

## 5. Implementation plan (decided 2026-07-16)

**Decisions** (options considered in §5.6):
- **Recognition engine: oemer's ONNX models** (Option A) — MIT license, models already
  ONNX, browser feasibility proven by QuickStave. The engine sits behind a swappable
  interface so homr's transformer (Option B) can be added later.
- **Renderer: Verovio WASM** — one LGPL library renders MusicXML, converts formats,
  and exports MIDI; ESM build on npm works with Vite.
- **Stack**: Vue 3 + Vite PWA, JavaScript, biome formatting, vitest tests, pre-commit
  hook running fast tests + format check (per `TOOLS.md`).

### 5.1 Architecture

```mermaid
flowchart LR
    A[Camera / file input] --> B[Preprocess in JS<br/>grayscale, Otsu binarize,<br/>resize to 3-4.35 Mpx + tiling]
    B --> C[Segmentation UNets — oemer ONNX<br/>ONNX Runtime Web<br/>WebGPU + WASM fallback]
    C --> D[Reconstruction in JS<br/>staff geometry, notehead CCs,<br/>pitch + rhythm rules]
    D --> E[MusicXML builder]
    E --> F[Verovio WASM<br/>render SVG · export MIDI]
    E --> G[Download .musicxml]
```

Everything runs offline after first load: model files are served with the app and
cached (Cache API / service worker); no image data ever leaves the device.

### 5.2 Pipeline stages

1. **Input** — file upload or `getUserMedia` camera capture, drawn to an offscreen canvas.
2. **Preprocess** (pure JS, testable): RGB extraction → resize into the 3–4.35 Mpx
   window oemer expects → 256/288 px tiles with 128 px step.
3. **Segmentation** (ONNX Runtime Web): run the two UNets per §3.3, average overlaps,
   argmax, stitch tiles into full-page label maps. WebGPU EP when available, WASM otherwise.
4. **Reconstruction** (pure JS, the real porting work): staff-line geometry from the
   staff map → group lines into staves; connected components on the notehead map →
   notehead positions; pitch from vertical position vs staff geometry + clef;
   duration from stem/beam evidence (start: quarter-note default, refine iteratively);
   assemble measures.
5. **Output**: MusicXML builder → Verovio renders SVG preview + exports MIDI;
   raw `.musicxml` download.
6. **Correction editor** (early, not last): the literature is unanimous that OMR
   output is a draft — click a note to fix pitch/duration before export.

### 5.3 Phases

| Phase | Deliverable |
|-------|-------------|
| **0** | Scaffold: Vite + Vue 3, biome, vitest, git + pre-commit hook |
| **1** | App shell: image input → preprocess → *stub* engine (classical CV) → MusicXML → Verovio render/export. End-to-end plumbing works before any ML. |
| **2** | oemer ONNX models in ORT-web: model fetch + cache, tiled inference, label maps. |
| **3** | Reconstruction port: staves, noteheads, pitch; MusicXML with real content. |
| **4** | Quality/UX: durations, accidentals, clef classification, correction editor, PWA offline manifest, quantized models, WebGPU path. |
| **5** | Second engine: homr's transformer via ONNX (Option B) for camera-photo robustness. |

### 5.4 Risks

- **Reconstruction complexity** — oemer's Python reconstruction is the bulk of its
  smarts; port incrementally (pitch first, rhythm later) rather than all at once.
- **Model size/latency** — 110 MB download, seconds-to-minutes inference on weak
  devices; mitigate with caching, quantization, WebGPU, and progress UI.
- **Scope honesty** — printed Western notation only; photos work worse than scans;
  handwritten is out of scope (field-wide unsolved).

### 5.5 Licenses

oemer models: MIT. Verovio: LGPL-3.0 (used as an unmodified library — fine). ONNX
Runtime Web: MIT. This app: MIT.

### 5.6 Options considered

- **A — oemer ONNX in browser** *(chosen)*: MIT, models already ONNX, proven in-browser
  (QuickStave); printed music only; reconstruction must be reimplemented in JS.
- **B — homr port** *(deferred to Phase 5)*: best open-source accuracy on camera photos,
  polyphonic, active; but AGPL-3.0 and heavier conversion work (autoregressive
  transformer decoding in browser, ~30 s/page on phones per Andromr).
- **C — SMT-family research model**: cleanest architecture, tiny decoder, but 31–57%
  SER on real pages (SMB benchmark) and training infrastructure needed — experiment,
  not product.
- **D — classical CV only**: tiny bundle but low ceiling; survives as the preprocessing
  stage and as a no-download stub engine for development.

## Key sources

- Calvo-Zaragoza, Hajič, Pacha — *Understanding Optical Music Recognition*, ACM Computing Surveys 2020
- Castellanos, Gallego, Fujinaga — *Deep Learning for OMR: A Review*, TechRxiv preprint, Feb 2025
- Calvo-Zaragoza, Rizo — *Camera-PrIMuS*, ISMIR 2018 · https://grfia.dlsi.ua.es/primus/
- TrOMR, ICASSP 2023 · arXiv:2308.09370 · https://github.com/NetEase/Polyphonic-TrOMR
- Ríos-Vila et al. — pianoform e2e, IJDAR 2023 · https://github.com/multiscore/e2e-pianoform
- SMT, ICDAR 2024 · arXiv:2402.07596 — SMT++ · arXiv:2405.12105
- *Practical End-to-End OMR for Pianoform Music* (OLiMPiC / Linearized MusicXML) · arXiv:2403.13763
- Sheet Music Benchmark · arXiv:2506.10488 (2025)
- DoReMi · arXiv:2107.07786 — DeepScoresV2 · ICPR 2020, Zenodo 4012193
- https://github.com/Audiveris/audiveris · https://github.com/BreezeWhite/oemer · https://github.com/liebharc/homr · https://github.com/aicelen/Andromr
- ONNX Runtime Web WebGPU docs · https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- https://github.com/rism-digital/verovio · https://github.com/opensheetmusicdisplay/opensheetmusicdisplay
- QuickStave (existence proof, closed source) · https://www.quickstave.com/optical-music-recognition

## 6. Update — November 2026

### 6.1 What changed since July

| Date | Work | What it is | Why it matters here |
|------|------|------------|---------------------|
| Oct 2026 | **copisteria / copista** (KobiMusic) | Detector (270 classes + note attributes: staff position, stem, dots, voice) → geometry-only front end → **2M-param "evidence" transformer** reading each system with its neighbours → rhythm/accidental decoding → MusicXML with beams, ties, tuplets, keys, meters | **Apache-2.0 code and weights**, small (copista-2m ≈ 4M params, copista-28m ≈ 31M). Self-reported OMR-NED on real scans: quartets 8.6 %, Lieder 16.9 %, Polish piano 31.5 % — ahead of homr, Transcoda, Legato and Audiveris on every set it reports. 30 commits, 18★: young project. |
| Jun 2026 | **homr 0.7.0** | oemer-derived segmentation + per-staff TrOMR transformer; **now runs on onnxruntime, no PyTorch** | Browser port is now technically easy — but code *and* weights are **AGPL-3.0** (weights also inherit CC BY-NC data via PrIMuS). Own benchmark: SMB 12.8 % OMR-NED. No beams in output. |
| May 2026 | **Transcoda** (Dratschuk & Swoboda, arXiv 2605.10835, NeurIPS 2026) | 59M-param end-to-end img2seq trained only on synthetic data ("zero-shot" on real scans) | OMR-NED 64 % on the Polish scans vs 80 % SMT++, 87 % Legato — data-centric synthesis helps, but page-level end-to-end models remain far behind pipelines on real scans. Release promised on publication. |
| Jul 2026 | **LEGATO 2** (Yang et al., arXiv 2607.05769) | System-by-system autoregressive VLM; also transcribes embedded text | Not released. LEGATO 1 (ICLR 2026, Llama-3.2-11B-Vision, MIT, gated HF weights) is far too big for a browser. |
| Jan 2026 | **SMT++** published in IJCV | Full-page pianoform img2seq (unchanged model) | Still collapses on real scans in third-party benchmarks (78 % OMR-NED on polish-scores in homr's benchmark). |
| Apr 2026 | Ma et al., arXiv 2604.16446 | CNN (bottleneck residual + dilations) + BiGRU + CTC | 0.45 % symbol error on Camera-PrIMuS — monophonic incipits only; no code. |
| May / Sep 2026 | MusiCorpus (arXiv 2605.18436); full-page handwritten monophonic OMR (arXiv 2609.05662) | 1,309 hand-annotated historical/handwritten pages with MusicXML; synthetic-pretraining study | Handwritten remains out of scope for this app. |
| 2026 | Audiveris 5.10–5.11 | Classical/hybrid Java pipeline | A vendor benchmark (Sheetly, Oct 2026, unverified) shows it dropping from 88 % to 50 % accuracy on simulated phone photos. |

**Benchmarks and metrics.** The field has converged on **OMR-NED** (edit
distance over normalized musical symbols / (N_ref + N_pred)) on **real** pages:
SMB (685 pages), polish-scores (112 historical piano scans, kern + MusicXML),
OpenScore Lieder/Quartets scans, and homr's *sheet-music-photos* (public-domain
editions + phone photos). Absolute numbers still depend on the tokenizer
(homr's native parser vs musicdiff), so only same-harness comparisons count.

**Take-aways.**
1. The decisive 2026 shift is not bigger end-to-end models but **detector +
   learned context model** pipelines (copisteria): the network sees symbols,
   and a small transformer over all symbols of neighbouring systems fixes what
   local reading cannot (a natural that contradicts the key, a bar that does
   not add up, a dot that the repetitions have).
2. Page-level image-to-sequence models (SMT++, Transcoda, LEGATO) are still
   much worse on real scans and too big for a browser.
3. Licensing now separates the two best open tools: copisteria is
   Apache-2.0, homr is AGPL-3.0.

### 6.2 Measured on this repo's test pages

`test_images/` holds three phone photos (≈ 590 × 792 px, so a staff space is
only ≈ 4.5 px) of Clementi Op. 36 No. 2, III (Henry Lemoine edition, pages
54–56), with printed and pencilled fingerings, coloured annotations and page
curvature. Reference: the public-domain WIMA MIDI (IMSLP #218430), 111 bars of
3/8. Scored with `scripts/eval/score.mjs` (pitch tokens, and pitch +
inter-onset-interval tokens, per hand; LCS alignment so a missed bar costs only
its notes; NED = edit distance / (N_ref + N_pred) on pitch + rhythm tokens):

| Engine | Pitch F1 | Pitch + rhythm F1 | NED | CPU time / page |
|--------|---------:|------------------:|----:|-----------------|
| This app, July version (oemer UNets + JS rules) | 36.7 | 1.3 | 74.1 | page 1: no staff found |
| homr 0.7 (AGPL — excluded) | 97.3 | **96.5** | **3.0** | ~18 s |
| copisteria + copista-2m | 97.6 | 84.0 | 8.7 | ~6 s (Python) |
| copisteria + copista-28m | **99.1** | 91.0 | 5.0 | ~17 s (Python) |

*Correction:* a first version of this table showed homr at 67.7 / 66.2; that
was a bug in the harness (the two staves of homr's page-1 part were taken in
the wrong order), fixed since. homr reads these pages very well — its
per-staff transformer reads rhythm straight from the image — but code and
weights are AGPL-3.0 and the app stays permissive (decision of 2026-11-09).

copisteria's errors concentrate where fingerings are dense: the copista
detector has no fingering class, so printed and pencilled fingering digits
come out as **tuplet numbers** (50–76 per page), and the evidence model then
reads runs of 16ths as sextuplets. A few extra left-hand notes come from
noteheads a player drew in blue pen.

**ONNX feasibility (verified).** Both detectors (two graphs each: a fully
convolutional trunk, and a verifier over the top-K peak cells with RoIAlign)
and the evidence model export to ONNX (opset 17) with max abs logit error
≤ 2e-4 and identical argmax, at dynamic image sizes and token counts:
copista-2m 6.7 + 1.1 MB, copista-28m 106 + 8.8 MB, evidence model 8.2 MB.

## 7. Upgrade plan (November 2026)

**Decisions (2026-11-09):** permissive licences only (app stays MIT) ·
port copisteria's reader to **JavaScript** (no Pyodide) · ship copista-2m by
default with copista-28m as an on-demand "high accuracy" option · **remove**
the oemer and classical engines.

### 7.1 Architecture

```mermaid
flowchart LR
    A[Image] --> B[Grayscale + Lanczos resize<br/>staff space → 10.6 px]
    B --> C[Detector trunk ONNX<br/>features, objectness, boxes]
    C --> D[JS: 3×3 peaks, top-K]
    D --> E[Detector verifier ONNX<br/>class, refine, attributes]
    E --> F[JS: decode + class-wise NMS<br/>→ detections]
    F --> G[JS front end<br/>staves, systems, bars, assignment]
    G --> H[JS tokens per system window]
    H --> I[Evidence model ONNX<br/>2M transformer]
    I --> J[JS writer: meter, rhythm Viterbi,<br/>accidentals, voices → MusicXML]
    J --> K[Verovio: SVG + MIDI]
```

### 7.2 Work items

| # | Item | Done when |
|---|------|-----------|
| 1 | **Evaluation harness** — `scripts/eval/` (MIDI reader, MusicXML timing, LCS/NED scorer) + reference manifest | Baselines reproducible with one command |
| 2 | **ONNX export script** (Python, run once by maintainers) + model fetch script + NOTICE/attribution | `npm run fetch:models` gets ~16 MB (2m) |
| 3 | **Detector in JS** — Lanczos resize, staff-space estimation, two-pass sizing, peak/top-K, verifier, NMS, records | JS detections match Python's on the test pages |
| 4 | **Front end in JS** — page cleaning, staff finder, systems/links model, bars, assignment, revision pass | Same staves/systems/bars as Python |
| 5 | **Tokens + reader in JS** — `features.page_arrays`, windowing, evidence model I/O, readings | Same readings as Python |
| 6 | **Writer in JS** — parts, pitch/alteration, meter decode, rhythm Viterbi, beams/slurs/ties, MusicXML | Same MusicXML as Python (or same score) |
| 7 | **App integration** — worker engine, model download/caching, 2m/28m option, remove oemer/classical | Browser run on the 3 test pages |
| 8 | **Improve beyond upstream** on the hard cases found (e.g. fingering digits read as tuplets) — only with changes that generalize | Test-page scores improve without page-specific rules |

### 7.3 Acceptance

On the three test pages, with copista-2m in the browser pipeline: pitch F1
≥ 95 and pitch + rhythm F1 ≥ 80 on every page, matching the Python reference
within noise. Rules are never tuned to a single page: every heuristic must
name the general notation fact it relies on, and unit tests use synthetic
cases.

### 7.4 Risks

- **Port size** (~4.4k lines of Python, dense heuristics): mitigated by
  module-by-module parity tests against dumped Python intermediates.
- **Upstream drift**: pin the copisteria commit in the export script and the
  NOTICE; port upstream fixes deliberately.
- **Young upstream** (released Oct 2026): our own harness and tests guard
  against regressions in what we ship.
- **Speed in WASM**: copista-2m trunk ≈ 0.4 s native → a few seconds in
  WASM; 28m will be slow without WebGPU — hence 2m by default.

### 7.5 Status (2026-11-09)

Items 1–8 are done:

- **Port** (`src/pipeline/copisteria/`, ~3.5k lines of JS): with
  `upstream: true` its MusicXML is **byte-identical** to copisteria's Python
  on the three test pages, a 2252 × 4000 phone photo (box path) and a clean
  render (ink path). Exact parity needed Pillow's 8-bit Lanczos and luma,
  numpy's percentile / median, Python's banker's rounding, scipy's
  even-size filter origins and ElementTree's serialization. The verifier's
  `nn.TransformerEncoder` had to be re-expressed with dynamic reshapes for
  ONNX (the stock trace bakes in the candidate count).
- **App**: one engine (copista-2m default, 28m optional) in a Web Worker on
  ONNX Runtime Web; models cached with the Cache API. Verified in headless
  Chrome: a test page takes ~4 s end to end (WASM, models cached). The old
  oemer / classical engines are removed.
- **Beyond upstream — fingering digits** (`fingerings.js`): a digit centred
  over a notehead is a fingering when another digit sits over a neighbouring
  note or over another note of its beam group, or when its note is the first /
  last of a beam group of ≥ 3 (tuplet numbers are one per group, centred on
  it). On the test pages:

  | | Pitch F1 | Pitch + rhythm F1 (pages 0 / 1 / 2) |
  |---|---:|---:|
  | copista-2m, upstream | 97.6 | 84.0 (90.5 / 69.7 / 91.8) |
  | **copista-2m + fingering filter** | **97.9** | **94.7** (95.1 / 90.2 / 98.8) |
  | copista-28m + fingering filter | 99.0 | 93.0 (96.6 / 87.1 / 95.3) |

  Over-fitting checks: the filter changes nothing on the two pages outside
  the test set (the Boogie photo, the clean render), and keeps every real
  tuplet number on a synthetic page of beamed / bracketed triplets and
  sextuplets with fingered 16th runs (at full and test-photo resolution).
  One side effect seen there: the evidence model treats tuplet numbers as
  page-wide evidence for tuplets, so removing a (correctly judged) stray
  fingering can make it read fewer tuplets elsewhere on a page of real
  tuplets.
- Tried and **not** kept: whitening saturated (coloured-ink) pixels — no
  net gain (94.7 → 94.4); the blue pen is too dark to separate from print by
  colour and overlaps printed heads.

**Open ends:** lone fingerings over the middle note of a 3-note group are
indistinguishable from triplet numbers by layout alone (the meter's
arithmetic would have to decide); retraining the detector with a fingering
class would remove the confusion at its source; homr shows that a per-staff
image-to-sequence reader recovers rhythm better on these photos (96.5) — a
permissively licensed model of that kind would be worth adding as a second
engine.

## Sources (November 2026 update)

- copisteria · https://github.com/kobimusic/copisteria · weights https://huggingface.co/kobimusic/copista-2m, https://huggingface.co/kobimusic/copista-28m (Apache-2.0)
- homr 0.7.0 · https://github.com/liebharc/homr · Benchmark.md, LICENSE_FAQ.md · https://pypi.org/project/homr
- Transcoda · arXiv:2605.10835 · https://huggingface.co/datasets/btrkeks/polish-scores
- LEGATO · arXiv:2506.19065 (ICLR 2026) · LEGATO 2 · arXiv:2607.05769
- SMT++ (IJCV 2026) · arXiv:2405.12105
- Ma et al. · arXiv:2604.16446 — MusiCorpus · arXiv:2605.18436 — handwritten full-page · arXiv:2609.05662
- Sheet Music Benchmark · arXiv:2506.10488 · https://huggingface.co/datasets/PRAIG/SMB
- Sheetly OMR benchmark (vendor, unverified) · https://www.trysheetly.com/compare/omr-benchmark
- Reference MIDI: IMSLP #218430 (WIMA, public domain) · https://imslp.org/wiki/6_Sonatinas,_Op.36_(Clementi,_Muzio)
