// Pointer drags that follow the pressed pointer on the window from press to release (the Positions
// table's header moves and column sizing, the watchlist's rows and groups), not HTML drag and drop,
// whose system drag session Electron does not always give a real mouse.

/**
 * Swallows the click the release of a drag would cause (a sort on the header under it, a row
 * opened or selected). The browser sends it in the same task as the release, so a later click is
 * left alone.
 */
export function swallowClick(): void {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
}

/**
 * Follows a pressed pointer on the window until it is released, wherever it goes: neither the
 * pressed element staying under the pointer nor its pointer capture is relied on (a capture that does
 * not hold would leave the gesture behind at the element's edge, and its release unseen). `move` gets
 * each move; `end` gets the release, or null when the gesture is undone: by Escape, the window losing
 * the focus or a context menu opening (the release is still waited for, and its click swallowed: it
 * goes to the window the press was in, and would sort the header under it), or by a pointercancel
 * (no release follows). A release that never comes (it went to another window) is given up at the
 * pointer's next press. The moves' `buttons` are not read: input that reports none while the button
 * is down must not end the gesture. Returns what stops following (unmount).
 */
export function followPointer(pointerId: number, move: (e: globalThis.PointerEvent) => void, end: (e: globalThis.PointerEvent | null) => void): () => void {
  let cancelled = false;
  const onMove = (e: globalThis.PointerEvent) => {
    if (e.pointerId === pointerId) move(e);
  };
  const onUp = (e: globalThis.PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    if (cancelled) swallowClick();
    else end(e);
  };
  const onCancel = (e: globalThis.PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    if (!cancelled) end(null);
  };
  // A new press of the pointer while an undone gesture waits for its release: that release was missed.
  const onDown = (e: globalThis.PointerEvent) => {
    if (e.pointerId === pointerId) stop();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // The Escape is the gesture's: it closes nothing else.
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  /** Undoes the gesture now; its release is still waited for (onUp swallows its click). */
  function cancel() {
    if (cancelled) return;
    cancelled = true;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('contextmenu', cancel, true);
    window.removeEventListener('blur', cancel);
    window.addEventListener('pointerdown', onDown, true);
    end(null);
  }
  function stop() {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('contextmenu', cancel, true);
    window.removeEventListener('blur', cancel);
  }
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('contextmenu', cancel, true);
  window.addEventListener('blur', cancel);
  return stop;
}
