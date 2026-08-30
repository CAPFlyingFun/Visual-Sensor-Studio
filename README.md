# Visual Sensor Studio

A mobile-first Progressive Web App for experimenting with an iPhone's browser-accessible camera, motion/orientation sensors, GPS, image processing, parallax depth cues, and interactive 3D data visualization.

The first release is intentionally an **instrument playground**, not a fake LiDAR app. It separates measured data from inferred/visualized data and labels experimental outputs clearly.

## What v0.1 does

- **Live camera lab** with rear/front camera switching.
- **RGB, image-relief, and edge views** processed locally in the browser.
- **Device orientation + motion** with iOS permission handling.
- **Interactive Three.js sensor scene** showing the phone orientation and acceleration vector.
- **Optional GPS breadcrumb track** rendered in the same 3D scene, using approximately one scene unit per meter from the first GPS point.
- **Two-frame parallax depth experiment**: capture frame A, move the phone sideways, capture B, then estimate relative disparity with block matching.
- **Sensor JSON export** for the latest motion/GPS/parallax summary.
- **PWA installability and offline shell caching** after the app has loaded once.
- **GitHub Pages deployment** through GitHub Actions.

## Important limits

- The iPhone 15 Plus does **not** have Apple's rear LiDAR scanner.
- Safari does not expose Apple's raw TrueDepth/AVDepthData stream to ordinary web pages, so this app does not claim to read TrueDepth depth maps.
- The **Relief** view is image-derived and is not physical depth.
- The **Parallax** view is relative disparity, not calibrated range. It works best on textured, static scenes when the phone is moved sideways with little rotation.
- GPS and phone IMU data are not survey-grade. GPS can be noisy indoors, and accelerometer integration drifts too quickly to use as trustworthy position, so v0.1 visualizes acceleration rather than pretending it can reconstruct a stable inertial path.

## iPhone use

1. Open the GitHub Pages site in Safari over HTTPS.
2. Tap **Start Camera** and allow camera access.
3. Tap **Enable Motion Sensors** and allow motion/orientation access.
4. Optionally tap **Start GPS Track** and allow location access.
5. For a parallax scan, capture A, slide the phone roughly 5–10 cm sideways while keeping the same scene framed, then tap **Analyze B**.
6. Use Safari's Share sheet → **Add to Home Screen** for the installed PWA experience.

## Development

The app is written in TypeScript and compiled to browser-native ES modules. Three.js is loaded with an import map so the runtime stays simple and GitHub Pages can host the app as static files.

```bash
npm install
npm test
npm run build
```

Then serve `public/` from localhost, for example:

```bash
python3 -m http.server 8080 --directory public
```

Open `http://localhost:8080`. Camera APIs work on localhost as a secure-context exception; motion behavior is best tested on the actual iPhone over HTTPS.

## Project layout

```text
src/
  core/             shared math and data types
  sensors/          camera, motion/orientation, GPS
  vision/           frame source interface, image processing, flow, parallax
  visualization/    Three.js 3D sensor viewer
public/
  index.html        mobile UI shell
  styles.css        responsive visual design
  sw.js             PWA service worker
  manifest.webmanifest
  app/              generated JavaScript after `npm run build`
tests/              Node test suite for pure sensor/vision math
```

## Privacy

Visual Sensor Studio has no application backend. Camera frames and image-processing work stay in the browser. The app does not upload camera images, GPS coordinates, or motion data. Three.js is fetched from jsDelivr and cached by the service worker after first use.

## Architecture

The data flow is one-directional, and deliberately so:

```text
camera acquisition -> FrameSource -> vision processing -> sensor state -> optional Three.js
```

- `public/camera-bootstrap.js` is plain JavaScript, loads before the compiled
  app, and owns the `<video>` element, every `getUserMedia` call and the whole
  camera lifecycle. A TypeScript or Three.js failure cannot take the camera
  down with it. `src/sensors/camera.ts` is only a typed bridge to it.
- `src/vision/frame-source.ts` defines the acquisition boundary. Processing
  modes consume generic `AnalysisFrame`s and never touch `getUserMedia`, a
  `<video>` element or a `MediaStreamTrack`, so a future native provider is a
  new `FrameSource` rather than a rewrite.
- Three.js is a visualization consumer only. It never captures anything.

Vision work runs on a downsampled analysis frame (~176/256/384 px wide for
Battery Saver / Balanced / Fast), throttled by preset, into buffers that are
allocated once per frame geometry and reused.

## Next experiments

Potential follow-ons include feeding flow and parallax summaries into the 3D
sensor scene, guided panorama capture, improved parallax confidence filtering,
point-cloud reconstruction, exportable height/disparity maps, and a native iOS
camera provider for multi-lens capture.
