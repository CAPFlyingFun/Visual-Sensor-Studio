# Visual Sensor Studio v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a mobile-first TypeScript PWA that visualizes camera, motion, GPS and experimental parallax data in a unified 3D sensor interface.

**Architecture:** Static TypeScript ES modules keep the runtime small and GitHub Pages-friendly. Browser-accessible sensors are isolated behind controllers, pure vision/math functions remain unit-testable, and Three.js consumes normalized sensor state without owning permission logic.

**Tech Stack:** TypeScript 7.0.2, Three.js 0.185.1 via import map, browser MediaDevices/DeviceMotion/DeviceOrientation/Geolocation APIs, Node built-in test runner, GitHub Pages/Actions.

**Spec:** `docs/superpowers/specs/2026-08-29-visual-sensor-studio-design.md`

## Global Constraints

- Do not represent parallax or image relief as LiDAR.
- No application backend or sensor-data upload.
- Mobile-first Safari/PWA controls with explicit permission buttons.
- GPS history is bounded to 500 accepted points.
- Do not integrate phone acceleration into claimed position.

---

### Task 1: Pure sensor and vision math

**Files:**
- Create: `src/core/math.ts`
- Create: `src/vision/frame-processing.ts`
- Create: `src/vision/parallax.ts`
- Test: `tests/math.test.mjs`
- Test: `tests/frame-processing.test.mjs`
- Test: `tests/parallax.test.mjs`

**Interfaces:**
- Produces: `gpsToLocalMeters`, `deviceOrientationToQuaternion`, `rgbaToGray`, `sobelEdges`, `computeBlockDisparity`.

- [x] Write failing tests for GPS local-meter conversion, luminance/edge math, and known synthetic image disparity.
- [x] Run tests and verify they fail because implementations are absent.
- [x] Implement minimal pure functions.
- [x] Re-run tests and verify all pure-function tests pass.

### Task 2: Browser sensor controllers

**Files:**
- Create: `src/sensors/camera.ts`
- Create: `src/sensors/motion.ts`
- Create: `src/sensors/gps.ts`
- Create: `src/core/types.ts`

**Interfaces:**
- Produces: `CameraController`, `MotionController`, `GpsController`.
- Consumes: math/data types from Task 1.

- [x] Implement explicit camera startup, switching and bounded frame capture.
- [x] Implement iOS-compatible motion/orientation permission flow.
- [x] Implement GPS watch, local origin and bounded track storage.
- [x] Type-check all controller modules under strict TypeScript.

### Task 3: Interactive 3D fusion scene

**Files:**
- Create: `src/visualization/scene.ts`
- Create: `src/shims.d.ts`

**Interfaces:**
- Produces: `FusionScene.setOrientation`, `setAcceleration`, `setGpsTrack`, `resetView`.
- Consumes: normalized quaternion, acceleration and GPS samples.

- [x] Create a Three.js scene with orbit controls, meter grid and phone model.
- [x] Add phone orientation, acceleration arrow and GPS line/point rendering.
- [x] Add responsive canvas resizing and cleanup.

### Task 4: Mobile UI and orchestration

**Files:**
- Create: `src/main.ts`
- Create: `public/index.html`
- Create: `public/styles.css`

**Interfaces:**
- Consumes all controller and visualization interfaces from Tasks 1–3.

- [x] Bind explicit camera, motion and GPS controls.
- [x] Add RGB/Relief/Edge live views.
- [x] Add capture-A/analyze-B parallax workflow and confidence-aware visualization.
- [x] Add sensor JSON export and honest limitation labels.
- [x] Type-check the full application.

### Task 5: PWA and GitHub Pages deployment

**Files:**
- Create: `public/manifest.webmanifest`
- Create: `public/sw.js`
- Create: `public/icons/*`
- Create: `.github/workflows/deploy-pages.yml`
- Create: `README.md`

**Interfaces:**
- Produces: installable/offline-capable shell and Pages deployment.

- [x] Add manifest and iOS home-screen metadata.
- [x] Cache same-origin app shell and pinned Three.js CDN runtime.
- [x] Add build/test/deploy GitHub Actions workflow.
- [x] Document iPhone permissions, limitations, privacy and local development.
- [x] Run final verification on the complete repository and push to GitHub.
