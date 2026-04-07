/**
 * LLM Scrub — Background Service Worker
 * Handles badge count updates and cross-component messaging.
 */

// Maximum number of paste-scrub log entries retained per tab in session storage.
const MAX_LOG_ENTRIES = 100;

// Track replacement counts per tab (in-memory; used by popup)
const tabCounts = {};
// Last known origin per tab — used to distinguish SPA route changes from
// cross-domain navigations. Only the latter clears the scrub log and badge.
const tabOrigins = {};

// Per-tab operation queue — serialises concurrent read-modify-write operations
// on chrome.storage.session so rapid pastes and typing-replaced events never
// race against each other on the same tab's storage keys.
const tabQueues = new Map();

function enqueueTabOp(tabId, op) {
  const prev = tabQueues.get(tabId) || Promise.resolve();
  const next = prev.then(() => new Promise((resolve) => op(resolve)));
  tabQueues.set(tabId, next);
  // Clean up the Map entry once the chain settles so it doesn't grow forever.
  // Suppress errors so a rejected op doesn't prevent future ones from running.
  next.catch(() => {}).then(() => {
    if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
  });
}

/**
 * Recalculate and apply the toolbar badge for a tab.
 * Count = unreviewed paste scrubs + active typing detections.
 * Color: orange (#FF9800) when any typing detections are present (more urgent);
 *        purple (#7c8aff) when only paste scrubs remain.
 */
