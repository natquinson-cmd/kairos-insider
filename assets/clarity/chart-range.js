(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KairosChartRange = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function checkRange(current, bounds) {
    if (!current || !bounds ||
        !Number.isSafeInteger(bounds.min) || !Number.isSafeInteger(bounds.max) ||
        bounds.max < bounds.min ||
        !Number.isSafeInteger(current.start) || !Number.isSafeInteger(current.end) ||
        current.start > current.end || current.start < bounds.min || current.end > bounds.max ||
        !Number.isSafeInteger(bounds.max - bounds.min + 1)) {
      throw new RangeError('Expected an inclusive integer range contained within valid bounds.');
    }
  }

  function checkFinite(value, name) {
    if (!Number.isFinite(value)) throw new TypeError(name + ' must be a finite number.');
  }

  /**
   * Zoom an inclusive range around the observation beneath the pointer.
   * Negative wheel delta zooms in. The pointer ratio runs left (0) to right (1).
   */
  function zoomWindow(current, bounds, delta, anchorRatio) {
    checkRange(current, bounds);
    checkFinite(delta, 'delta');
    checkFinite(anchorRatio, 'anchorRatio');
    const available = bounds.max - bounds.min + 1;
    const minimum = Math.min(5, available);
    const previousCount = current.end - current.start + 1;
    const factor = Math.exp(clamp(delta, -600, 600) * 0.0025);
    let nextCount = Math.round(previousCount * factor);

    // Trackpads can emit sub-pixel deltas; each nonzero gesture must still move.
    if (delta < 0) nextCount = Math.min(nextCount, previousCount - 1);
    if (delta > 0) nextCount = Math.max(nextCount, previousCount + 1);
    nextCount = clamp(nextCount, minimum, available);

    const anchor = clamp(anchorRatio, 0, 1);
    const observation = current.start + anchor * (previousCount - 1);
    const desiredStart = Math.round(observation - anchor * (nextCount - 1));
    const start = clamp(desiredStart, bounds.min, bounds.max - nextCount + 1);
    return { start, end: start + nextCount - 1 };
  }

  /** Move the visible range by observations, keeping its size at either edge. */
  function panWindow(current, bounds, shift) {
    checkRange(current, bounds);
    checkFinite(shift, 'shift');
    const span = current.end - current.start;
    const start = clamp(current.start + Math.round(shift), bounds.min, bounds.max - span);
    return { start, end: start + span };
  }

  return { zoomWindow, panWindow };
});
