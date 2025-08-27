// Extension state
let isEnabled = false;
let tabPause = false;
let whitelistEnabled = false;
let whitelist = [];
let detectionMode = 'manual'; // 'auto' | 'manual' (default preserved for existing users)
let detectionIntervalMs = 1000; // manual mode interval

// Phase 4: Pattern utilities for context menu
function normalizeUrlForWhitelist(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.replace(/\/$/, '');
  } catch { return raw; }
}

function suggestPatternForUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('facebook.com')) return null;
    
    const pathSegments = u.pathname.split('/').filter(Boolean);
    if (pathSegments.length === 0) return `${u.origin}/*`;

    if (pathSegments[0] === 'watch') {
      return `${u.origin}/watch/*`;
    }
    if (pathSegments.includes('videos')) {
      return `${u.origin}/*/videos/*`;
    }
    if (pathSegments[0] === 'groups') {
      return `${u.origin}/groups/*/*`;
    }
    
    return `${u.origin}/${pathSegments[0]}/*`;
  } catch {
    return null;
  }
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

function addWhitelistEntry(entries, type, value) {
  const normalized = type === 'pattern' ? value : normalizeUrlForWhitelist(value);
  const migrated = migrateWhitelistToNewFormat(entries);
  
  const isDuplicate = migrated.some(entry => 
    entry.type === type && entry.value === normalized
  );
  
  if (isDuplicate) return migrated;

  return [...migrated, {
    type,
    value: normalized,
    createdAt: Date.now()
  }];
}

function removeMatchingWhitelistEntry(entries, url) {
  const migrated = migrateWhitelistToNewFormat(entries);
  const normalizedUrl = normalizeUrlForWhitelist(url);
  
  // Find exact match first
  const exactMatch = migrated.find(entry => 
    entry.type === 'exact' && entry.value === normalizedUrl
  );
  
  if (exactMatch) {
    return migrated.filter(entry => entry !== exactMatch);
  }
  
  // Find pattern matches and remove the most specific (longest)
  const patternMatches = migrated.filter(entry => {
    if (entry.type !== 'pattern') return false;
    try {
      const regex = new RegExp(`^${entry.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return regex.test(normalizedUrl);
    } catch {
      return false;
    }
  });
  
  if (patternMatches.length > 0) {
    // Remove the longest (most specific) pattern
    const toRemove = patternMatches.reduce((longest, current) => 
      current.value.length > longest.value.length ? current : longest
    );
    return migrated.filter(entry => entry !== toRemove);
  }
  
  return migrated;
}

function validatePattern(pattern) {
  const errors = [];
  
  if (!pattern || typeof pattern !== 'string') {
    return { isValid: false, errors: ['Pattern cannot be empty'] };
  }

  if (!pattern.startsWith('https://www.facebook.com/')) {
    errors.push('Pattern must start with https://www.facebook.com/');
  }

  const allowedChars = /^[a-zA-Z0-9\-_\/:.*]*$/;
  if (!allowedChars.test(pattern)) {
    errors.push('Only letters, digits, \'-\', \'_\', \'/\', \':\', \'.\', \'*\' are allowed');
  }

  const pathPart = pattern.replace('https://www.facebook.com', '');
  if (!pathPart || pathPart === '/' || pathPart === '') {
    errors.push('Must include a path after https://www.facebook.com/');
  }

  return { isValid: errors.length === 0, errors };
}

function isUrlWhitelistedInBackground(url, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  
  const migrated = migrateWhitelistToNewFormat(entries);
  const normalizedUrl = normalizeUrlForWhitelist(url);
  
  // Check exact matches first
  const hasExact = migrated.some(entry => 
    entry.type === 'exact' && entry.value === normalizedUrl
  );
  if (hasExact) return true;
  
  // Check pattern matches
  return migrated.some(entry => {
    if (entry.type !== 'pattern') return false;
    try {
      const regex = new RegExp(`^${entry.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return regex.test(normalizedUrl);
    } catch {
      return false;
    }
  });
}

// Initialize default settings if first run
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(
    [
      "isEnabled",
      "tabPause",
      "timerInterval",
      "theme",
      "whitelistEnabled",
      "whitelist",
      "detectionMode",
      "detectionIntervalMs"
    ],
    (data) => {
      // Migration/defaults
      const isNewInstall = details?.reason === 'install';
      const isUpdate = details?.reason === 'update';

      // Migration rules:
      // - New installs: detectionMode='auto'
      // - Updates: preserve manual with existing timerInterval if present
      const inferredDetectionMode = data.detectionMode
        ? data.detectionMode
        : (isNewInstall ? 'auto' : 'manual');
      const inferredInterval = (typeof data.detectionIntervalMs === 'number')
        ? data.detectionIntervalMs
        : (typeof data.timerInterval === 'number' ? data.timerInterval : 1000);

      const settings = {
        isEnabled: data.isEnabled !== undefined ? data.isEnabled : false,
        tabPause: data.tabPause !== undefined ? data.tabPause : false,
        // Preserve timerInterval for backward compatibility with older popups
        timerInterval: typeof data.timerInterval === 'number' ? data.timerInterval : inferredInterval,
        detectionMode: inferredDetectionMode,
        detectionIntervalMs: inferredInterval,
        theme: data.theme || "light",
        whitelistEnabled: data.whitelistEnabled || false,
        whitelist: migrateWhitelistToNewFormat(data.whitelist || [])
      };

      // Save default/migrated settings
      chrome.storage.local.set(settings);

      // Update local variables
      isEnabled = settings.isEnabled;
      tabPause = settings.tabPause;
      whitelistEnabled = settings.whitelistEnabled;
      whitelist = settings.whitelist;
      detectionMode = settings.detectionMode;
      detectionIntervalMs = settings.detectionIntervalMs;

      // Update icon
      updateIcon();
      
      // Phase 4: Create context menus
      createContextMenus();
    }
  );
});

