(() => {
  'use strict';

  const video = document.getElementById('cameraVideo');
  if (!(video instanceof HTMLVideoElement)) return;

  const captureCanvas = document.createElement('canvas');
  const captureContext = captureCanvas.getContext('2d', { willReadFrequently: true });
  const photoCanvas = document.createElement('canvas');
  const photoContext = photoCanvas.getContext('2d', { willReadFrequently: true });
  if (!captureContext || !photoContext) return;

  let stream = null;
  let facing = 'environment';
  let sourceKind = 'none';
  let lastStage = 'idle';

  function prepareVideo() {
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.setAttribute('autoplay', 'true');
    video.autoplay = true;
    video.muted = true;
  }

  function releaseStream() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    stream = null;
    try { video.pause(); } catch { /* WebKit can throw during teardown. */ }
    video.srcObject = null;
    if (sourceKind === 'live') sourceKind = 'none';
  }

  function waitForMetadata(timeoutMs = 2400) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA || video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', finish);
        video.removeEventListener('loadeddata', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      video.addEventListener('loadedmetadata', finish, { once: true });
      video.addEventListener('loadeddata', finish, { once: true });
    });
  }

  function playbackTimeout(timeoutMs = 2600) {
    return new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error('Camera preview did not begin playback.');
        error.name = 'NotReadableError';
        reject(error);
      }, timeoutMs);
    });
  }

  function errorName(error) {
    return error && typeof error === 'object' && 'name' in error ? String(error.name || '') : '';
  }

  function describeError(error, standalone = false) {
    const name = errorName(error);
    const hint = standalone
      ? ' iOS/WebKit can fail live camera capture in standalone PWAs even when the same page works in a browser tab. Try Native Photo or Open Live Camera in Edge.'
      : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return `Camera permission was blocked or unavailable.${hint}`;
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return `No usable camera was reported.${hint}`;
    if (name === 'NotReadableError' || name === 'TrackStartError') return `The camera exists but WebKit could not deliver usable preview frames.${hint}`;
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return `The requested camera mode was unavailable.${hint}`;
    const message = error instanceof Error ? error.message : 'Unable to start the camera.';
    return `${message}${hint}`;
  }

  async function start(requestedFacing = facing) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser context.');

    releaseStream();
    photoCanvas.width = 0;
    photoCanvas.height = 0;
    sourceKind = 'none';
    facing = requestedFacing === 'user' ? 'user' : 'environment';
    prepareVideo();

    const requestProfiles = [
      { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } },
      { audio: false, video: { facingMode: { ideal: facing } } },
      { audio: false, video: true }
    ];

    let lastError = new Error('Unable to start the camera.');
    for (const constraints of requestProfiles) {
      releaseStream();
      prepareVideo();
      try {
        lastStage = 'getUserMedia';
        const nextStream = await navigator.mediaDevices.getUserMedia(constraints);
        stream = nextStream;
        video.srcObject = nextStream;
        lastStage = 'metadata';
        await waitForMetadata();
        lastStage = 'playback';
        const playPromise = video.play();
        if (playPromise) await Promise.race([playPromise, playbackTimeout()]);
        const track = nextStream.getVideoTracks()[0];
        const hasFrames = video.videoWidth > 0 || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        if (!track || track.readyState !== 'live' || !hasFrames) {
          const error = new Error('Camera stream opened but no usable preview frames arrived.');
          error.name = 'NotReadableError';
          throw error;
        }
        sourceKind = 'live';
        lastStage = 'live';
        return facing;
      } catch (error) {
        lastError = error;
        releaseStream();
        const name = errorName(error);
        if (name === 'NotAllowedError' || name === 'SecurityError') throw error;
      }
    }
    lastStage = 'failed';
    throw lastError;
  }

  async function switchCamera() {
    const next = facing === 'environment' ? 'user' : 'environment';
    await start(next);
    return next;
  }

  function stop() {
    releaseStream();
    lastStage = sourceKind === 'photo' ? 'photo' : 'idle';
  }

  async function loadNativePhoto(file) {
    if (!(file instanceof Blob)) throw new Error('Choose a photo first.');
    releaseStream();
    lastStage = 'photo-loading';

    let source;
    let objectUrl = '';
    try {
      if ('createImageBitmap' in window) {
        source = await createImageBitmap(file);
      } else {
        objectUrl = URL.createObjectURL(file);
        source = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('Could not decode the selected photo.'));
          image.src = objectUrl;
        });
      }

      const sourceWidth = source.width || source.naturalWidth;
      const sourceHeight = source.height || source.naturalHeight;
      if (!sourceWidth || !sourceHeight) throw new Error('The selected photo has no usable dimensions.');

      const maxDimension = 1920;
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
      photoCanvas.width = Math.max(1, Math.round(sourceWidth * scale));
      photoCanvas.height = Math.max(1, Math.round(sourceHeight * scale));
      photoContext.clearRect(0, 0, photoCanvas.width, photoCanvas.height);
      photoContext.drawImage(source, 0, 0, photoCanvas.width, photoCanvas.height);
      sourceKind = 'photo';
      lastStage = 'photo';
      return captureFrame(640).imageData;
    } finally {
      if (source && typeof source.close === 'function') source.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  function captureFrame(targetWidth = 192) {
    const safeWidth = Math.max(32, Math.min(960, Math.round(targetWidth)));
    let source;
    let sourceWidth;
    let sourceHeight;

    if (stream?.getVideoTracks().some((track) => track.readyState === 'live') && video.videoWidth && video.videoHeight) {
      source = video;
      sourceWidth = video.videoWidth;
      sourceHeight = video.videoHeight;
    } else if (sourceKind === 'photo' && photoCanvas.width && photoCanvas.height) {
      source = photoCanvas;
      sourceWidth = photoCanvas.width;
      sourceHeight = photoCanvas.height;
    } else {
      throw new Error('No camera frame or native photo is ready yet.');
    }

    const height = Math.max(24, Math.round((sourceHeight / sourceWidth) * safeWidth));
    captureCanvas.width = safeWidth;
    captureCanvas.height = height;
    captureContext.drawImage(source, 0, 0, safeWidth, height);
    return {
      imageData: captureContext.getImageData(0, 0, safeWidth, height),
      width: safeWidth,
      height
    };
  }

  const VisualCamera = {
    start,
    switchCamera,
    stop,
    captureFrame,
    loadNativePhoto,
    describeError,
    get active() {
      return Boolean(stream?.getVideoTracks().some((track) => track.readyState === 'live'));
    },
    get ready() {
      return this.active || (sourceKind === 'photo' && photoCanvas.width > 0 && photoCanvas.height > 0);
    },
    get currentFacing() { return facing; },
    get sourceKind() { return sourceKind; },
    get diagnostics() {
      const track = stream?.getVideoTracks()[0] || null;
      return {
        stage: lastStage,
        sourceKind,
        trackState: track?.readyState || 'none',
        videoWidth: video.videoWidth || 0,
        videoHeight: video.videoHeight || 0,
        readyState: video.readyState
      };
    }
  };

  prepareVideo();
  window.VisualCamera = VisualCamera;
})();