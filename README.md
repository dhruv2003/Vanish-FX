# Vanish FX

Gesture-triggered camera effects for browser video calls (Google Meet, Microsoft Teams, Zoom web).
Everything runs **locally in your browser**: hand tracking and body segmentation use MediaPipe (WASM + WebGL), and no video is sent anywhere except to the call itself.

| Effect | Gesture | Shortcut | What happens |
|---|---|---|---|
| 🫰 **Dust Snap** | Snap your fingers (mic hears the click to confirm) | `Alt+Shift+1` | A shiver and chromatic flicker, then you char at the edges and break up in layers of ash, embers swirling in the wind; mic mutes. Snap again: the dust spirals back and you settle in with a pulse. |
| 📜 **Sealing Scroll** | Press palms together (hand seal), hold briefly | `Alt+Shift+2` | A scroll springs in and unrolls, a chakra glow builds, you're sucked in on a spiral, and it slams shut with an impact frame and shockwave, then floats there. Seal again to burst back out. |
| 👥 **Clone Burst** | Cross your index fingers | `Alt+Shift+3` | A cascade of smoke puffs, and 2–4 copies of you pop in with a white flash, copying your moves slightly behind and swaying. Cross again: they squash and poof one by one. |
| 🔵 **Energy Orb** | Hold an open palm up for ~1s | `Alt+Shift+4` | Energy spirals into your palm and a swirling shader orb charges up, trailing and stretching as you move. Close your fist: it implodes with a flash and shockwave. |

Every effect is animated with motion-design principles (anticipation, spring overshoot, squash & stretch, follow-through, smears, flashes, shockwaves and camera shake on the big beats), and every effect has **sound effects**, synthesized live with Web Audio (no audio files). You hear them, and they're mixed into your mic so the call hears them too. Each can be toggled in the popup.

## Install

1. Get the extension:
   - **Easy:** download `vanish-fx.zip` from the Releases page and unzip it, **or**
   - **From source:** `npm install && npm run build` (creates `dist/` and `vanish-fx.zip`).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder (or `dist/`).
4. Pin **Vanish FX** from the puzzle-piece menu.
5. **Reload** any Meet / Teams / Zoom tab that was already open.

## Use

1. Click the Vanish FX icon, then **🪞 Open test mirror** to try the effects on your own camera (with a tracking overlay that's never sent to calls).
2. **📷 Capture empty room:** press it, step out of frame during the 3s countdown, and stay out until 5.5s. If at least 90% of the room was seen, it **locks**: vanishing then shows your real room, including where your shadow was, and it follows your camera's exposure and white balance. (Without this it still learns the room over time from everything you're not covering, and locks automatically once it has seen 98% of it.)
3. Join your call as usual. The camera and mic the call receives are the processed ones.

Tips
- Good lighting helps hand tracking a lot. Keep your hand roughly 40–80 cm from the camera.
- A snap needs both the motion (thumb + middle finger touching, then releasing) **and** the click sound. Typing or waving won't trigger it. If your mic is off, it falls back to motion only. You can also turn sound confirmation off in Settings.
- Effects show to others *not mirrored*. "Dust blows → right" means right as others see you.
- The call's own mute button doesn't know about the auto-mute: others hear silence while you're vanished, but the call's mic icon stays the same.

## How it works

```
call page (MAIN world)                     hidden extension iframe (engine.html)
getUserMedia() ── patched ──► camera ─► frames (ImageBitmap) ─► MediaPipe hands + selfie segmentation
                                                               gesture detection → effects → Canvas2D
call ◄── processed track ◄── MediaStreamTrackGenerator ◄────── rendered frame
mic ─► WebAudio: mute gain + snap-click detector + synthesized SFX ─► processed mic track
```

The AI runs in an extension-origin iframe because call sites like Teams don't allow WebAssembly in their own pages (CSP). The engine follows the extension's CSP instead, so the same code works everywhere.

## Project layout

```
src/hook.js            getUserMedia interception (page world)
src/bridge.js          creates the engine iframe on demand
src/lib/pipeline.js    video/audio track wrapping, engine messaging
src/lib/sfx.js         procedural sound effects
src/engine/            AI + masks + room (vision.js), gestures.js, effects.js,
                       motion.js (springs, easing, shake, shockwaves, flashes), engine.js
src/popup/             toolbar popup
src/preview/           test mirror page
build.mjs              esbuild bundle + copy MediaPipe WASM/models + zip
```

Models: [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) and the Selfie Multiclass / Selfie Segmenter [image segmentation models](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) (Apache 2.0), downloaded at build time.

## Testing

`npm run build`, serve `dist/` over HTTP and open `preview/preview.html?synthetic` for a fake camera (a drawn room with a blue figure that's colour-keyed as the person). Add `&noai` to skip loading the MediaPipe models. During a room capture the synthetic figure walks out of frame. The engine exposes `globalThis.__vfxDebug` (effect objects, `transitions` log, `perf`, `grabs` for exact-time frame captures) to same-origin test pages only.

## Credits

The v2 dust layers, mask pipeline, room capture / exposure tracking and snap thresholds are adapted from [thanos-snap-video-extension](https://github.com/aayushifty/thanos-snap-video-extension) by Aayush Bhatta (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
