/**
 * LLM Scrub — Background Service Worker
 * Handles badge count updates and cross-component messaging.
 */

// Maximum number of paste-scrub log entries retained per tab in session storage.
const MAX_LOG_ENTRIES = 100;
// Maximum replacements stored per log entry. Prevents a single large paste from
// consuming most of the session storage quota (10 MB per extension in MV3).
const MAX_REPLACEMENTS_PER_ENTRY = 50;

// Track replacement counts per tab (in-memory; used by popup)
const tabCounts = {};
// Last known origin per tab — used to distinguish SPA route changes from
// cross-domain navigations. Only the latter clears the scrub log and badge.
const tabOrigins = {};
// Tabs that have already received the log-full warning toast this session.
// Reset on tab close and cross-origin navigation so the user gets one warning
// per session per tab, not one per failed write.
const logFullToastSent = new Set();

// Per-tab operation queue — serialises concurrent read-modify-write operations
// on chrome.storage.session so rapid paste events never
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
 * Count = unreviewed scrubs (paste and typed). Color: purple (#7c8aff).
 */
function updateBadge(tabId) {
  chrome.storage.session.get([`scrubBadge_${tabId}`], (data) => {
    const count = data[`scrubBadge_${tabId}`] || 0;
    if (count === 0) {
      chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
      return;
    }
    chrome.action.setBadgeText({ text: String(count), tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#7c8aff", tabId }).catch(() => {});
  });
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
    const rawReplacements = message.replacements;
    const truncated = rawReplacements.length > MAX_REPLACEMENTS_PER_ENTRY;
    const entry = {
      timestamp: message.timestamp,
      replacements: truncated ? rawReplacements.slice(0, MAX_REPLACEMENTS_PER_ENTRY) : rawReplacements,
      ...(truncated && { truncated: true }),
    };

    enqueueTabOp(tabId, (done) => {
      chrome.storage.session.get([logKey, badgeKey], (data) => {
        const log        = data[logKey]   || [];
        const badgeCount = (data[badgeKey] || 0) + entry.replacements.length;

        log.unshift(entry); // newest first
        if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;

        chrome.storage.session.set({ [logKey]: log, [badgeKey]: badgeCount }, () => {
          if (chrome.runtime.lastError) {
            console.error("[Scrubby] scrub-log write failed:", chrome.runtime.lastError.message);
            if (!logFullToastSent.has(tabId)) {
              logFullToastSent.add(tabId);
              chrome.tabs.sendMessage(tabId, { type: "log-full-warning" }).catch(() => {});
            }
            done();
            return;
          }
          done();
          updateBadge(tabId);
          // Notify the side panel if it's open; ignore the error if it isn't.
          chrome.runtime.sendMessage({ type: "scrub-log-update", tabId }).catch(() => {});
        });
      });
    });
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

  // Side panel clearing the unreviewed badge count on tab switch or panel open.
  // Only clears the badge — the log is preserved so switching back shows history.
  if (message.type === "clear-badge") {
    if (!isFromExtensionPage(sender)) return;
    const { tabId } = message;
    tabCounts[tabId] = 0;
    // Serialise through enqueueTabOp so this remove cannot race with an
    // in-flight scrub-log read-modify-write that would re-create the badge key.
    enqueueTabOp(tabId, (done) => {
      chrome.storage.session.remove([`scrubBadge_${tabId}`], () => {
        if (chrome.runtime.lastError) {
          console.error("[Scrubby] clear-badge remove failed:", chrome.runtime.lastError.message);
        }
        done();
        updateBadge(tabId);
      });
    });
  }

  // Side panel: user clicked Clear — remove the log for this tab.
  if (message.type === "clear-log") {
    if (!isFromExtensionPage(sender)) return;
    const { tabId } = message;
    chrome.storage.session.remove([`scrubLog_${tabId}`], () => {
      if (chrome.runtime.lastError) {
        console.error("[Scrubby] clear-log remove failed:", chrome.runtime.lastError.message);
      }
    });
  }

});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabCounts[tabId];
  delete tabOrigins[tabId];
  tabQueues.delete(tabId);
  logFullToastSent.delete(tabId);
  chrome.storage.session.remove([`scrubLog_${tabId}`, `scrubBadge_${tabId}`], () => {
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
    logFullToastSent.delete(tabId);
    chrome.storage.session.remove([`scrubLog_${tabId}`, `scrubBadge_${tabId}`], () => {
      if (chrome.runtime.lastError) {
        console.error("[Scrubby] navigation cleanup remove failed:", chrome.runtime.lastError.message);
      }
    });
    chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
  }
});
