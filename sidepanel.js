document.addEventListener("DOMContentLoaded", () => {
  const logContainer = document.getElementById("logContainer");
  const clearBtn = document.getElementById("clearBtn");
  let currentTabId = null;
  let disclaimerCollapsed = false;
  let renderDebounceTimer = null;
  let pendingScrollToTop = false;

  // --- Init ---
  // Load disclaimer state first so the first render is correct.

  chrome.storage.local.get(["typingDisclaimerCollapsed"], (data) => {
    disclaimerCollapsed = data.typingDisclaimerCollapsed === true;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        currentTabId = tabs[0].id;
        clearBadge(currentTabId);
        loadAndRender();
      }
    });
  });

  // Re-render when the user switches tabs
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    currentTabId = tabId;
    clearBadge(currentTabId);
    loadAndRender();
  });

  // Live updates from background — debounced so a typing-replaced event (which
  // broadcasts both scrub-log-update and typing-detection-update) triggers a
  // single render instead of two.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.tabId !== currentTabId) return;
    if (message.type === "scrub-log-update") {
      scheduleRender(/* scrollToTop= */ true);
    }
    if (message.type === "typing-detection-update") {
      scheduleRender();
    }
  });

  // --- Clear ---

  clearBtn.addEventListener("click", () => {
    if (currentTabId === null) return;
    // Render empty immediately; background owns all storage cleanup.
    render([], []);
    chrome.runtime.sendMessage({ type: "clear-badge", tabId: currentTabId }).catch(() => {});
    chrome.runtime.sendMessage({ type: "clear-typing-detections", tabId: currentTabId }).catch(() => {});
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
    if (tabId === null) { render([], []); return; }
    chrome.storage.session.get(
      [`scrubLog_${tabId}`, `typingDetections_${tabId}`],
      (data) => {
        const entries    = data[`scrubLog_${tabId}`]         || [];
        const detections = data[`typingDetections_${tabId}`] || [];
        render(detections, entries, scrollToTop);
      }
    );
  }

  // --- Render ---

  function render(detections, entries, scrollToTop = false) {
    clearBtn.disabled = detections.length === 0 && entries.length === 0;
    logContainer.innerHTML = "";

    if (detections.length === 0 && entries.length === 0) {
      logContainer.innerHTML =
        '<div class="sp-empty">No scrubs yet. Paste text on a supported site and Scrubby will log replacements here.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    if (detections.length > 0) {
      fragment.appendChild(buildDetectionsSection(detections));
    }

    for (const entry of entries) {
      fragment.appendChild(buildGroup(entry));
    }

    logContainer.appendChild(fragment);
    if (scrollToTop) logContainer.scrollTop = 0;
  }

  // --- Active Detections Section ---

  function buildDetectionsSection(detections) {
    const section = document.createElement("div");
    section.className = "sp-detections";

    // --- Header ---
    const header = document.createElement("div");
    header.className = "sp-detections-header";

    const warningIcon = document.createElement("span");
    warningIcon.className = "sp-detections-icon";
    warningIcon.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
      "</svg>";

    const title = document.createElement("span");
    title.className = "sp-detections-title";
    title.textContent = "Detected while typing";

    const infoBtn = document.createElement("button");
    infoBtn.className = "sp-disclaimer-toggle";
    infoBtn.title = disclaimerCollapsed ? "Show note" : "Collapse note";
    infoBtn.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="10"/>' +
      '<line x1="12" y1="8" x2="12" y2="12"/>' +
      '<line x1="12" y1="16" x2="12.01" y2="16"/>' +
      "</svg>";

    header.appendChild(warningIcon);
    header.appendChild(title);
    header.appendChild(infoBtn); // sits directly after the title text
    section.appendChild(header);

    // --- Disclaimer text (expandable below header, above detection rows) ---
    const disclaimerWrapper = document.createElement("div");
    disclaimerWrapper.className =
      "sp-disclaimer" + (disclaimerCollapsed ? " sp-disclaimer--collapsed" : "");

    const disclaimerText = document.createElement("p");
    disclaimerText.className = "sp-disclaimer-text";
    disclaimerText.textContent =
      "Note: Typing detection replaces terms before you send, but keystrokes " +
      "may have already been captured by the site. For strongest protection, " +
      "paste text instead of typing.";

    disclaimerWrapper.appendChild(disclaimerText);
    section.appendChild(disclaimerWrapper);

    infoBtn.addEventListener("click", () => {
      disclaimerCollapsed = !disclaimerCollapsed;
      disclaimerWrapper.classList.toggle("sp-disclaimer--collapsed", disclaimerCollapsed);
      infoBtn.title = disclaimerCollapsed ? "Show note" : "Collapse note";
      chrome.storage.local.set({ typingDisclaimerCollapsed: disclaimerCollapsed });
    });

    // --- Detection rows ---
    for (const detection of detections) {
      section.appendChild(buildDetectionRow(detection));
    }

    return section;
  }

  function buildDetectionRow(detection) {
    const row = document.createElement("div");
    row.className = "sp-detection-row";

    const term = document.createElement("span");
    term.className = "sp-detection-term";
    term.textContent = detection.count > 1
      ? `${detection.term} ×${detection.count}`
      : detection.term;
    term.title = detection.term;

    const arrow = document.createElement("span");
    arrow.className = "sp-arrow";
    arrow.textContent = "→";

    const ph = document.createElement("span");
    ph.className = "sp-placeholder";
    ph.textContent = detection.placeholder;
    ph.title = detection.placeholder;

    const replaceBtn = document.createElement("button");
    replaceBtn.className = "sp-replace-btn";
    replaceBtn.textContent = "Replace";

    replaceBtn.addEventListener("click", () => {
      replaceBtn.disabled = true;
      replaceBtn.textContent = "…";

      chrome.runtime.sendMessage(
        {
          type: "typing-replace",
          tabId: currentTabId,
          term: detection.term,
          placeholder: detection.placeholder,
        },
        (response) => {
          if (response?.success) {
            replaceBtn.textContent = "✓";
            replaceBtn.classList.add("sp-replace-btn--done");
            // Move detection into scrub log; background will broadcast
            // typing-detection-update + scrub-log-update → loadAndRender fires.
            chrome.runtime.sendMessage({
              type: "typing-replaced",
              tabId: currentTabId,
              term: detection.term,
              placeholder: detection.placeholder,
              count: detection.count,
            }).catch(() => {});
          } else {
            replaceBtn.disabled = false;
            replaceBtn.textContent = "Replace";
            replaceBtn.classList.add("sp-replace-btn--error");
            replaceBtn.title = response?.error || "Failed to replace";
            setTimeout(() => {
              replaceBtn.classList.remove("sp-replace-btn--error");
              replaceBtn.title = "";
            }, 2000);
          }
        }
      );
    });

    row.appendChild(term);
    row.appendChild(arrow);
    row.appendChild(ph);
    row.appendChild(replaceBtn);
    return row;
  }

  // --- Paste-scrub Groups ---

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

    // Right cluster: optional "typed" badge + item count
    const right = document.createElement("span");
    right.className = "sp-group-right";

    if (isTyped) {
      const typedBadge = document.createElement("span");
      typedBadge.className = "sp-typed-badge";
      typedBadge.textContent = "typed";
      right.appendChild(typedBadge);
    }

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
          restoreBtn.disabled = false;
          if (response?.success) {
            restoreBtn.textContent = "✓";
            restoreBtn.classList.add("sp-restore-btn--done");
            restoreBtn.title = "Restored!";
            setTimeout(() => {
              restoreBtn.innerHTML = restoreSvg;
              restoreBtn.classList.remove("sp-restore-btn--done");
              restoreBtn.title = "Restore original into page";
            }, 1500);
          } else {
            restoreBtn.textContent = "✗";
            restoreBtn.classList.add("sp-restore-btn--error");
            restoreBtn.title = response?.error || "Failed";
            setTimeout(() => {
              restoreBtn.innerHTML = restoreSvg;
              restoreBtn.classList.remove("sp-restore-btn--error");
              restoreBtn.title = "Restore original into page";
            }, 2000);
          }
        }
      );
    });

    row.appendChild(ph);
    row.appendChild(arrow);
    row.appendChild(orig);
    row.appendChild(copyBtn);
    row.appendChild(restoreBtn);
    return row;
  }

  // --- Helpers ---

  function clearBadge(tabId) {
    chrome.runtime.sendMessage({ type: "clear-badge", tabId });
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
