# Visual Sensor Studio v0.1 Design

## Purpose

Build a fun but technically honest iPhone sensor-fusion PWA that combines browser-accessible camera, motion/orientation and GPS data with interactive 3D visualization and an experimental camera-parallax depth view.

## Product principles

1. Do not label inferred depth as LiDAR.
2. Keep sensor processing local; no backend is required.
3. Design mobile-first for Safari and installed PWA use.
4. Put measured data and visualizations in the same interface so numbers have spatial context.
5. Keep subsystems isolated so future panorama, point-cloud and native-depth experiments can be added without rewriting the app.

## Architecture

The app is TypeScript compiled to native ES modules and hosted as static files on GitHub Pages. Three.js is loaded via an import map from a pinned CDN version. A service worker caches the app shell and Three.js runtime after first use.

Subsystems:

- `CameraController`: permission, stream lifecycle, facing-mode switching and frame capture.
- `MotionController`: iOS permission flow, device orientation, acceleration and rotation rate.
- `GpsController`: high-accuracy geolocation watch, local-meter conversion and bounded breadcrumb history.
- `frame-processing`: grayscale, relief, edge and disparity visualization functions.
- `parallax`: two-frame block matching that produces relative disparity and match confidence.
- `FusionScene`: Three.js phone model, orientation quaternion, acceleration vector and GPS track.
- `main`: UI binding and orchestration only.

## User flows

### Camera

The user explicitly starts the camera. They can switch rear/front cameras and choose RGB, Relief or Edge visualization. Relief is visibly labeled as image-derived, not physical depth.

### Motion

The user taps a dedicated permission button. Live alpha/beta/gamma, acceleration and rotation rate update the numeric readouts. Orientation rotates the 3D phone model and acceleration updates a 3D arrow.

### GPS

The user starts/stops GPS explicitly. The first point becomes the local origin. Later coordinates are converted to meter-scale x/y/z offsets and displayed as a 3D breadcrumb line. The app does not integrate IMU acceleration into position.

### Parallax

The user captures A, moves sideways about 5–10 cm, then analyzes B. The algorithm searches local image patches across horizontal disparity plus a small vertical tolerance. The result is a relative disparity map with confidence-weighted opacity and a median disparity value. It is never presented as calibrated distance.

### Export

The user can download a JSON snapshot of latest sensor values and the parallax summary. Camera frames are not included.

## Platform constraints

- Requires HTTPS for normal deployed camera/geolocation access.
- iOS motion/orientation access requires a user gesture and explicit permission.
- Ordinary Safari web APIs do not provide raw Apple TrueDepth depth maps.
- The target device may have no rear LiDAR; the app must remain useful without it.
- GPS accuracy varies and altitude may be unavailable.

## Deployment

A GitHub Actions workflow installs the pinned TypeScript compiler, runs tests, builds the `public/app` modules and deploys `public/` to GitHub Pages.
