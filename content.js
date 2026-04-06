/**
 * Scrubby — Content Script
 * Intercepts paste events on LLM sites and scrubs sensitive data
 * before it reaches the page's input fields.
 */

(function () {
  "use strict";

  const hostname = window.location.hostname;
  let isEnabled = false;
  let userTerms = [];
  let patternSettings = {};
  let emailReplacement = "";
  let lastActiveField = null;

  // Compiled regex cache for scanForTypedTerms — keyed by `${term}:${caseSensitive}:${isPartial}`.
  // Invalidated whenever userTerms changes in storage.
  let termRegexCache = new Map();

  // Typing monitor state
  let monitorTyping = false;
  let typingDebounceTimer = null;
  let recentlyPasted = false;
  let pasteSuppressionTimer = null;
  let lastTypingDetections = null;  // JSON fingerprint for change detection

  // Track the most recently focused input so restore can target it even after
  // the user clicks the side panel (which shifts focus away from the page).
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable
    ) {
      lastActiveField = el;
    }
  });
  // Load settings from storage
  function loadSettings() {
    chrome.storage.local.get(
      ["siteEnabled", "userTerms", "patternSettings", "emailReplacement", "monitorTyping"],
      (result) => {
        const siteEnabled = result.siteEnabled || {};
        isEnabled = siteEnabled[hostname] !== false;
        userTerms = result.userTerms || [];
        patternSettings = result.patternSettings || {};
        emailReplacement = result.emailReplacement || "";
        const shouldMonitor = result.monitorTyping === true;
        if (shouldMonitor !== monitorTyping) {
          monitorTyping = shouldMonitor;
          if (monitorTyping) attachTypingListener();
          else detachTypingListener();
        }
      }
    );
  }

  // Initial load
  loadSettings();

  // Listen for settings changes (when user updates via popup)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.siteEnabled) {
      const siteEnabled = changes.siteEnabled.newValue || {};
      isEnabled = siteEnabled[hostname] !== false;
    }
    if (changes.userTerms) {
      userTerms = changes.userTerms.newValue || [];
      termRegexCache = new Map();
    }
    if (changes.patternSettings)
      patternSettings = changes.patternSettings.newValue || {};
    if (changes.emailReplacement)
      emailReplacement = changes.emailReplacement.newValue || "";
    if (changes.monitorTyping) {
      const shouldMonitor = changes.monitorTyping.newValue === true;
      if (shouldMonitor !== monitorTyping) {
        monitorTyping = shouldMonitor;
        if (monitorTyping) attachTypingListener();
        else detachTypingListener();
      }
    }
  });

  /**
   * Main paste interceptor.
   * Captures the paste event before the page sees it, scrubs the content,
   * and inserts the cleaned version instead.
   */
  document.addEventListener(
    "paste",
    (event) => {
      // Suppress typing detection for 500 ms after any paste so we don't
      // double-process text that the paste handler already scrubbed.
      recentlyPasted = true;
      clearTimeout(pasteSuppressionTimer);
      pasteSuppressionTimer = setTimeout(() => { recentlyPasted = false; }, 500);

      if (!isEnabled) return;

      const clipboardData = event.clipboardData;
      if (!clipboardData) return;

      const text = clipboardData.getData("text/plain");
      if (!text) return;

      // Run the scrub
      const result = window.LLMScrubRules.scrub(
        text,
        userTerms,
        patternSettings,
        { emailReplacement }
      );

      // If nothing was replaced, let the paste go through normally
      if (result.replacements.length === 0) return;

      // Prevent the original paste
      event.preventDefault();
      event.stopImmediatePropagation();

      // Insert the scrubbed text
      const target = event.target;
      insertText(target, result.scrubbed);

      // Notify background script to update badge.
      // Guard against "Extension context invalidated" thrown in MV3 when the
      // extension is reloaded while a content script is still alive in a tab.
      try {
        chrome.runtime.sendMessage({
          type: "replacements-made",
          count: result.replacements.length,
        });
        chrome.runtime.sendMessage({
          type: "scrub-log",
          timestamp: Date.now(),
          replacements: [...result.replacements]
            .sort((a, b) => a.position - b.position)
            .map((r) => ({
              placeholder: r.replacement,
              original: r.original,
            })),
        });
      } catch (_) {}

      // Show toast notification
      showToast(result.replacements.length);
    },
    true // Capture phase — we get it before the page does
  );

  /**
   * Insert text into the active element.
   * Handles both regular inputs/textareas and contenteditable divs
   * (which is what most LLM chat interfaces use).
   */
  function insertText(target, text) {
    // Try execCommand first — works in most contenteditable contexts
    // and properly triggers the site's input event handlers
    if (document.queryCommandSupported("insertText")) {
      // Focus the target if it's not already focused
      target.focus();
      document.execCommand("insertText", false, text);
      return;
    }

    // Fallback: if target is input/textarea
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      const start = target.selectionStart || 0;
      const end = target.selectionEnd || 0;
      const before = target.value.substring(0, start);
      const after = target.value.substring(end);
      target.value = before + text + after;
      target.selectionStart = target.selectionEnd = start + text.length;

      // Dispatch input event so the page knows the value changed
      target.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // Fallback: contenteditable
    if (target.isContentEditable) {
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      // Dispatch input event
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  /**
   * Restore: replace all occurrences of a placeholder in the active field.
   * This is the only code path that intentionally puts original values into
   * the host page DOM — triggered solely by explicit user action in the
   * extension-owned side panel.
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "typing-replace") {
      const activeEl = document.activeElement;
      const field =
        lastActiveField ||
        (activeEl &&
         (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.isContentEditable)
          ? activeEl
          : null);

      if (!field) {
        sendResponse({ success: false, error: "no input field found" });
        return;
      }

      // detection.term may include a possessive suffix ("Acme's") because that
      // is the full matched text shown in the side panel.  Strip the suffix so
      // replaceTermInField can use the base term for its regex, then re-attach
      // the suffix to each replacement via the possessive capture group.
      const termBase = message.term.replace(/['\u2019]s$/i, "");

      // Look up match settings so we can mirror the detection behaviour exactly.
      const termDef = userTerms.find(
        (t) => t.term.toLowerCase() === termBase.toLowerCase()
      );
      const caseSensitive = termDef?.caseSensitive ?? false;
      const isPartial = termDef?.partialMatch === true;

      const replaced = replaceTermInField(
        field, termBase, message.placeholder, caseSensitive, isPartial
      );
      sendResponse({
        success: replaced,
        error: replaced ? null : "term not found in field",
      });

      if (replaced) {
        // Prevent the input event dispatched by the replacement from immediately
        // triggering a re-scan that would re-detect the just-replaced text.
        recentlyPasted = true;
        clearTimeout(pasteSuppressionTimer);
        pasteSuppressionTimer = setTimeout(() => { recentlyPasted = false; }, 500);
        clearTimeout(typingDebounceTimer);
        typingDebounceTimer = null;
        // Reset fingerprint so re-typed/restored terms are treated as fresh.
        lastTypingDetections = "";
      }
      return;
    }

    if (message.type === "toggle-typing-monitor") {
      const shouldMonitor = message.enabled === true;
      if (shouldMonitor !== monitorTyping) {
        monitorTyping = shouldMonitor;
        if (monitorTyping) attachTypingListener();
        else detachTypingListener();
      }
      return;
    }

    if (message.type !== "restore-original") return;

    const activeEl = document.activeElement;
    const field =
      activeEl &&
      (activeEl.tagName === "INPUT" ||
        activeEl.tagName === "TEXTAREA" ||
        activeEl.isContentEditable)
        ? activeEl
        : lastActiveField;

    if (!field) {
      sendResponse({ success: false, error: "no input field found" });
      return;
    }

    const replaced = restoreInField(field, message.placeholder, message.original);
    sendResponse({
      success: replaced,
      error: replaced ? null : "placeholder not found in field",
    });
    if (replaced) {
      // Suppress the input event the restore just dispatched — same as typing-replace.
      recentlyPasted = true;
      clearTimeout(pasteSuppressionTimer);
      pasteSuppressionTimer = setTimeout(() => { recentlyPasted = false; }, 500);
      clearTimeout(typingDebounceTimer);
      typingDebounceTimer = null;
      lastTypingDetections = "";
    }
  });

  function restoreInField(field, placeholder, original) {
    if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
      if (!field.value.includes(placeholder)) return false;
      field.value = field.value.split(placeholder).join(original);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    if (field.isContentEditable) {
      // Walk text nodes to replace in-place, preserving existing DOM structure
      // (line breaks, formatting) rather than clearing and re-inserting.
      const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.includes(placeholder)) nodes.push(node);
      }
      if (nodes.length === 0) return false;
      for (const n of nodes) {
        n.nodeValue = n.nodeValue.split(placeholder).join(original);
      }
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    return false;
  }

  /**
   * Replace all occurrences of `term` in `field` with `placeholder`.
   * Handles possessives ("Acme's", "Acme\u2019s") and case-insensitive matching.
   * Used by the typing-replace flow (side panel → background → here).
   */
  function replaceTermInField(field, term, placeholder, caseSensitive, isPartial = false) {
    if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
      const newValue = applyTermReplacement(
        field.value, term, placeholder, caseSensitive, isPartial
      );
      if (newValue === field.value) return false;
      field.value = newValue;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    if (field.isContentEditable) {
      const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      let anyReplaced = false;
      let node;
      while ((node = walker.nextNode())) {
        const newValue = applyTermReplacement(
          node.nodeValue, term, placeholder, caseSensitive, isPartial
        );
        if (newValue !== node.nodeValue) {
          node.nodeValue = newValue;
          anyReplaced = true;
        }
      }
      if (!anyReplaced) return false;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }

  /**
   * Apply term replacement to a plain string.
   * Whole-word mode: word-boundary anchors where applicable, possessive suffix
   * ('s / \u2019s) preserved in output.
   * Partial mode: matches the full non-whitespace word that contains the term
   * (mirrors the span-expansion logic in rules.js), preserving any possessive
   * suffix at the end of the containing word.
   */
  function applyTermReplacement(text, term, placeholder, caseSensitive, isPartial = false) {
    if (isPartial) {
      // Match the entire non-whitespace word that contains the term.
      // Capture an optional possessive suffix ('s / \u2019s) at the word end so
      // it can be preserved in the output (mirrors rules.js expansion logic).
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const flags = caseSensitive ? "g" : "gi";
      const regex = new RegExp(`\\S*${escaped}\\S*`, flags);
      return text.replace(regex, (match) => {
        const possMatch = match.match(/['\u2019][sS]$/);
        return possMatch ? placeholder + possMatch[0] : placeholder;
      });
    }

    // Whole-word path: use the shared pattern builder (same semantics as scrub
    // and scanForTypedTerms). match[1] is the bare term; the possessive suffix,
    // if any, is the remainder of match[0].
    const { regex, hasPossessiveGroup } = window.LLMScrubRules.buildTermPattern(
      term, caseSensitive, false
    );
    return text.replace(
      regex,
      (match, termPart) =>
        hasPossessiveGroup ? placeholder + match.slice(termPart.length) : placeholder
    );
  }

  // ---------------------------------------------------------------------------
  // Typing monitor
  // ---------------------------------------------------------------------------

  function attachTypingListener() {
    document.addEventListener("input", handleTypingInput);
  }

  function detachTypingListener() {
    document.removeEventListener("input", handleTypingInput);
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = null;
    lastTypingDetections = null;
  }

  function handleTypingInput(e) {
    if (!isEnabled) return;
    if (e.target !== lastActiveField) return;
    if (recentlyPasted) return;
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = setTimeout(scanForTypedTerms, 400);
  }

  function scanForTypedTerms() {
    if (!lastActiveField) return;

    const field = lastActiveField;
    let text;
    if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
      text = field.value;
    } else if (field.isContentEditable) {
      text = field.textContent;
    } else {
      return;
    }
    // Always proceed with empty text rather than returning early — an empty field
    // produces detections=[], which (when the fingerprint changed) is sent to
    // background to clear typingDetections_<tabId> and update the badge.
    text = text || "";

    // Build sorted terms only when there are any; the loop below is a no-op on
    // an empty array, naturally producing an empty detections list.
    const sortedTerms = userTerms.length
      ? [...userTerms].filter((t) => t.term).sort((a, b) => b.term.length - a.term.length)
      : [];

    const claimed = [];
    // Map from canonical term text → { replacement, count }
    const termCounts = new Map();

    for (const { term, partialMatch, caseSensitive = false, replacement } of sortedTerms) {
      const isPartial = partialMatch === true;
      const cacheKey = `${term}:${caseSensitive}:${isPartial}`;
      let cached = termRegexCache.get(cacheKey);
      if (!cached) {
        cached = window.LLMScrubRules.buildTermPattern(term, caseSensitive, isPartial);
        termRegexCache.set(cacheKey, cached);
      }
      const { regex, hasPossessiveGroup } = cached;
      // Reusing a cached /g regex — reset lastIndex before each scan.
      regex.lastIndex = 0;
      let match;

      while ((match = regex.exec(text)) !== null) {
        const mStart = match.index;
        const mEnd = hasPossessiveGroup
          ? mStart + match[1].length
          : mStart + match[0].length;

        // For partial-match terms, expand the claimed region to the full containing
        // word (non-whitespace run) so overlap detection matches the same span that
        // applyTermReplacement would replace.  Without this, two short partial terms
        // inside the same word both pass the overlap check and produce false detections.
        let spanStart = mStart;
        let spanEnd = mEnd;
        if (isPartial) {
          while (spanStart > 0 && !/\s/.test(text[spanStart - 1])) spanStart--;
          while (spanEnd < text.length && !/\s/.test(text[spanEnd])) spanEnd++;
        }

        if (claimed.some((c) => spanStart < c.end && spanEnd > c.start)) continue;

        claimed.push({ start: spanStart, end: spanEnd });
        // Key by the base term so all case/possessive variants group together.
        const key = term;
        const existing = termCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          termCounts.set(key, { replacement: replacement || null, count: 1, firstPos: mStart });
        }
      }
    }

    // Sort detected terms by first-occurrence position so placeholder numbers match
    // the document order that scrub() in rules.js assigns them.
    const detectedEntries = [];
    for (const { term } of sortedTerms) {
      const entry = termCounts.get(term);
      if (!entry) continue;
      detectedEntries.push({ term, entry });
    }
    detectedEntries.sort((a, b) => a.entry.firstPos - b.entry.firstPos);

    let termN = 0;
    const detections = [];
    for (const { term, entry } of detectedEntries) {
      detections.push({
        term,
        placeholder: entry.replacement ? entry.replacement : `[TERM_${++termN}]`,
        count: entry.count,
      });
    }

    // Only send if the detection set changed since the last scan.
    const fingerprint = JSON.stringify(detections);
    if (fingerprint === lastTypingDetections) return;
    lastTypingDetections = fingerprint;

    try {
      chrome.runtime.sendMessage({ type: "typing-detection", detections });
    } catch (_) {}
  }

  /**
   * Show a small, non-intrusive toast notification when replacements are made.
   */
  function showToast(count) {
    // Remove existing toast if any
    const existing = document.getElementById("llm-scrub-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "llm-scrub-toast";
    toast.textContent = `Scrubby: ${count} item${
      count !== 1 ? "s" : ""
    } scrubbed`;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add("llm-scrub-toast-visible");
    });

    // Auto-remove
    setTimeout(() => {
      toast.classList.remove("llm-scrub-toast-visible");
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
})();
