document.addEventListener("DOMContentLoaded", () => {
  // UI Elements
  const pipToggle = document.getElementById("pipToggle");
  const tabPauseToggle = document.getElementById("tabToggle");
  const timerSlider = document.getElementById("timerSetting");
  const timerValue = document.getElementById("timerValue");
  const whitelistItems = document.getElementById("whitelistItems");
  const themeToggle = document.getElementById("themeToggle");
  const navTabs = document.querySelectorAll(".nav-tab");
  // Phase 2 additions
  const statusTile = document.getElementById("statusTile");
  const statusTitle = document.getElementById("statusTitle");
  const statusSub = document.getElementById("statusSub");
  const statusTileIcon = document.getElementById("statusTileIcon");
  const detectionChip = document.getElementById("detectionChip");
  const applyNote = document.getElementById("applyNote");
  const whitelistToggleBtn = document.getElementById("whitelistToggleBtn");
  const snoozeBtn = document.getElementById("snoozeBtn");
  const snoozeMenu = document.getElementById("snoozeMenu");
  const modeAuto = document.getElementById("modeAuto");
  const modeManual = document.getElementById("modeManual");
  const addCurrentBtn = document.getElementById("addCurrentBtn");
  const removeCurrentBtn = document.getElementById("removeCurrentBtn");
  const nonFbHelper = document.getElementById("nonFbHelper");
  const openFbBtn = document.getElementById("openFbBtn");

  // Initialize theme
  initTheme();

  // Load saved settings + active tab in parallel
  Promise.all([
    new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs?.[0] || null))),
    new Promise(resolve => chrome.storage.local.get(["isEnabled", "tabPause", "timerInterval", "theme", "whitelist", "detectionMode", "detectionIntervalMs"], resolve))
  ]).then(async ([activeTab, data]) => {
      const isFacebook = !!(activeTab?.url && /https?:\/\/(www\.)?facebook\.com/i.test(activeTab.url));
      const currentUrl = activeTab?.url || '';

      pipToggle.checked = data.isEnabled || false;
      tabPauseToggle.checked = data.tabPause || false;

      const savedInterval = typeof data.detectionIntervalMs === 'number' ? data.detectionIntervalMs : (data.timerInterval || 1000);
      timerSlider.value = savedInterval;
      timerValue.textContent = savedInterval;

      const mode = data.detectionMode || 'manual';
      (mode === 'auto' ? modeAuto : modeManual).checked = true;
      setManualSliderDisabled(mode === 'auto');

      renderWhitelistList(data.whitelist);
      updateWhitelistUiForCurrent(currentUrl, data.whitelist);

  renderStatusTile({ isFacebook, isEnabled: pipToggle.checked, isWhitelisted: isUrlWhitelisted(currentUrl, data.whitelist), mode });
  await refreshSnoozeStatus();

  nonFbHelper.hidden = isFacebook;
  pipToggle.disabled = !isFacebook;
  tabPauseToggle.disabled = !isFacebook;
  whitelistToggleBtn.disabled = !isFacebook;
  snoozeBtn.disabled = !isFacebook;
  });

  // Tab navigation
  navTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const tabId = tab.getAttribute("data-tab");
      
      // Update active tab
      navTabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      
      // Show active content
      document.querySelectorAll(".tab-content").forEach(content => {
        content.classList.remove("active");
      });
      document.getElementById(`${tabId}-content`).classList.add("active");
    });
  });

  // Theme toggle
  themeToggle.addEventListener("click", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    const newTheme = currentTheme === "light" ? "dark" : "light";
    
    document.documentElement.setAttribute("data-theme", newTheme);
    themeToggle.innerHTML = newTheme === "light" 
      ? '<i class="fas fa-moon"></i>' 
      : '<i class="fas fa-sun"></i>';
    
    chrome.storage.local.set({ theme: newTheme });
  });

  // Core toggle handlers with instant apply
  pipToggle.addEventListener("change", async () => {
    const isEnabled = pipToggle.checked;
    chrome.storage.local.set({ isEnabled }, async () => {
      showToast(isEnabled ? "PiP Auto-Close enabled" : "PiP Auto-Close disabled");
      renderStatusTile(await computeStatus());
  await refreshSnoozeStatus();
      const applied = await sendSettingsUpdated({ isEnabled });
      if (!applied) noteReload();
    });
  });

  tabPauseToggle.addEventListener("change", async () => {
    const tabPause = tabPauseToggle.checked;
    chrome.storage.local.set({ tabPause }, async () => {
      showToast(tabPause ? "Tab Pause enabled" : "Tab Pause disabled");
      const applied = await sendSettingsUpdated({ tabPause });
      if (!applied) noteReload();
    });
  });

  // Timer settings (instant apply)
  timerSlider.addEventListener("input", () => {
    timerValue.textContent = timerSlider.value;
    const detectionIntervalMs = Number(timerSlider.value);
    chrome.storage.local.set({ timerInterval: detectionIntervalMs, detectionIntervalMs }, async () => {
      showToast(`Detection interval set to ${timerSlider.value}ms`);
      await sendSettingsUpdated({ detectionIntervalMs });
    });
  });

  // Detection mode radios
  ;[modeAuto, modeManual].forEach(r => r.addEventListener('change', async () => {
    const mode = modeAuto.checked ? 'auto' : 'manual';
    setManualSliderDisabled(mode === 'auto');
    detectionChip.textContent = `Detection: ${mode === 'auto' ? 'Auto' : 'Manual'}`;
    chrome.storage.local.set({ detectionMode: mode }, async () => {
      showToast(mode === 'auto' ? 'Detection: Auto (recommended)' : 'Detection: Manual');
      await sendSettingsUpdated({ detectionMode: mode });
    });
  }));

  // One-click whitelist toggle for current page
  whitelistToggleBtn.addEventListener('click', async () => {
    const { activeTab, whitelist } = await getActiveAndWhitelist();
    if (!activeTab?.url) return;
    const currentUrl = activeTab.url;
    const isWL = isUrlWhitelisted(currentUrl, whitelist);
    const next = toggleWhitelistEntry(whitelist, currentUrl, !isWL);
    await new Promise(r => chrome.storage.local.set({ whitelist: next }, r));
    renderWhitelistList(next);
    updateWhitelistUiForCurrent(currentUrl, next);
    renderStatusTile(await computeStatus());
  await refreshSnoozeStatus();
    await notifyWhitelistChange(currentUrl, !isWL);
    showToast(!isWL ? 'Added to whitelist' : 'Removed from whitelist');
  });

  // Snooze dropdown behavior
  snoozeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const expanded = snoozeBtn.getAttribute('aria-expanded') === 'true';
    snoozeBtn.setAttribute('aria-expanded', (!expanded).toString());
    snoozeMenu.hidden = expanded;
  });
  document.addEventListener('click', (e) => {
    if (!snoozeMenu.hidden && !snoozeMenu.contains(e.target) && e.target !== snoozeBtn) {
      snoozeMenu.hidden = true; snoozeBtn.setAttribute('aria-expanded', 'false');
    }
  });
  snoozeMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item) return;
    const kind = item.getAttribute('data-snooze');
    snoozeMenu.hidden = true; snoozeBtn.setAttribute('aria-expanded', 'false');
    const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    const tab = tabs?.[0]; if (!tab?.id) return;
    if (kind === 'cancel') {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'SNOOZE_CLEAR' }); showToast('Snooze cancelled'); } catch {}
      renderStatusTile(await computeStatus());
      await refreshSnoozeStatus();
      return;
    }
    if (kind === 'tab') {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'SNOOZE_SET', scope: 'tab' }); showToast('Snoozed until tab closes'); } catch {}
    } else {
      const until = Date.now() + (kind === '1h' ? 60*60*1000 : 15*60*1000);
      try { await chrome.tabs.sendMessage(tab.id, { type: 'SNOOZE_SET', until, scope: 'origin' }); showToast(kind === '1h' ? 'Snoozed for 1 hour' : 'Snoozed for 15 minutes'); } catch {}
    }
    renderStatusTile(await computeStatus());
    await refreshSnoozeStatus();
  });

  // Settings-tab whitelist links
  addCurrentBtn.addEventListener('click', async () => {
    const { activeTab, whitelist } = await getActiveAndWhitelist();
    if (!activeTab?.url) return;
    const next = toggleWhitelistEntry(whitelist, activeTab.url, true);
    await new Promise(r => chrome.storage.local.set({ whitelist: next }, r));
    renderWhitelistList(next);
    updateWhitelistUiForCurrent(activeTab.url, next);
    renderStatusTile(await computeStatus());
    await notifyWhitelistChange(activeTab.url, true);
  });

  removeCurrentBtn.addEventListener('click', async () => {
    const { activeTab, whitelist } = await getActiveAndWhitelist();
    if (!activeTab?.url) return;
    const next = toggleWhitelistEntry(whitelist, activeTab.url, false);
    await new Promise(r => chrome.storage.local.set({ whitelist: next }, r));
    renderWhitelistList(next);
    updateWhitelistUiForCurrent(activeTab.url, next);
    renderStatusTile(await computeStatus());
    await notifyWhitelistChange(activeTab.url, false);
  });

  // Send feedback via Email API
  document.getElementById("sendFeedback").addEventListener("click", async () => {
    const feedback = document.getElementById("feedbackText").value.trim();
    if (!feedback) return showToast("Please write your feedback before sending", "error");

    try {
      const res = await fetch("https://formspree.io/f/xrbqvzkn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: feedback,
          _replyto: "musfikurrahmandip@gmail.com",
        }),
      });

      if (res.ok) {
        showToast("Thanks for your feedback!");
        document.getElementById("feedbackText").value = "";
      } else {
        showToast("Failed to send feedback", "error");
      }
    } catch (error) {
      showToast("Network error, please try again", "error");
    }
  });

  // Helper functions
  function reloadCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) chrome.tabs.reload(tabs[0].id);
    });
  }

  function addWhitelistItem(url) {
    const item = document.createElement("div");
    item.className = "whitelist-item";
    item.innerHTML = `
      <span>${url}</span>
      <button class="remove-whitelist" data-url="${url}">
        <i class="fas fa-times"></i>
      </button>
    `;
    
    item.querySelector(".remove-whitelist").addEventListener("click", function() {
      const urlToRemove = this.getAttribute("data-url");
      chrome.storage.local.get(["whitelist"], (data) => {
        const whitelist = data.whitelist || [];
        const newWhitelist = whitelist.filter(item => item !== urlToRemove);
        chrome.storage.local.set({ whitelist: newWhitelist }, () => {
          item.remove();
          showToast("URL removed from whitelist");
          chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            const tab = tabs?.[0];
            if (tab?.id && tab.url && tab.url.includes(urlToRemove)) {
              await notifyWhitelistChange(tab.url, false);
              renderStatusTile(await computeStatus());
            }
          });
        });
      });
    });
    
    whitelistItems.appendChild(item);
  }

  function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
      toast.className = toast.className.replace("show", "");
    }, 3000);
  }

  function isUrlWhitelisted(url, list) {
    if (!Array.isArray(list)) return false;
    return list.some(entry => url.includes(entry));
  }

  function normalizeUrlForWhitelist(raw) {
    try {
      const u = new URL(raw);
      return `${u.origin}${u.pathname}`.replace(/\/$/, '');
    } catch { return raw; }
  }

  function toggleWhitelistEntry(whitelist, url, add) {
    const entry = normalizeUrlForWhitelist(url);
    const list = Array.isArray(whitelist) ? [...whitelist] : [];
    const exists = list.some(i => i === entry || url.includes(i));
    if (add) {
      if (!exists) list.push(entry);
    } else {
      return list.filter(i => i !== entry);
    }
    return list;
  }

  async function getActiveAndWhitelist() {
    const [tabs, store] = await Promise.all([
      new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r)),
      new Promise(r => chrome.storage.local.get(['whitelist'], r)),
    ]);
    return { activeTab: tabs?.[0] || null, whitelist: store.whitelist || [] };
  }

  function updateWhitelistUiForCurrent(url, whitelist) {
    const isWL = isUrlWhitelisted(url, whitelist);
    whitelistToggleBtn.textContent = isWL ? 'Remove from whitelist' : 'Allow PiP on this page';
  }

  function renderWhitelistList(list) {
    whitelistItems.innerHTML = '';
    (Array.isArray(list) ? list : []).forEach(url => addWhitelistItem(url));
  }

  async function computeStatus() {
    const [tabs, store] = await Promise.all([
      new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r)),
      new Promise(r => chrome.storage.local.get(['isEnabled','detectionMode','whitelist']), r)
    ]);
    const tab = tabs?.[0];
    const isFacebook = !!(tab?.url && /https?:\/\/(www\.)?facebook\.com/i.test(tab.url));
    const isWhitelisted = isUrlWhitelisted(tab?.url || '', store.whitelist || []);
    return { isFacebook, isEnabled: !!store.isEnabled, isWhitelisted, mode: store.detectionMode || 'manual', url: tab?.url || '' };
  }

  function renderStatusTile({ isFacebook, isEnabled, isWhitelisted, mode }) {
    const active = isFacebook && isEnabled && !isWhitelisted;
    if (isWhitelisted) {
      statusTitle.textContent = 'OFF on this page (whitelisted)';
      statusTileIcon.className = 'fas fa-ban';
      statusTile.style.borderColor = 'var(--border-color)';
    } else if (active) {
      statusTitle.textContent = 'Protected: ON';
      statusTileIcon.className = 'fas fa-shield-alt';
      statusTile.style.borderColor = 'var(--success-color)';
    } else {
      statusTitle.textContent = 'Protection: OFF';
      statusTileIcon.className = 'fas fa-shield-alt fa-slash';
      statusTile.style.borderColor = 'var(--danger-color)';
    }
    detectionChip.textContent = `Detection: ${mode === 'auto' ? 'Auto' : 'Manual'}`;
  }

  async function refreshSnoozeStatus() {
    const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    const tab = tabs?.[0]; if (!tab?.id) { statusSub.textContent = ''; return; }
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATE' });
      if (!res || !res.ok) { statusSub.textContent = ''; return; }
      if (res.isSnoozed) {
        if (res.snoozeScope === 'tab') {
          statusSub.textContent = 'Snoozed until tab closes';
        } else if (typeof res.snoozeUntil === 'number') {
          const mins = Math.max(1, Math.round((res.snoozeUntil - Date.now())/60000));
          statusSub.textContent = `Snoozed ~${mins} min left`;
        } else {
          statusSub.textContent = 'Snoozed';
        }
      } else {
        statusSub.textContent = '';
      }
    } catch { statusSub.textContent = ''; }
  }

  function initTheme() {
    chrome.storage.local.get(["theme"], (data) => {
      const savedTheme = data.theme || "light";
      document.documentElement.setAttribute("data-theme", savedTheme);
      
      themeToggle.innerHTML = savedTheme === "light" 
        ? '<i class="fas fa-moon"></i>' 
        : '<i class="fas fa-sun"></i>';
    });
  }

  function setManualSliderDisabled(disabled) {
    timerSlider.disabled = disabled;
    timerSlider.classList.toggle('disabled', disabled);
  }

  async function sendSettingsUpdated(patch) {
    const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    const tab = tabs?.[0];
    if (!tab?.id) return false;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', payload: patch });
      return !!(res && res.ok);
    } catch { return false; }
  }

  async function notifyWhitelistChange(url, isWhitelisted) {
    const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    const tab = tabs?.[0];
    if (!tab?.id) return false;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'WHITELIST_STATUS_CHANGED', url, isWhitelisted });
      return !!(res && res.ok);
    } catch { return false; }
  }

  function noteReload() {
    applyNote.hidden = false;
    requestAnimationFrame(() => {
      setTimeout(() => { applyNote.hidden = true; }, 2500);
    });
  }

  // Non-Facebook helper
  openFbBtn?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.facebook.com/' });
  });
});