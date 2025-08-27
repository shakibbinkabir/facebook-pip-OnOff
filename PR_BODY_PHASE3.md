Title: v1.1 Phase 3: Snooze PiP + refined one‑click "Allow on this page"

Summary
- Added Snooze for PiP closure with three options: 15 minutes, 1 hour, and until tab closes.
- In‑page toast after auto‑closing PiP: "PiP closed • Undo (Snooze 15m)" with a single click to snooze for 15 minutes.
- Refined one‑click "Allow on this page" behavior using normalized URLs (origin + pathname without trailing slash), with dedupe.
- Live apply across the current tab via runtime messages; no reload needed for all settings including Snooze and whitelist.
- No new host permissions; storage uses session when available, falls back to local.

Details
Content script (content.js)
- Snooze state: snoozeUntil (timestamp), tabSnoozed (per‑tab flag), and showSnoozeToast (opt‑out flag, defaults to true).
- Early guard: detection pipeline short‑circuits while snoozed.
- Messages:
  - SNOOZE_SET { until?, scope: 'origin' | 'tab' }
  - SNOOZE_CLEAR
  - GET_PAGE_STATE -> { isWhitelisted, isSnoozed, snoozeUntil, snoozeScope }
- Storage: prefers chrome.storage.session for origin‑scoped snooze; falls back to chrome.storage.local.
- In‑page toast shown after a successful PiP close, with "Undo (Snooze 15m)" action.
- Whitelist gating simplified: always respected (no separate whitelistEnabled gate).

Popup UI (popup.html/js)
- Activated Snooze with a small dropdown menu: 15 minutes, 1 hour, until tab closes, and Cancel snooze.
- Status tile now shows a sub‑line with Snooze status and remaining time when active.
- One‑click whitelist continues to normalize URLs and applies instantly.
- Non‑Facebook pages: Snooze/controls disabled, helper shown.

Styling (style.css)
- Added minimal dropdown styles consistent with existing theme variables.

Acceptance criteria
- Snooze stops PiP auto‑closing until it expires or is cleared.
- Snooze "until tab closes" is per‑tab and not persisted.
- In‑page toast appears only after we auto‑close PiP and disappears in ~2.5s; clicking Undo sets a 15m snooze.
- Whitelist action applies immediately without reload; normalized and deduplicated URLs.
- No new permissions; extension remains MV3.

Test plan
1) Enable extension on a Facebook video feed.
2) Trigger PiP (e.g., scroll away or open a mini‑player) and verify it closes; notice the toast and try Undo.
3) From popup, set Snooze for 15m and verify status subtext shows remaining time and PiP no longer closes.
4) Use Cancel snooze and verify auto‑close resumes.
5) Set "until tab closes" snooze and reload page; verify snooze ends.
6) Add current page to whitelist, verify immediate stop; remove and verify immediate resume.
7) Switch Detection mode and Manual speed; verify live apply without reload.

Notes
- If chrome.storage.session is unavailable in content scripts on a given channel, the code automatically falls back to local storage with the same semantics.