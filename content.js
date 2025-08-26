// Content script with adaptive detection and hardened selectors
(function () {
  const DEBUG = false; // flip to true for verbose logs

  const log = (...args) => { if (DEBUG) console.log('[FB-PiP]', ...args); };
  const now = () => performance.now();

  // State and settings cache
  const state = {
    isEnabled: false,
    tabPause: false,
    detectionMode: 'manual', // 'auto' | 'manual'
    detectionIntervalMs: 1000,
    whitelistEnabled: false,
    whitelist: [],
    lastCloseAt: 0,
    cooldownMs: 1000,
    observersActive: false,
  };

  // Guard: whitelist check
  function isWhitelistedUrl() {
    if (!state.whitelistEnabled || !Array.isArray(state.whitelist) || state.whitelist.length === 0) return false;
    const currentUrl = location.href;
    return state.whitelist.some((entry) => currentUrl.includes(entry));
  }

  // Scheduler: adaptive ramp/backoff
  const scheduler = (() => {
    let timerId = null;
    let mode = 'idle'; // 'idle' | 'fast' | 'slow' | 'paused'
    const FAST_MS = 200;
    const SLOW_MS = 1200;
    const FAST_WINDOW_MS = 3000;
    const INIT_FAST_WINDOW_MS = 5000;
    let fastUntil = 0;
    let initializedAt = 0;

    const scheduleNext = (ms) => {
      clearTimer();
      // Prefer rAF + setTimeout combo to minimize jank
      const tick = () => {
        timerId = setTimeout(runTick, ms);
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(tick);
      } else {
        tick();
      }
    };

    function clearTimer() {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    }

    function runTick() {
      if (mode === 'paused' || document.hidden) return;
      tryDetect();
      const next = mode === 'fast' ? FAST_MS : (state.detectionMode === 'manual' ? state.detectionIntervalMs : SLOW_MS);
      scheduleNext(next);
    }

    function tryDetect() {
      // Multi-strategy PiP close attempt
      detector.closeMiniPlayerIfPresent();

      // Auto backoff when initial fast window elapsed and nothing found recently
      if (state.detectionMode === 'auto') {
        const t = now();
        if (mode === 'fast') {
          if (t > fastUntil) {
            backoff();
          }
        } else if (mode === 'slow' && t - initializedAt < INIT_FAST_WINDOW_MS) {
          // keep initial fast window logic consistent even if switched quickly
          rampFast(INIT_FAST_WINDOW_MS - (t - initializedAt));
        }
      }
    }

    function rampFast(windowMs = FAST_WINDOW_MS) {
      if (mode === 'paused') return;
      mode = 'fast';
      fastUntil = now() + windowMs;
      log('scheduler: ramp fast', { windowMs });
      scheduleNext(FAST_MS);
    }

    function backoff() {
      if (mode === 'paused') return;
      mode = state.detectionMode === 'manual' ? 'slow' : 'slow';
      log('scheduler: backoff to slow');
      scheduleNext(state.detectionMode === 'manual' ? state.detectionIntervalMs : SLOW_MS);
    }

    function start() {
      initializedAt = now();
      if (state.detectionMode === 'auto') {
        mode = 'fast';
        fastUntil = initializedAt + INIT_FAST_WINDOW_MS;
        log('scheduler: start fast init');
        scheduleNext(FAST_MS);
      } else {
        mode = 'slow';
        log('scheduler: start manual interval', { ms: state.detectionIntervalMs });
        scheduleNext(state.detectionIntervalMs);
      }
    }

    function pause() {
      mode = 'paused';
      log('scheduler: paused');
      clearTimer();
    }

    function resume() {
      if (mode !== 'paused') return;
      log('scheduler: resume');
      // On resume, ramp fast briefly for auto; otherwise continue slow/manual
      if (state.detectionMode === 'auto') rampFast(); else backoff();
    }

    function stop() {
      log('scheduler: stop');
      clearTimer();
      mode = 'idle';
    }

    function onStimulus() {
      if (state.detectionMode === 'auto') rampFast();
    }

    return { start, pause, resume, stop, backoff, rampFast, onStimulus };
  })();

  // Detector: multi-strategy
  const detector = (() => {
    const edgeBoxes = [
      // bottom-right, bottom-left, top-right, top-left typical PiP regions
      { x: 0.6, y: 0.6, w: 0.4, h: 0.4 },
      { x: 0.0, y: 0.6, w: 0.4, h: 0.4 },
      { x: 0.6, y: 0.0, w: 0.4, h: 0.4 },
      { x: 0.0, y: 0.0, w: 0.4, h: 0.4 },
    ];

    const CLOSE_SELECTOR_CANDIDATES = [
      '[role="button"][aria-label*="Close" i]',
      '[role="button"][aria-label*="Dismiss" i]',
      '[role="button"][aria-label*="Minimize" i]',
      'div[role="button"][tabindex]',
      'button[aria-label*="Close" i]',
      'button[aria-label*="Dismiss" i]'
    ];

    function inEdgeBox(rect, vw, vh) {
      return edgeBoxes.some(({ x, y, w, h }) => {
        const bx = x * vw, by = y * vh, bw = w * vw, bh = h * vh;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        return cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh;
      });
    }

    function isLikelyMiniPlayerContainer(el) {
      const style = el && window.getComputedStyle(el);
      if (!style) return false;
      if (style.position !== 'fixed') return false;
      const rect = el.getBoundingClientRect();
      // Small-ish heuristic: between ~160 and 480 in either dimension
      const min = 140, max = 520;
      const within = (v) => v >= min && v <= max;
      if (!(within(rect.width) || within(rect.height))) return false;
      // Within viewport
      if (rect.width <= 0 || rect.height <= 0) return false;
      // Edge bias
      if (!inEdgeBox(rect, window.innerWidth, window.innerHeight)) return false;
      return true;
    }

    function containsVideoOrWrapper(el) {
      if (!el) return false;
      if (el.querySelector('video')) return true;
      // Facebook wrappers: look for controls region or progress bar roles
      const cues = el.querySelector('[role="progressbar"], [data-video], [data-visualcompletion]');
      return !!cues;
    }

    function findCloseCandidate(container) {
      for (const sel of CLOSE_SELECTOR_CANDIDATES) {
        const btn = container.querySelector(sel);
        if (!btn) continue;
        const br = btn.getBoundingClientRect();
        const cr = container.getBoundingClientRect();
        // Heuristic: control should be inside container and near a corner/edge
        if (br.width > 0 && br.height > 0 && br.left >= cr.left && br.top >= cr.top && br.right <= cr.right + 2 && br.bottom <= cr.bottom + 2) {
          return btn;
        }
      }
      return null;
    }

    function strategyA_attributeAria() {
      const candidates = Array.from(document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"], [role="dialog"], [data-pagelet]'));
      for (const el of candidates) {
        if (!isLikelyMiniPlayerContainer(el)) continue;
        if (!containsVideoOrWrapper(el)) continue;
        const close = findCloseCandidate(el);
        if (close) return { container: el, control: close };
      }
      return null;
    }

    function strategyB_heuristicShape() {
      const all = Array.from(document.body.querySelectorAll('*'));
      // Filter quickly for fixed
      const fixed = all.filter((n) => {
        if (!(n instanceof HTMLElement)) return false;
        const s = getComputedStyle(n);
        return s.position === 'fixed';
      });
      for (const el of fixed) {
        if (!isLikelyMiniPlayerContainer(el)) continue;
        if (!containsVideoOrWrapper(el)) continue;
        const control = findCloseCandidate(el);
        if (control) return { container: el, control };
      }
      return null;
    }

    function strategyC_fallbackProximity() {
      const fixedContainers = Array.from(document.querySelectorAll('div, section, aside')).filter((el) => {
        const s = getComputedStyle(el);
        return s.position === 'fixed';
      });
      const vw = innerWidth, vh = innerHeight;
      for (const el of fixedContainers) {
        if (!isLikelyMiniPlayerContainer(el)) continue;
        const v = el.querySelector('video');
        if (!v || v.paused) continue; // only consider playing videos
        const rect = el.getBoundingClientRect();
        if (!inEdgeBox(rect, vw, vh)) continue;
        const control = findCloseCandidate(el);
        if (control) return { container: el, control };
      }
      return null;
    }

    function attemptClose(target) {
      if (!target) return false;
      const t = Date.now();
      if (t - state.lastCloseAt < state.cooldownMs) {
        return false; // cooldown
      }
      try {
        target.control.focus?.();
        target.control.click();
        state.lastCloseAt = t;
        log('PiP close click');
        return true;
      } catch (e) {
        return false;
      }
    }

    function closeMiniPlayerIfPresent() {
      // Strategy A
      let found = strategyA_attributeAria();
      if (!found) found = strategyB_heuristicShape();
      if (!found) found = strategyC_fallbackProximity();
      if (found) {
        attemptClose(found);
        return true;
      }
      return false;
    }

    return { closeMiniPlayerIfPresent };
  })();

  // Observers and event wiring
  const lifecycle = (() => {
    let mo = null;
    let scrollHandler = null;
    let playHandler = null;
    let visHandler = null;
    let throttledStimulus = null;

    function throttle(fn, ms) {
      let last = 0, tid;
      return function (...args) {
        const t = Date.now();
        const remaining = ms - (t - last);
        if (remaining <= 0) {
          last = t;
          fn.apply(this, args);
        } else if (!tid) {
          tid = setTimeout(() => {
            last = Date.now();
            tid = null;
            fn.apply(this, args);
          }, remaining);
        }
      };
    }

    function connect() {
      if (state.observersActive) return;
      state.observersActive = true;
      log('lifecycle: connect');

      throttledStimulus = throttle(() => scheduler.onStimulus(), 500);
      scrollHandler = () => throttledStimulus();
      window.addEventListener('scroll', scrollHandler, { passive: true });

      // Listen to play events on videos (capture phase to catch early)
      playHandler = (e) => {
        if (e.target && e.target.tagName === 'VIDEO') throttledStimulus();
      };
      document.addEventListener('play', playHandler, true);

      // DOM insertions
      mo = new MutationObserver((mutations) => {
        // Throttle reaction
        throttledStimulus();
      });
      mo.observe(document.body, { childList: true, subtree: true });

      // Tab visibility
      visHandler = () => {
        if (document.hidden) scheduler.pause(); else scheduler.resume();
      };
      document.addEventListener('visibilitychange', visHandler);
    }

    function disconnect() {
      if (!state.observersActive) return;
      log('lifecycle: disconnect');
      state.observersActive = false;
      if (mo) { mo.disconnect(); mo = null; }
      if (scrollHandler) { window.removeEventListener('scroll', scrollHandler); scrollHandler = null; }
      if (playHandler) { document.removeEventListener('play', playHandler, true); playHandler = null; }
      if (visHandler) { document.removeEventListener('visibilitychange', visHandler); visHandler = null; }
    }

    return { connect, disconnect };
  })();

  function startIfAllowed() {
    if (!state.isEnabled) { log('disabled'); return; }
    if (isWhitelistedUrl()) { log('whitelisted; skipping all'); return; }
    lifecycle.connect();
    scheduler.start();
  }

  // Pause/Play on Tab Switch (existing feature)
  function setupTabPause() {
    if (!state.tabPause) return;
    function pauseVideo() {
      const pauseBtn = document.querySelector('[aria-label="Pause"]');
      if (pauseBtn) {
        pauseBtn.click();
        log('Video paused due to tab switch');
      }
    }
    function playVideo() {
      const playBtn = document.querySelector('[aria-label="Play"]');
      if (playBtn) {
        playBtn.click();
        log('Video resumed due to tab focus');
      }
    }
    window.addEventListener('blur', pauseVideo);
    window.addEventListener('focus', playVideo);
  }

  // Load settings and init
  chrome.storage.local.get(
    [
      'isEnabled',
      'tabPause',
      'timerInterval', // legacy
      'whitelistEnabled',
      'whitelist',
      'detectionMode',
      'detectionIntervalMs'
    ],
    (data) => {
      state.isEnabled = !!data.isEnabled;
      state.tabPause = !!data.tabPause;
      state.whitelistEnabled = !!data.whitelistEnabled;
      state.whitelist = Array.isArray(data.whitelist) ? data.whitelist : [];
      state.detectionMode = data.detectionMode || 'manual';
      state.detectionIntervalMs = typeof data.detectionIntervalMs === 'number'
        ? data.detectionIntervalMs
        : (typeof data.timerInterval === 'number' ? data.timerInterval : 1000);

      log('init settings', { 
        isEnabled: state.isEnabled,
        detectionMode: state.detectionMode,
        detectionIntervalMs: state.detectionIntervalMs
      });

      setupTabPause();
      startIfAllowed();
    }
  );
})();
