# Third-party notices

Vanish FX includes code adapted from the following project.

## thanos-snap-video-extension

- Source: https://github.com/aayushifty/thanos-snap-video-extension
- License: MIT
- Adapted parts (each marked with a comment in our source):
  - `src/engine/effects.js` — Dust v2 layer slicing (noise-assigned 2 px grains in 20 layers, ash fade, ember seeding), from `thanos_engine.js` `_buildDust` / `_drawDust`.
  - `src/engine/vision.js` — Mask v2 hide / learn / influence-zone masks (`_updateMask`, `_stamp`), multiclass person = 1 − background (`seg_worker.js`), and Room v2 guided capture, exposure / white-balance gain and scanline fill (`_tickCapture`, `_updateGain`, `_scanlineFill`, `_reportCoverage`).
  - `src/engine/gestures.js` — sensitivity-scaled snap thresholds and the hand-scale-normalised pinch / slam features (`gesture.js` `handFeatures`, `setSensitivity`).

```
MIT License

Copyright (c) 2026 Aayush Bhatta

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MediaPipe models

Hand Landmarker, Selfie Multiclass and Selfie Segmenter models by Google (Apache 2.0), downloaded at build time, not stored in this repository.
