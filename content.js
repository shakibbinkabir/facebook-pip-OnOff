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
  // Phase 3: Snooze state
  snoozeUntil: 0, // epoch ms; 0 means not snoozed
  tabSnoozed: false, // per-tab in-memory snooze until tab closes
  showSnoozeToast: true,
  };

  // Phase 4: Pattern utilities (shared with popup.js logic)
  function normalizeUrlForWhitelist(raw) {
    try {
      const u = new URL(raw);
      return `${u.origin}${u.pathname}`.replace(/\/$/, '');
    } catch { return raw; }
  }

  function patternToRegex(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const withWildcards = escaped.replace(/\*/g, '.*');
    return new RegExp(`^${withWildcards}$`);
  }

  function migrateWhitelistToNewFormat(oldWhitelist) {
    if (!Array.isArray(oldWhitelist)) return [];
    
    if (oldWhitelist.length > 0 && typeof oldWhitelist[0] === 'object' && oldWhitelist[0].type) {
      return oldWhitelist;
    }

    return oldWhitelist.map(url => ({
      type: 'exact',
      value: normalizeUrlForWhitelist(url),
      createdAt: Date.now()
    }));
  }

  // Compiled whitelist cache for performance
  const whitelistCache = {
    exactSet: new Set(),
    patternRegexes: [],
    lastUpdated: 0
  };

  function compileWhitelistCache(entries) {
    const migrated = migrateWhitelistToNewFormat(entries);
    whitelistCache.exactSet.clear();
    whitelistCache.patternRegexes.length = 0;
    
    migrated.forEach(entry => {
      if (entry.type === 'exact') {
        whitelistCache.exactSet.add(entry.value);
      } else if (entry.type === 'pattern') {
        try {
          const regex = patternToRegex(entry.value);
          whitelistCache.patternRegexes.push({ pattern: entry.value, regex });
        } catch (e) {
          log('Failed to compile pattern:', entry.value, e);
        }
      }
    });
    
    whitelistCache.lastUpdated = Date.now();
    log('Compiled whitelist cache:', whitelistCache.exactSet.size, 'exact,', whitelistCache.patternRegexes.length, 'patterns');
  }

  // Guard: whitelist check - Phase 4: Pattern-aware
  function isWhitelistedUrl() {
    if (!Array.isArray(state.whitelist) || state.whitelist.length === 0) return false;
    
    const currentUrl = normalizeUrlForWhitelist(location.href);
    
    // Check exact matches first (fastest)
    if (whitelistCache.exactSet.has(currentUrl)) {
      return true;
    }
    
    // Check pattern matches
    return whitelistCache.patternRegexes.some(({ regex }) => {
      try {
        return regex.test(currentUrl);
      } catch {
        return false;
      }
    });
  }

  function isSnoozed() {
    const now = Date.now();
    return state.tabSnoozed || (typeof state.snoozeUntil === 'number' && state.snoozeUntil > now);
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
      if (isSnoozed()) return; // short-circuit while snoozed
      // Multi-strategy PiP close attempt
      const closed = detector.closeMiniPlayerIfPresent();
      if (closed && state.showSnoozeToast) toast.showUndoSnooze();

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
  if (isSnoozed()) { log('snoozed; skipping all'); return; }
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

  // Load settings and init (Phase 3 adds snooze + toast flag)
  Promise.all([
    new Promise((r) => chrome.storage.local.get([
      'isEnabled',
      'tabPause',
      'timerInterval', // legacy
      'whitelistEnabled',
      'whitelist',
      'detectionMode',
      'detectionIntervalMs',
      'showSnoozeToast'
    ], r)),
    // session snooze (preferred for origin-scoped snooze)
    (chrome.storage.session && chrome.storage.session.get)
      ? new Promise((r) => chrome.storage.session.get(['snoozeUntil'], r))
      : Promise.resolve({}),
    // local fallback
    new Promise((r) => chrome.storage.local.get(['snoozeUntil'], r))
  ]).then(([data, sessionData, localData]) => {
    state.isEnabled = !!data.isEnabled;
    state.tabPause = !!data.tabPause;
    state.whitelistEnabled = !!data.whitelistEnabled;
    state.whitelist = Array.isArray(data.whitelist) ? data.whitelist : [];
    // Phase 4: Compile whitelist cache for pattern matching
    compileWhitelistCache(state.whitelist);
    state.detectionMode = data.detectionMode || 'manual';
    state.detectionIntervalMs = typeof data.detectionIntervalMs === 'number'
      ? data.detectionIntervalMs
      : (typeof data.timerInterval === 'number' ? data.timerInterval : 1000);
    state.showSnoozeToast = data.showSnoozeToast !== false;

    const su = (sessionData && typeof sessionData.snoozeUntil === 'number') ? sessionData.snoozeUntil
             : (localData && typeof localData.snoozeUntil === 'number') ? localData.snoozeUntil
             : 0;
    state.snoozeUntil = su || 0;

    log('init settings', {
      isEnabled: state.isEnabled,
      detectionMode: state.detectionMode,
      detectionIntervalMs: state.detectionIntervalMs,
      snoozeUntil: state.snoozeUntil,
      showSnoozeToast: state.showSnoozeToast
    });

    setupTabPause();
    startIfAllowed();
  });

  // Live updates via messages from popup/background
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message && message.type === 'SETTINGS_UPDATED') {
        const prevEnabled = state.isEnabled;
        const prevMode = state.detectionMode;
        const prevInterval = state.detectionIntervalMs;

        if (message.payload) {
          if (typeof message.payload.isEnabled === 'boolean') state.isEnabled = message.payload.isEnabled;
          if (typeof message.payload.tabPause === 'boolean') state.tabPause = message.payload.tabPause;
          if (typeof message.payload.detectionMode === 'string') state.detectionMode = message.payload.detectionMode;
          if (typeof message.payload.detectionIntervalMs === 'number') state.detectionIntervalMs = message.payload.detectionIntervalMs;
        }

        // Update tab pause listeners
        // Simpler approach: re-run setup (listeners internally guard duplicates)
        // For this phase, we won't remove old handlers explicitly beyond lifecycle connections.

        // Apply changes to scheduler/lifecycle without reload
        const wasActive = prevEnabled && !isWhitelistedUrl();
        const shouldBeActive = state.isEnabled && !isWhitelistedUrl();

        if (wasActive && !shouldBeActive) {
          // Turn off
          lifecycle.disconnect();
          scheduler.stop();
        } else if (!wasActive && shouldBeActive) {
          // Turn on
          lifecycle.connect();
          scheduler.start();
        } else if (shouldBeActive) {
          // Still active; if mode/interval changed, restart scheduler to apply
          if (prevMode !== state.detectionMode || prevInterval !== state.detectionIntervalMs) {
            scheduler.stop();
            scheduler.start();
          }
        }

        sendResponse({ ok: true, applied: true });
        return; // no async work
      }

      if (message && message.type === 'WHITELIST_STATUS_CHANGED') {
        // Phase 4: Recompile cache and check current page status
        if (message.newWhitelist) {
          state.whitelist = message.newWhitelist;
          compileWhitelistCache(state.whitelist);
        }
        
        // Check if current page is now whitelisted
        const isNowWhitelisted = isWhitelistedUrl();
        
        if (isNowWhitelisted) {
          lifecycle.disconnect();
          scheduler.stop();
          sendResponse({ ok: true, applied: true, stopped: true });
        } else {
          if (state.isEnabled && !isSnoozed()) {
            lifecycle.connect();
            scheduler.start();
            sendResponse({ ok: true, applied: true, started: true });
          } else {
            sendResponse({ ok: true, applied: false });
          }
        }
        return;
      }

      // Phase 3: Snooze controls
      if (message && message.type === 'SNOOZE_SET') {
        const { until, scope } = message;
        const t = Number(until) || 0;
        if (scope === 'tab') {
          state.tabSnoozed = true;
          lifecycle.disconnect();
          scheduler.stop();
          sendResponse({ ok: true, applied: true, scope: 'tab' });
          return;
        }
        // origin-wide snooze stored in session if available, else local
        const payload = { snoozeUntil: t };
        if (chrome.storage.session && chrome.storage.session.set) {
          chrome.storage.session.set(payload);
        } else {
          chrome.storage.local.set(payload);
        }
        state.snoozeUntil = t;
        lifecycle.disconnect();
        scheduler.stop();
        sendResponse({ ok: true, applied: true, scope: 'origin' });
        return;
      }

      if (message && message.type === 'SNOOZE_CLEAR') {
        state.tabSnoozed = false;
        if (chrome.storage.session && chrome.storage.session.set) chrome.storage.session.set({ snoozeUntil: 0 });
        chrome.storage.local.set({ snoozeUntil: 0 });
        if (state.isEnabled && !isWhitelistedUrl()) {
          lifecycle.connect();
          scheduler.start();
        }
        sendResponse({ ok: true, cleared: true });
        return;
      }

      if (message && message.type === 'GET_PAGE_STATE') {
        sendResponse({
          ok: true,
          isWhitelisted: isWhitelistedUrl(),
          isSnoozed: isSnoozed(),
          snoozeUntil: state.snoozeUntil,
          snoozeScope: state.tabSnoozed ? 'tab' : (state.snoozeUntil > Date.now() ? 'origin' : null)
        });
        return;
      }

      if (message && message.type === 'PING') {
        sendResponse({ ok: true, alive: true });
        return;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  });

  // Phase 3: Minimal in-page toast for quick snooze undo
  const toast = (() => {
    const ID = 'fbpip-toast';
    function remove() {
      const el = document.getElementById(ID);
      if (el) el.remove();
    }
    function showUndoSnooze() {
      try {
        remove();
        const el = document.createElement('div');
        el.id = ID;
        el.style.cssText = [
          'position:fixed',
          'right:16px',
          'bottom:16px',
          'z-index:2147483647',
          'background:rgba(32,32,32,0.92)',
          'color:#fff',
          'padding:8px 12px',
          'border-radius:999px',
          'font:500 12px system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Helvetica,Arial,sans-serif',
          'box-shadow:0 2px 8px rgba(0,0,0,0.2)',
          'display:flex',
          'gap:8px',
          'align-items:center'
        ].join(';');
        const msg = document.createElement('span');
        msg.textContent = 'PiP closed •';
        const btn = document.createElement('button');
        btn.textContent = 'Undo (Snooze 15m)';
        btn.style.cssText = 'background:none;border:none;color:#4ea1ff;cursor:pointer;font:inherit;text-decoration:underline;';
        btn.addEventListener('click', () => {
          const until = Date.now() + 15 * 60 * 1000;
          chrome.runtime.sendMessage({ type: 'SNOOZE_SET', until, scope: 'origin' }, () => {});
          remove();
        });
        el.appendChild(msg);
        el.appendChild(btn);
        document.documentElement.appendChild(el);
        setTimeout(remove, 2500);
      } catch {}
    }
    return { showUndoSnooze };
  })();
})();