function updateBadge(tabId) {
  chrome.storage.session.get(
    [`scrubBadge_${tabId}`, `typingDetections_${tabId}`],
    (data) => {
      const pasteCount  = data[`scrubBadge_${tabId}`] || 0;
      const typingCount = (data[`typingDetections_${tabId}`] || []).length;
      const total = pasteCount + typingCount;
      if (total === 0) {
        chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
        return;
      }
      chrome.action.setBadgeText({ text: String(total), tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({
        color: typingCount > 0 ? "#FF9800" : "#7c8aff",
        tabId,
      }).catch(() => {});
    }
  );
}

function isFromExtensionPage(sender) {
  return !sender.tab && sender.url?.startsWith("chrome-extension://");
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "replacements-made" && sender.tab) {
    const tabId = sender.tab.id;
    if (!tabCounts[tabId]) tabCounts[tabId] = 0;
    tabCounts[tabId] += message.count;
    // Badge is managed by the scrub-log handler below.
  }

  // Popup requesting count for active tab
  if (message.type === "getActiveTabCount") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        sendResponse({ count: tabCounts[tabs[0].id] || 0 });
      } else {
        sendResponse({ count: 0 });
      }
    });
    return true; // async response
  }

  // Content script reporting a completed scrub — store in session storage and
  // update the unreviewed-events badge.
  if (message.type === "scrub-log" && sender.tab) {
    const tabId = sender.tab.id;
    const logKey   = `scrubLog_${tabId}`;
    const badgeKey = `scrubBadge_${tabId}`;
    const entry = { timestamp: message.timestamp, replacements: message.replacements };

    enqueueTabOp(tabId, (done) => {
      chrome.storage.session.get([logKey, badgeKey], (data) => {
        const log        = data[logKey]   || [];
        const badgeCount = (data[badgeKey] || 0) + entry.replacements.length;

        log.unshift(entry); // newest first
        if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;

        chrome.storage.session.set({ [logKey]: log, [badgeKey]: badgeCount }, () => {
          if (chrome.runtime.lastError) {
            console.error("[Scrubby] scrub-log write failed:", chrome.runtime.lastError.message);
          }
          done();
          updateBadge(tabId);
          // Notify the side panel if it's open; ignore the error if it isn't.
          chrome.runtime.sendMessage({ type: "scrub-log-update", tabId }).catch(() => {});
        });
      });
    });
  }

  // Side panel requesting a typed-term replacement in the host page.
  if (message.type === "typing-replace") {
    if (!isFromExtensionPage(sender)) return;
    const { tabId, term, placeholder } = message;
    chrome.tabs.sendMessage(
      tabId,
      { type: "typing-replace", term, placeholder },
      (response) => {
        sendResponse(response || { success: false, error: "content script unreachable" });
      }
    );
    return true; // async sendResponse
  }

  // Side panel requesting a placeholder restore in the host page.
  if (message.type === "restore-original") {
    if (!isFromExtensionPage(sender)) return;
    const { tabId, placeholder, original } = message;
    chrome.tabs.sendMessage(
      tabId,
      { type: "restore-original", placeholder, original },
      (response) => {
        sendResponse(response || { success: false, error: "content script unreachable" });
      }
    );
    return true; // async sendResponse
  }

  // Side panel clearing the paste-scrub badge and log when the user clears the panel.
  // Removes both scrubBadge and scrubLog for the tab; typingDetections is handled
  // separately by clear-typing-detections. Background owns all storage removal.
  if (message.type === "clear-badge") {
    if (!isFromExtensionPage(sender)) return;
    const { tabId } = message;
    tabCounts[tabId] = 0;
    chrome.storage.session.remove([`scrubBadge_${tabId}`, `scrubLog_${tabId}`], () => {
      if (chrome.runtime.lastError) {
        console.error("[Scrubby] clear-badge remove failed:", chrome.runtime.lastError.message);
      }
      updateBadge(tabId);
    });
  }

  // Content script reporting terms detected while typing.
  if (message.type === "typing-detection" && sender.tab) {
    const tabId = sender.tab.id;
    const detectionsKey = `typingDetections_${tabId}`;
    const incoming = message.detections || [];

    enqueueTabOp(tabId, (done) => {
      chrome.storage.session.get([detectionsKey], (data) => {
        const existing = data[detectionsKey] || [];
        const now = Date.now();

        // Replace stored detections with the current scan result, preserving
        // timestamps for terms that were already detected.
        const merged = incoming.map((d) => {
          const prev = existing.find((e) => e.term === d.term);
          return {
            term: d.term,
            placeholder: d.placeholder,
            count: d.count,
            timestamp: prev ? prev.timestamp : now,
          };
        });

        chrome.storage.session.set({ [detectionsKey]: merged }, () => {
          if (chrome.runtime.lastError) {
            console.error("[Scrubby] typing-detection write failed:", chrome.runtime.lastError.message);
          }
          done();
          updateBadge(tabId);
          chrome.runtime.sendMessage({ type: "typing-detection-update", tabId }).catch(() => {});
        });
      });
    });
  }

  // Side panel: user chose to replace a typed detection — move it into the scrub log.
  if (message.type === "typing-replaced") {
    if (!isFromExtensionPage(sender)) return;
    const { tabId, term, placeholder, count = 1 } = message;
    const detectionsKey = `typingDetections_${tabId}`;
    const logKey        = `scrubLog_${tabId}`;
    const badgeKey      = `scrubBadge_${tabId}`;

    enqueueTabOp(tabId, (done) => {
      chrome.storage.session.get([detectionsKey, logKey, badgeKey], (data) => {
        const detections = data[detectionsKey] || [];
        // Remove all entries for this term — the replace handles every occurrence
        // in the field at once, so per-position filtering would leave duplicates.
        const filtered = detections.filter((d) => d.term !== term);

        // Promote to scrub log so it appears in the side panel history.
        const log = data[logKey] || [];
        const badgeCount = (data[badgeKey] || 0) + 1;
        log.unshift({
          timestamp: Date.now(),
          replacements: [{ placeholder, original: term, source: "typed" }],
        });
        if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;

        chrome.storage.session.set(
          { [detectionsKey]: filtered, [logKey]: log, [badgeKey]: badgeCount },
          () => {
            if (chrome.runtime.lastError) {
              console.error("[Scrubby] typing-replaced write failed:", chrome.runtime.lastError.message);
            }
            done();
            updateBadge(tabId);
            chrome.runtime.sendMessage({ type: "typing-detection-update", tabId }).catch(() => {});
            chrome.runtime.sendMessage({ type: "scrub-log-update", tabId }).catch(() => {});
          }
        );
      });
    });
  }

  // Side panel: clear all typing detections for a tab.
  if (message.type === "clear-typing-detections") {
    if (!isFromExtensionPage(sender)) return;
    const { tabId } = message;
    chrome.storage.session.remove(`typingDetections_${tabId}`, () => {
      if (chrome.runtime.lastError) {
        console.error("[Scrubby] clear-typing-detections remove failed:", chrome.runtime.lastError.message);
      }
      updateBadge(tabId);
      chrome.runtime.sendMessage({ type: "typing-detection-update", tabId }).catch(() => {});
    });
  }
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabCounts[tabId];
  delete tabOrigins[tabId];
  tabQueues.delete(tabId);
  chrome.storage.session.remove([
    `scrubLog_${tabId}`, `scrubBadge_${tabId}`, `typingDetections_${tabId}`,
  ], () => {
    if (chrome.runtime.lastError) {
      console.error("[Scrubby] tab cleanup remove failed:", chrome.runtime.lastError.message);
    }
  });
});

// On navigation: only reset popup counter and clear session data when the
// origin changes (cross-domain). SPA client-side route changes within the same
// origin preserve both the in-memory counter and the scrub log.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading") return;

  let newOrigin = null;
  try {
    if (tab.url) newOrigin = new URL(tab.url).origin;
  } catch (_) {}

  if (newOrigin !== tabOrigins[tabId]) {
    tabOrigins[tabId] = newOrigin;
    tabCounts[tabId] = 0;
    chrome.storage.session.remove([
      `scrubLog_${tabId}`, `scrubBadge_${tabId}`, `typingDetections_${tabId}`,
    ], () => {
      if (chrome.runtime.lastError) {
        console.error("[Scrubby] navigation cleanup remove failed:", chrome.runtime.lastError.message);
      }
    });
    chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
  }
});
