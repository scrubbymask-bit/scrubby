document.addEventListener("DOMContentLoaded", () => {
  const logContainer = document.getElementById("logContainer");
  const clearBtn = document.getElementById("clearBtn");
  let currentTabId = null;
  let renderDebounceTimer = null;
  let pendingScrollToTop = false;

  // --- Init ---

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      currentTabId = tabs[0].id;
      clearBadge(currentTabId);
      loadAndRender();
    }
  });

  // Re-render when the user switches tabs
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    currentTabId = tabId;
    clearBadge(currentTabId);
    loadAndRender();
  });

  // Live updates from background.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.tabId !== currentTabId) return;
    if (message.type === "scrub-log-update") {
      scheduleRender(/* scrollToTop= */ true);
    }
  });

  // --- Clear ---

  clearBtn.addEventListener("click", () => {
    if (currentTabId === null) return;
    // Render empty immediately; background owns all storage cleanup.
    render([]);
    chrome.runtime.sendMessage({ type: "clear-badge", tabId: currentTabId }).catch(() => {});
    chrome.runtime.sendMessage({ type: "clear-log", tabId: currentTabId }).catch(() => {});
  });

  // --- Data ---

  function scheduleRender(scrollToTop = false) {
    if (scrollToTop) pendingScrollToTop = true;
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => {
      const scroll = pendingScrollToTop;
      pendingScrollToTop = false;
      loadAndRender(scroll);
    }, 50);
  }

  function loadAndRender(scrollToTop = false) {
    const tabId = currentTabId;
    if (tabId === null) { render([]); return; }
    chrome.storage.session.get([`scrubLog_${tabId}`], (data) => {
      // Tab may have changed while the storage read was in flight; discard stale results.
      if (tabId !== currentTabId) return;
      const entries = data[`scrubLog_${tabId}`] || [];
      render(entries, scrollToTop);
    });
  }

  // --- Render ---

  function render(entries, scrollToTop = false) {
    clearBtn.disabled = entries.length === 0;
    logContainer.innerHTML = "";

    if (entries.length === 0) {
      logContainer.innerHTML =
        '<div class="sp-empty">No scrubs yet. Paste text on a supported site and Scrubby will log replacements here.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      fragment.appendChild(buildGroup(entry));
    }
    logContainer.appendChild(fragment);
    if (scrollToTop) logContainer.scrollTop = 0;
  }

  // --- Scrub Log Groups ---

  function buildGroup(entry) {
    const group = document.createElement("div");
    group.className = "sp-group";

    const isTyped = entry.replacements.some((r) => r.source === "typed");

    const header = document.createElement("div");
    header.className = "sp-group-header";

    const chevron = document.createElement("span");
    chevron.className = "sp-chevron";

    const timeLabel = document.createElement("span");
    timeLabel.className = "sp-group-time";
    timeLabel.textContent = relativeTime(entry.timestamp);

    // Right cluster: source badge + item count
    const right = document.createElement("span");
    right.className = "sp-group-right";

    const sourceBadge = document.createElement("span");
    sourceBadge.className = "sp-source-badge";
    sourceBadge.textContent = isTyped ? "typed" : "pasted";
    right.appendChild(sourceBadge);

    const n = entry.replacements.length;
    const countBadge = document.createElement("span");
    countBadge.className = "sp-group-count";
    countBadge.textContent = `${n} ${n === 1 ? "item" : "items"}`;
    right.appendChild(countBadge);

    header.appendChild(chevron);
    header.appendChild(timeLabel);
    header.appendChild(right);

    const body = document.createElement("div");
    body.className = "sp-group-body";
    for (const { placeholder, original } of entry.replacements) {
      body.appendChild(buildRow(placeholder, original));
    }

    header.addEventListener("click", () => {
      group.classList.toggle("sp-group--collapsed");
    });

    group.appendChild(header);
    group.appendChild(body);
    return group;
  }

  function buildRow(placeholder, original) {
    const row = document.createElement("div");
    row.className = "sp-row";

    const ph = document.createElement("span");
    ph.className = "sp-placeholder";
    ph.textContent = placeholder;
    ph.title = placeholder;

    const arrow = document.createElement("span");
    arrow.className = "sp-arrow";
    arrow.textContent = "→";

    const orig = document.createElement("span");
    orig.className = "sp-original";
    orig.textContent = original;
    orig.title = original;

    const copyBtn = document.createElement("button");
    copyBtn.className = "sp-copy-btn";
    copyBtn.title = "Copy original";
    copyBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
      "</svg>";

    const copySvg = copyBtn.innerHTML;
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(original).then(() => {
        copyBtn.textContent = "✓";
        copyBtn.classList.add("sp-copy-btn--copied");
        copyBtn.title = "Copied!";
        setTimeout(() => {
          copyBtn.innerHTML = copySvg;
          copyBtn.classList.remove("sp-copy-btn--copied");
          copyBtn.title = "Copy original";
        }, 1500);
      });
    });

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "sp-restore-btn";
    restoreBtn.title = "Restore original into page";
    restoreBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
      '<path d="M3 3v5h5"/>' +
      "</svg>";

    const restoreSvg = restoreBtn.innerHTML;
    restoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      restoreBtn.disabled = true;
      chrome.runtime.sendMessage(
        { type: "restore-original", tabId: currentTabId, placeholder, original },
        (response) => {
          if (response?.success) {
            restoreBtn.disabled = false;
            restoreBtn.textContent = "✓";
            restoreBtn.classList.add("sp-restore-btn--done");
            restoreBtn.title = "Restored!";
            setTimeout(() => {
              restoreBtn.innerHTML = restoreSvg;
              restoreBtn.classList.remove("sp-restore-btn--done");
              restoreBtn.title = "Restore original into page";
            }, 1500);
          } else {
            // Keep disabled permanently — text is no longer in the field.
            // Copy button remains functional so the original value can still be retrieved.
            restoreBtn.textContent = "✗";
            restoreBtn.classList.add("sp-restore-btn--error");
            restoreBtn.title = response?.error || "Failed";
          }
        }
      );
    });

    row.appendChild(orig);
    row.appendChild(arrow);
    row.appendChild(ph);
    row.appendChild(copyBtn);
    row.appendChild(restoreBtn);
    return row;
  }

  // --- Helpers ---

  function clearBadge(tabId) {
    chrome.runtime.sendMessage({ type: "clear-badge", tabId }).catch(() => {});
  }

  function relativeTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10)  return "just now";
    if (s < 60)  return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)  return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
});
