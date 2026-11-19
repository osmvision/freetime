import { onDisplayChange } from './display.js';

// CSS zoom and the on-screen keyboard both change the usable space. Keep fixed
// panels and the application shell within the visual viewport, including on iOS.
export function initViewport() {
  const root = document.documentElement;
  function update() {
    const viewport = window.visualViewport;
    // Pinch zoom belongs to the browser. Avoid resizing the layout during a pinch.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const zoom = Number(root.style.zoom) || 1;
    root.style.setProperty('--viewport-height', `${(viewport?.height ?? window.innerHeight) / zoom}px`);
    root.style.setProperty('--viewport-top', `${(viewport?.offsetTop ?? 0) / zoom}px`);
    root.style.setProperty('--keyboard-inset', `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0)) / zoom}px`);
  }
  update();
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  onDisplayChange(update);
}