// Phase 4: Context menu functionality
function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'allow-pip-exact',
      title: 'Allow PiP on this page (exact)',
      contexts: ['page'],
      documentUrlPatterns: ['https://www.facebook.com/*']
    });
    
    chrome.contextMenus.create({
      id: 'allow-pip-pattern',
      title: 'Allow PiP for this section (pattern)',
      contexts: ['page'],
      documentUrlPatterns: ['https://www.facebook.com/*']
    });
    
    chrome.contextMenus.create({
      id: 'remove-whitelist',
      title: 'Remove whitelist for this page/section',
      contexts: ['page'],
      documentUrlPatterns: ['https://www.facebook.com/*']
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.url || !tab.id) return;
  
  try {
    const { whitelist } = await new Promise(r => chrome.storage.local.get(['whitelist'], r));
    let newWhitelist = [...(whitelist || [])];
    let message = '';
    
    switch (info.menuItemId) {
      case 'allow-pip-exact': {
        newWhitelist = addWhitelistEntry(newWhitelist, 'exact', tab.url);
        message = 'Page added to whitelist (exact)';
        break;
      }
      case 'allow-pip-pattern': {
        const suggestedPattern = suggestPatternForUrl(tab.url);
        if (suggestedPattern) {
          // Validate pattern before adding
          const validation = validatePattern(suggestedPattern);
          if (validation.isValid) {
            newWhitelist = addWhitelistEntry(newWhitelist, 'pattern', suggestedPattern);
            message = 'Section added to whitelist (pattern)';
          } else {
            message = 'Cannot create valid pattern for this URL';
          }
        } else {
          message = 'Cannot create pattern for this URL';
        }
        break;
      }
      case 'remove-whitelist': {
        const oldLength = migrateWhitelistToNewFormat(newWhitelist).length;
        newWhitelist = removeMatchingWhitelistEntry(newWhitelist, tab.url);
        const newLength = migrateWhitelistToNewFormat(newWhitelist).length;
        message = oldLength > newLength ? 'Whitelist entry removed' : 'No matching whitelist entry found';
        break;
      }
    }
    
    // Save changes and notify tab
    await new Promise(r => chrome.storage.local.set({ whitelist: newWhitelist }, r));
    
    // Update local state
    whitelist = newWhitelist;
    
    // Notify the tab immediately
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'WHITELIST_STATUS_CHANGED',
        url: tab.url,
        isWhitelisted: true, // Will be recalculated in content script
        newWhitelist: newWhitelist
      });
    } catch {}
    
  } catch (error) {
    console.error('Context menu handler error:', error);
  }
});

