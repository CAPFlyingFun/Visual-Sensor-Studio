import { FIT, clampView, panBy, zoomAbout, toggleZoom, transformOf, type View } from './pan-zoom.js';

/** Own gestures only inside the photo viewport. CSS transforms never alter export pixels. */
export function attachPhotoView(frame: HTMLElement, canvas: HTMLCanvasElement,
  original: HTMLCanvasElement, fit: HTMLButtonElement): () => void {
  let view: View = { ...FIT };
  let lastTouch = -Infinity;
  let tapStart: { x: number; y: number; time: number } | null = null;
  let lastTap: { x: number; y: number; time: number } | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  const sizes = () => {
    const rect = frame.getBoundingClientRect();
    const ratio = Math.min(rect.width / Math.max(1, canvas.width), rect.height / Math.max(1, canvas.height));
    return { frame: rect, fitted: { width: canvas.width * ratio, height: canvas.height * ratio } };
  };
  const paint = () => {
    const s = sizes(); view = clampView(view, s.frame, s.fitted);
    canvas.style.transform = original.style.transform = transformOf(view);
    frame.dataset.zoom = view.scale.toFixed(2);
    frame.style.cursor = view.scale > 1 ? 'grab' : 'zoom-in';
  };
  const reset = () => { pointers.clear(); tapStart = lastTap = null; view = { ...FIT }; paint(); };
  const point = (event: PointerEvent | WheelEvent | MouseEvent) => {
    const r = frame.getBoundingClientRect();
    return { x: event.clientX - r.x - r.width / 2, y: event.clientY - r.y - r.height / 2 };
  };
  frame.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointers.size >= 2) return;
    event.preventDefault(); pointers.set(event.pointerId, point(event));
    if (event.pointerType === 'touch') lastTouch = performance.now();
    if (event.pointerType === 'touch' && pointers.size === 1) tapStart = { ...point(event), time: performance.now() };
    else { tapStart = null; lastTap = null; }
    // Synthetic events have no active pointer; native gestures always capture.
    if (frame.hasPointerCapture(event.pointerId) || event.isTrusted) frame.setPointerCapture(event.pointerId);
  });
  frame.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId); if (!previous) return;
    event.preventDefault();
    const next = point(event), s = sizes();
    if (tapStart && Math.hypot(next.x - tapStart.x, next.y - tapStart.y) > 8) { tapStart = null; lastTap = null; }
    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)![1];
      const oldMid = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
      const newMid = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
      const distance = Math.hypot(previous.x - other.x, previous.y - other.y);
      if (distance > 0) view = zoomAbout(view, Math.hypot(next.x - other.x, next.y - other.y) / distance, oldMid, s.frame, s.fitted);
      view = panBy(view, newMid.x - oldMid.x, newMid.y - oldMid.y, s.frame, s.fitted);
    } else view = panBy(view, next.x - previous.x, next.y - previous.y, s.frame, s.fitted);
    pointers.set(event.pointerId, next); paint();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    frame.addEventListener(name, event => {
      if (name === 'pointerup' && pointers.has(event.pointerId) && tapStart) {
        const now = performance.now(), at = point(event);
        if (now - tapStart.time < 300 && Math.hypot(at.x - tapStart.x, at.y - tapStart.y) < 8) {
          if (lastTap && now - lastTap.time < 350 && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < 24) {
            const s = sizes(); view = toggleZoom(view, at, s.frame, s.fitted); paint(); lastTap = null;
          } else lastTap = { ...at, time: now };
        }
      }
      tapStart = null; pointers.delete(event.pointerId);
    });
  }
  frame.addEventListener('wheel', event => {
    event.preventDefault(); const s = sizes();
    view = zoomAbout(view, Math.exp(-event.deltaY * .002), point(event), s.frame, s.fitted); paint();
  }, { passive: false });
  frame.addEventListener('dblclick', event => {
    if (performance.now() - lastTouch < 500) return;
    event.preventDefault(); const s = sizes(); view = toggleZoom(view, point(event), s.frame, s.fitted); paint();
  });
  // iOS Safari may additionally emit gesture events. Keep these within the image.
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    frame.addEventListener(name, event => event.preventDefault(), { passive: false });
  }
  fit.addEventListener('click', reset);
  new ResizeObserver(() => { pointers.clear(); paint(); }).observe(frame);
  new MutationObserver(paint).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
  paint();
  return reset;
}
