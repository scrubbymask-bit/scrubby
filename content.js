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

  // Returns the text content of a field element, or "" if unrecognised.
  function getFieldText(field) {
    if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") return field.value;
    if (field.isContentEditable) return field.textContent;
    return "";
  }

  // Scan text for existing placeholder patterns and return the highest number seen
  // for each type, so new scrub events can continue numbering from where they left off.
  function scanMaxPlaceholderN(text) {
    const result = { term: 0, email: 0, phone: 0, creditCard: 0, ssn: 0 };
    let m;
    const termRe = /\[TERM_(\d+)\]/g;
    while ((m = termRe.exec(text)) !== null) {
      const n = +m[1]; if (n > result.term) result.term = n;
    }
    const builtinRe = /\[(PHONE|CREDIT_CARD|SSN)_(\d+)\]/g;
    while ((m = builtinRe.exec(text)) !== null) {
      const n = +m[2];
      if (m[1] === "PHONE"       && n > result.phone)      result.phone = n;
      else if (m[1] === "CREDIT_CARD" && n > result.creditCard) result.creditCard = n;
      else if (m[1] === "SSN"    && n > result.ssn)        result.ssn = n;
    }
    const emailRe = /user(\d+)@example\.com/g;
    while ((m = emailRe.exec(text)) !== null) {
      const n = +m[1]; if (n > result.email) result.email = n;
    }
    return result;
  }

  // Compiled regex cache for scanForTypedTerms — keyed by `${term}:${caseSensitive}:${isPartial}`.
  // Invalidated whenever userTerms changes in storage.
  let termRegexCache = new Map();

  // Typing monitor state
  let monitorTyping = false;
  let typingDebounceTimer = null;
  let recentlyPasted = false;
  let pasteSuppressionTimer = null;
  let lastTypingDetections = null;  // JSON fingerprint for change detection
  // Terms the user has explicitly restored via the side panel. Maps lowercase
  // term text → number of restored instances still exempt from auto-replace.
  // Cleared on submit (Enter) and when the field empties after submit.
  const restoredTermCounts = new Map();

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
      restoredTermCounts.clear();
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

      // Scan the current field content for existing placeholders so the new
      // scrub event continues numbering from where they left off, avoiding collisions.
      const startCounters = scanMaxPlaceholderN(getFieldText(event.target));

      // Run the scrub
      const result = window.LLMScrubRules.scrub(
        text,
        userTerms,
        patternSettings,
        { emailReplacement, startCounters }
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
    if (message.type === "toggle-typing-monitor") {
      const shouldMonitor = message.enabled === true;
      if (shouldMonitor !== monitorTyping) {
        monitorTyping = shouldMonitor;
        if (monitorTyping) attachTypingListener();
        else detachTypingListener();
      }
      return;
    }

    if (message.type === "log-full-warning") {
      showWarningToast();
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

    // Suppress BEFORE calling restoreInField — it dispatches an input event
    // synchronously, and handleTypingInput would schedule a scan if recentlyPasted
    // is still false at that point.
    recentlyPasted = true;
    clearTimeout(pasteSuppressionTimer);
    pasteSuppressionTimer = setTimeout(() => {
      recentlyPasted = false;
      // Any edits the user made during the suppression window couldn't schedule
      // a debounce scan, so counts in restoredTermCounts may be stale. Run one
      // reconciliation scan now to catch terms that were deleted during that window.
      if (monitorTyping && isEnabled && restoredTermCounts.size > 0 && lastActiveField) {
        scanForTypedTerms();
      }
    }, 500);
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = null;

    const restoreError = restoreInField(field, message.placeholder, message.original);
    sendResponse({ success: restoreError === null, error: restoreError });
    if (restoreError === null) {
      lastTypingDetections = "";
      // Increment the exemption count for any user term whose regex matches the
      // restored original, so the typing scanner doesn't immediately re-scrub it.
      for (const t of userTerms) {
        if (!t.term) continue;
        const isPartial = t.partialMatch !== undefined ? t.partialMatch === true : t.matchMode === "substring";
        const { regex } = window.LLMScrubRules.buildTermPattern(t.term, t.caseSensitive ?? false, isPartial);
        regex.lastIndex = 0;
        if (regex.test(message.original)) {
          const key = t.term.toLowerCase();
          restoredTermCounts.set(key, (restoredTermCounts.get(key) || 0) + 1);
        }
      }
    }
  });

  // Returns null on success, or an error string on failure.
  function restoreInField(field, placeholder, original) {
    if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
      if (!field.value.includes(placeholder)) return "Text no longer in field";
      const cursorPos = field.selectionStart ?? 0;
      const oldValue = field.value;
      field.value = oldValue.split(placeholder).join(original);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      const newCursor = mapCursorPosAfterRestore(oldValue, placeholder, original, cursorPos);
      field.setSelectionRange(newCursor, newCursor);
      return null;
    }

    if (field.isContentEditable) {
      // Walk text nodes to replace in-place, preserving existing DOM structure
      // (line breaks, formatting) rather than clearing and re-inserting.
      const cursorPos = getContentEditableCursorPos(field);
      const oldText = field.textContent;
      const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.includes(placeholder)) nodes.push(node);
      }
      if (nodes.length === 0) return "Text no longer in field";
      for (const n of nodes) {
        n.nodeValue = n.nodeValue.split(placeholder).join(original);
      }
      field.dispatchEvent(new Event("input", { bubbles: true }));
      if (cursorPos !== null) {
        setContentEditableCursorPos(
          field,
          mapCursorPosAfterRestore(oldText, placeholder, original, cursorPos)
        );
      }
      return null;
    }

    return "Text no longer in field";
  }

  /**
   * Replace all occurrences of `term` in `field` with `placeholder`.
   * Handles possessives ("Acme's", "Acme\u2019s") and case-insensitive matching.
   * Restores the cursor to the correct position after replacement.
   * Returns null on success, or an error string if the term was not found.
   */
  function replaceTermInField(field, term, placeholder, caseSensitive, isPartial = false, skipFirst = 0) {
    if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
      const cursorPos = field.selectionStart ?? 0;
      const oldValue = field.value;
      const skipRef = { remaining: skipFirst };
      const newValue = applyTermReplacement(oldValue, term, placeholder, caseSensitive, isPartial, skipRef);
      if (newValue === oldValue) return "Text no longer in field";
      field.value = newValue;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      const newCursor = mapCursorPosAfterTermReplacement(oldValue, term, placeholder, caseSensitive, isPartial, cursorPos, skipFirst);
      field.setSelectionRange(newCursor, newCursor);
      return null;
    }
    if (field.isContentEditable) {
      const cursorPos = getContentEditableCursorPos(field);
      const oldText = field.textContent;
      const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      // Share one skipRef across all text nodes so the skip budget is consumed
      // globally (first N occurrences across the whole field, not per node).
      const skipRef = { remaining: skipFirst };
      let anyReplaced = false;
      let node;
      while ((node = walker.nextNode())) {
        const newValue = applyTermReplacement(
          node.nodeValue, term, placeholder, caseSensitive, isPartial, skipRef
        );
        if (newValue !== node.nodeValue) {
          node.nodeValue = newValue;
          anyReplaced = true;
        }
      }
      if (!anyReplaced) return "Text no longer in field";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      if (cursorPos !== null) {
        setContentEditableCursorPos(
          field,
          mapCursorPosAfterTermReplacement(oldText, term, placeholder, caseSensitive, isPartial, cursorPos, skipFirst)
        );
      }
      return null;
    }
    return "Text no longer in field";
  }

  /**
   * Map a cursor position from pre-replacement to post-replacement coordinates
   * after replacing all occurrences of `term` with `placeholder`.
   * If the cursor was inside a replaced span, it lands at the end of the replacement.
   */
  function mapCursorPosAfterTermReplacement(oldText, term, placeholder, caseSensitive, isPartial, cursorPos, skipFirst = 0) {
    // Collect match spans in original coordinates.
    const spans = [];
    if (isPartial) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\S*${escaped}\\S*`, caseSensitive ? "g" : "gi");
      let m;
      while ((m = re.exec(oldText)) !== null) {
        const possMatch = m[0].match(/['\u2019][sS]$/);
        // The entire match (including any absorbed possessive) maps to placeholder + suffix.
        spans.push({
          origStart: m.index,
          origEnd: m.index + m[0].length,
          replLen: possMatch ? placeholder.length + possMatch[0].length : placeholder.length,
        });
      }
    } else {
      const { regex, hasPossessiveGroup } = window.LLMScrubRules.buildTermPattern(term, caseSensitive, false);
      let m;
      while ((m = regex.exec(oldText)) !== null) {
        if (hasPossessiveGroup && m[1]) {
          // Only the captured term (m[1]) is replaced; the possessive suffix is unchanged.
          spans.push({ origStart: m.index, origEnd: m.index + m[1].length, replLen: placeholder.length });
        } else {
          spans.push({ origStart: m.index, origEnd: m.index + m[0].length, replLen: placeholder.length });
        }
      }
    }

    let skipsRemaining = skipFirst;
    let shift = 0;
    for (const { origStart, origEnd, replLen } of spans) {
      if (skipsRemaining > 0) { skipsRemaining--; continue; } // this span was not replaced
      if (cursorPos <= origStart) break;
      if (cursorPos >= origEnd) {
        shift += replLen - (origEnd - origStart);
      } else {
        // Cursor was inside the replaced span — land at end of replacement.
        return origStart + shift + replLen;
      }
    }
    return cursorPos + shift;
  }

  /**
   * Map a cursor position after replacing all occurrences of `placeholder` with `original`.
   */
  function mapCursorPosAfterRestore(oldText, placeholder, original, cursorPos) {
    const delta = original.length - placeholder.length;
    let pos = 0;
    let shift = 0;
    while (true) {
      const idx = oldText.indexOf(placeholder, pos);
      if (idx === -1) break;
      if (cursorPos <= idx) break;
      if (cursorPos >= idx + placeholder.length) {
        shift += delta;
      } else {
        return idx + shift + original.length;
      }
      pos = idx + placeholder.length;
    }
    return cursorPos + shift;
  }

  /**
   * Get the cursor's absolute character offset within a contenteditable field.
   * Returns null if the selection is not inside the field.
   */
  function getContentEditableCursorPos(field) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!field.contains(range.startContainer)) return null;
    const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) return offset + range.startOffset;
      offset += node.nodeValue.length;
    }
    return null;
  }

  /**
   * Set the cursor to an absolute character offset within a contenteditable field.
   */
  function setContentEditableCursorPos(field, targetOffset) {
    const sel = window.getSelection();
    if (!sel) return;
    const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
    let remaining = targetOffset;
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.nodeValue.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= node.nodeValue.length;
    }
    // Past end of content — place at end of last node found.
    if (node) {
      const range = document.createRange();
      range.setStart(node, node.nodeValue.length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /**
   * Apply term replacement to a plain string.
   * Whole-word mode: word-boundary anchors where applicable, possessive suffix
   * ('s / \u2019s) preserved in output.
   * Partial mode: matches the full non-whitespace word that contains the term
   * (mirrors the span-expansion logic in rules.js), preserving any possessive
   * suffix at the end of the containing word.
   */
  // skipRef: null = replace all; { remaining: N } = skip the first N occurrences,
  // mutated in place so a single object can be shared across multiple text nodes
  // (contenteditable) to apply the budget globally rather than per node.
  function applyTermReplacement(text, term, placeholder, caseSensitive, isPartial = false, skipRef = null) {
    if (isPartial) {
      // Match the entire non-whitespace word that contains the term.
      // Capture an optional possessive suffix ('s / \u2019s) at the word end so
      // it can be preserved in the output (mirrors rules.js expansion logic).
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const flags = caseSensitive ? "g" : "gi";
      const regex = new RegExp(`\\S*${escaped}\\S*`, flags);
      return text.replace(regex, (match) => {
        if (skipRef && skipRef.remaining > 0) { skipRef.remaining--; return match; }
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
    return text.replace(regex, (match, termPart) => {
      if (skipRef && skipRef.remaining > 0) { skipRef.remaining--; return match; }
      return hasPossessiveGroup ? placeholder + match.slice(termPart.length) : placeholder;
    });
  }

  // ---------------------------------------------------------------------------
  // Typing monitor
  // ---------------------------------------------------------------------------

  function attachTypingListener() {
    document.addEventListener("input", handleTypingInput);
    document.addEventListener("beforeinput", handleBeforeInput, true); // capture phase
    document.addEventListener("keydown", handleTypingKeydown, true);   // capture phase
  }

  function detachTypingListener() {
    document.removeEventListener("input", handleTypingInput);
    document.removeEventListener("beforeinput", handleBeforeInput, true);
    document.removeEventListener("keydown", handleTypingKeydown, true);
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = null;
    lastTypingDetections = null;
  }

  // Shared deferred check used by beforeinput and keydown deletion handlers.
  // Called before the DOM changes; schedules a field-state check for after they settle.
  // If the field is empty → clear all exemptions.
  // If the field is non-empty → run reconciliation so partial deletions reduce the count.
  function scheduleExemptionCheckAfterDeletion() {
    if (restoredTermCounts.size === 0 || !lastActiveField) return;
    setTimeout(() => {
      if (restoredTermCounts.size === 0 || !lastActiveField) return;
      const fieldText = getFieldText(lastActiveField);
      if (!fieldText || !fieldText.trim()) {
        restoredTermCounts.clear();
      } else if (monitorTyping && isEnabled) {
        // Field has content but a deletion occurred — run reconciliation to clamp
        // exempt counts for any restored terms that were partially or fully removed.
        scanForTypedTerms();
      }
    }, 0);
  }

  function handleTypingInput(e) {
    // Clear restore exemptions if the tracked field is now empty. This must run
    // before ALL other guards — isEnabled, e.target, recentlyPasted — because any
    // of those can return early and prevent the clear from firing. On contenteditable
    // fields the input event can originate from a child element (e.g. a <p> inside
    // ProseMirror), making e.target !== lastActiveField even though the edit is in
    // the right field. We read lastActiveField directly so the check is field-based.
    if (restoredTermCounts.size > 0 && lastActiveField) {
      const fieldText = getFieldText(lastActiveField);
      if (!fieldText || !fieldText.trim()) restoredTermCounts.clear();
    }
    if (!isEnabled) return;
    if (e.target !== lastActiveField) return;
    if (recentlyPasted) return;
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = setTimeout(scanForTypedTerms, 400);
  }

  // Fires before the DOM is changed, at the browser level — more reliably than
  // the `input` event on editors (like Gemini) that suppress `input` for some
  // deletion operations. Covers all deletion inputTypes including cut.
  function handleBeforeInput(e) {
    if (!e.inputType.startsWith("delete")) return;
    scheduleExemptionCheckAfterDeletion();
  }

  /**
   * Flush the pending typing scan immediately on Enter (before the site's keydown
   * handler submits the message), so terms are always replaced before submission.
   * Runs in capture phase to beat the site's own keydown listeners.
   */
  function handleTypingKeydown(e) {
    if (!isEnabled) return;
    if (e.key !== "Enter") return;
    if (e.target !== lastActiveField) return;
    // Always clear restore exemptions on submit, regardless of whether a scan
    // is pending. This is the reliable clear path — the input-event fallback in
    // scanForTypedTerms is suppressed when recentlyPasted is still true.
    restoredTermCounts.clear();
    if (typingDebounceTimer === null) return;
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = null;
    scanForTypedTerms();
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
    // produces detections=[], which clears the fingerprint so re-typed terms
    // are treated as fresh.
    text = text || "";
    // Field was cleared (user submitted). Reset restore exemptions so re-typed
    // terms are treated as fresh and will be auto-replaced again.
    if (!text) restoredTermCounts.clear();

    // Build sorted terms only when there are any; the loop below is a no-op on
    // an empty array, naturally producing an empty detections list.
    const sortedTerms = userTerms.length
      ? [...userTerms].filter((t) => t.term).sort((a, b) => b.term.length - a.term.length)
      : [];

    // Pre-identify email spans so user term matches inside emails are skipped.
    // Mirrors the protection in rules.js::scrub() for the typing path.
    const emailIsEnabled = patternSettings.email !== undefined ? patternSettings.email : true;
    const emailSpans = [];
    if (emailIsEnabled && sortedTerms.length > 0) {
      const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
      let em;
      while ((em = emailRegex.exec(text)) !== null) {
        emailSpans.push({ start: em.index, end: em.index + em[0].length });
      }
    }

    const claimed = [];
    // Map from canonical term text → { replacement, count, firstPos, caseSensitive, isPartial, matchedText }
    const termCounts = new Map();

    for (const { term, partialMatch, matchMode, caseSensitive = false, replacement } of sortedTerms) {
      const isPartial = partialMatch !== undefined ? partialMatch === true : matchMode === "substring";
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

        // Skip matches that fall entirely inside a protected email address.
        if (emailSpans.some((e) => mStart >= e.start && mEnd <= e.end)) continue;

        if (claimed.some((c) => spanStart < c.end && spanEnd > c.start)) continue;

        claimed.push({ start: spanStart, end: spanEnd });
        const key = term;
        const existing = termCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          // Capture the actual matched text (not the configured term) so Restore
          // puts back exactly what the user typed, preserving their capitalization.
          let matchedText;
          if (isPartial) {
            matchedText = text.substring(spanStart, spanEnd);
            // Strip possessive suffix — it stays in the field after replacement,
            // so Restore should not re-insert it (mirrors applyTermReplacement logic).
            const possMatch = matchedText.match(/['\u2019][sS]$/);
            if (possMatch) matchedText = matchedText.slice(0, -possMatch[0].length);
          } else {
            // hasPossessiveGroup: only the term part (match[1]) is replaced; the
            // possessive suffix remains in the field, so Restore should not re-add it.
            matchedText = hasPossessiveGroup && match[1] ? match[1] : match[0];
          }
          termCounts.set(key, { replacement: replacement || null, count: 1, firstPos: mStart, caseSensitive, isPartial, matchedText });
        }
      }
    }

    // Reconcile restore exemptions against actual field content. If the user
    // deleted a restored term (or some instances of it), clamp the exempt count
    // to the number of instances that still exist. This runs before the
    // fingerprint check so deletions are processed even when no terms are found.
    if (restoredTermCounts.size > 0) {
      // Build lowercase-keyed actual counts from the just-completed scan.
      const actualByLower = new Map();
      for (const [term, data] of termCounts) {
        actualByLower.set(term.toLowerCase(), data.count);
      }
      for (const [key, exemptN] of restoredTermCounts) {
        const actual = actualByLower.get(key) || 0;
        if (actual === 0) {
          restoredTermCounts.delete(key);
        } else if (exemptN > actual) {
          restoredTermCounts.set(key, actual);
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

    let termN = scanMaxPlaceholderN(text).term;
    const detections = [];
    for (const { term, entry } of detectedEntries) {
      // Subtract restored instances from the detected count. If the user restored
      // N occurrences of a term, the first N in the field stay untouched; any
      // additional (freshly typed) instances are still scrubbed.
      const exemptCount = restoredTermCounts.get(term.toLowerCase()) || 0;
      const effectiveCount = entry.count - exemptCount;
      if (effectiveCount <= 0) continue;
      detections.push({
        term,
        placeholder: entry.replacement ? entry.replacement : `[TERM_${++termN}]`,
        count: effectiveCount,
        skipFirst: exemptCount,
        caseSensitive: entry.caseSensitive,
        isPartial: entry.isPartial,
        matchedText: entry.matchedText,
      });
    }

    // Skip if the detection set hasn't changed since the last scan.
    const fingerprint = JSON.stringify(detections);
    if (fingerprint === lastTypingDetections) return;

    // Nothing to replace — update fingerprint and bail.
    if (detections.length === 0) {
      lastTypingDetections = fingerprint;
      return;
    }

    // Suppress re-scan triggered by the input events replaceTermInField will dispatch.
    recentlyPasted = true;
    clearTimeout(pasteSuppressionTimer);
    pasteSuppressionTimer = setTimeout(() => { recentlyPasted = false; }, 500);
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = null;

    // Auto-replace each detected term immediately.
    const replacements = [];
    for (const { term, placeholder, caseSensitive, isPartial, skipFirst, matchedText } of detections) {
      const replaceError = replaceTermInField(field, term, placeholder, caseSensitive, isPartial, skipFirst);
      if (replaceError === null) {
        replacements.push({ placeholder, original: matchedText || term, source: "typed" });
      }
    }

    // Reset fingerprint so re-typed terms are treated as fresh detections.
    lastTypingDetections = "";

    if (replacements.length === 0) return;

    try {
      chrome.runtime.sendMessage({ type: "replacements-made", count: replacements.length });
      chrome.runtime.sendMessage({
        type: "scrub-log",
        timestamp: Date.now(),
        replacements,
      });
    } catch (_) {}

    showToast(replacements.length);
  }

  function showWarningToast() {
    const existing = document.getElementById("llm-scrub-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.id = "llm-scrub-toast";
    toast.textContent =
      "Scrubby: replacement log full \u2014 scrubbing still active but log may be incomplete";
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("llm-scrub-toast-visible"));
    setTimeout(() => {
      toast.classList.remove("llm-scrub-toast-visible");
      setTimeout(() => toast.remove(), 300);
    }, 5000);
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