// Toggle enabled state
function toggleEnabled() {
  isEnabled = !isEnabled;
  chrome.storage.local.set({ isEnabled: isEnabled });
  updateIcon();
  updateActiveTabs();
}

// Update icon to reflect current state
function updateIcon() {
  // Define badge colors based on state
  let badgeColor = "#4267b2"; // Facebook blue
  let badgeText = "";
  
  if (isEnabled) {
    badgeText = "ON";
    badgeColor = "#45bd62"; // Green for active
  }
  
  // Apply icon and badge updates
  chrome.action.setIcon({ 
    path: {
      16: `icons/icon16${isEnabled ? "" : "-disabled"}.png`,
      32: `icons/icon32${isEnabled ? "" : "-disabled"}.png`,
      48: `icons/icon48${isEnabled ? "" : "-disabled"}.png`
    }
  });
  
  chrome.action.setTitle({
    title: isEnabled ? "Facebook PiP Blocker: Enabled" : "Facebook PiP Blocker: Disabled",
  });
  
  chrome.action.setBadgeText({ text: badgeText });
  chrome.action.setBadgeBackgroundColor({ color: badgeColor });
}

// Update all active Facebook tabs
function updateActiveTabs() {
  chrome.tabs.query({ url: "*://*.facebook.com/*" }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.reload(tab.id);
    });
  });
}

// Quick toggle with icon click (alternative to popup)
chrome.action.onClicked.addListener(() => {
  toggleEnabled();
});

// Load settings on startup
chrome.storage.local.get(
  ["isEnabled", "tabPause", "whitelistEnabled", "whitelist", "detectionMode", "detectionIntervalMs"], 
  (data) => {
    isEnabled = data.isEnabled || false;
    tabPause = data.tabPause || false;
    whitelistEnabled = data.whitelistEnabled || false;
    whitelist = migrateWhitelistToNewFormat(data.whitelist || []);
    detectionMode = data.detectionMode || 'manual';
    detectionIntervalMs = typeof data.detectionIntervalMs === 'number' ? data.detectionIntervalMs : 1000;
    updateIcon();
    
    // Phase 4: Create context menus on startup
    createContextMenus();
  }
);

// Listen for settings changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.isEnabled) {
    isEnabled = changes.isEnabled.newValue;
    updateIcon();
  }
  
  if (changes.tabPause) {
    tabPause = changes.tabPause.newValue;
  }
  
  if (changes.whitelistEnabled) {
    whitelistEnabled = changes.whitelistEnabled.newValue;
  }
  
  if (changes.whitelist) {
    whitelist = changes.whitelist.newValue || [];
    // Migrate legacy format if needed
    whitelist = migrateWhitelistToNewFormat(whitelist);
  }
  if (changes.detectionMode) {
    detectionMode = changes.detectionMode.newValue || 'manual';
  }
  if (changes.detectionIntervalMs) {
    detectionIntervalMs = typeof changes.detectionIntervalMs.newValue === 'number'
      ? changes.detectionIntervalMs.newValue
      : detectionIntervalMs;
  }
});

// Content script injection for Facebook pages
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url && 
    tab.url.match(/^https?:\/\/(www\.)?facebook\.com/i)
  ) {
    // Check if the URL is whitelisted
    let shouldRun = true;
    
    if (whitelistEnabled && whitelist && whitelist.length > 0) {
      shouldRun = !isUrlWhitelistedInBackground(tab.url, whitelist);
    }
    
    if (isEnabled || tabPause) {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["content.js"],
      });
    }
  }
});

// Track Facebook pages with videos to improve detection
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    isEnabled &&
    changeInfo.status === "complete" &&
    tab.url &&
    tab.url.match(/facebook\.com\/.+\/(videos|watch)/i)
  ) {
    // This is likely a video page, ensure our script is running
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"],
    });
  }
});
