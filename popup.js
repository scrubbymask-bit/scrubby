/**
 * LLM Scrub — Popup Script
 * Manages the extension popup UI: toggling, pattern settings,
 * user term management, import/export.
 */

const MAX_TERM_LENGTH = 500;
const MAX_TERM_COUNT  = 1000;

document.addEventListener("DOMContentLoaded", () => {
  const enableToggle = document.getElementById("enableToggle");
  const statusBar = document.getElementById("statusBar");
  const statusDot = statusBar.querySelector(".status-dot");
  const statusText = document.getElementById("statusText");
  const replacementCount = document.getElementById("replacementCount");
  const countNumber = document.getElementById("countNumber");
  const logDot = document.getElementById("logDot");
  const patternList = document.getElementById("patternList");
  const newTermInput = document.getElementById("newTermInput");
  const addTermBtn = document.getElementById("addTermBtn");
  const termList = document.getElementById("termList");
  const emptyState = document.getElementById("emptyState");
  const yourTermsHeading = document.querySelector(".terms-subheading--list");
  const settingsBtn = document.getElementById("settingsBtn");
  const sidePanelBtn = document.getElementById("sidePanelBtn");
  const siteToggleWrapper = document.getElementById("siteToggleWrapper");
  const monitorTypingToggle = document.getElementById("monitorTypingToggle");
  const supportedView = document.getElementById("supportedView");
  const unsupportedView = document.getElementById("unsupportedView");
  const supportedSitesList = document.getElementById("supportedSitesList");

  // Supported hostnames (must match manifest.json host_permissions)
  const SUPPORTED_HOSTS = [
    "chatgpt.com",
    "chat.openai.com",
    "claude.ai",
    "gemini.google.com",
    "www.perplexity.ai",
    "copilot.microsoft.com",
    "chat.mistral.ai",
    "poe.com",
  ];

  // Display names for the unsupported view, in order
  const SITE_DISPLAY_NAMES = [
    "ChatGPT",
    "Claude",
    "Gemini",
    "Perplexity",
    "Copilot",
    "Mistral",
    "Poe",
  ];

  // Built-in patterns (must match rules.js)
  const builtinPatterns = [
    { key: "email", label: "Emails" },
    { key: "phone", label: "Phone Numbers" },
    { key: "ssn", label: "SSNs" },
    { key: "creditCard", label: "Credit Cards" },
  ];

  // Current tab info — set during init.
  let currentHostname = null;
  let currentTabId = null;

  // --- Initialization ---

  function init() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      try {
        currentHostname = new URL(tabs[0].url).hostname;
        currentTabId = tabs[0].id;
      } catch (_) {
        currentHostname = null;
        currentTabId = null;
      }

      const isSupported =
        currentHostname !== null &&
        SUPPORTED_HOSTS.includes(currentHostname);

      if (!isSupported) {
        // Show unsupported view; populate the site list, hide the toggle
        siteToggleWrapper.style.display = "none";
        supportedView.style.display = "none";
        unsupportedView.style.display = "";
        supportedSitesList.textContent =
          "Works on: " + SITE_DISPLAY_NAMES.join(" · ");
        document.body.style.visibility = "";
        return;
      }

      chrome.storage.local.get(
        ["siteEnabled", "userTerms", "patternSettings", "emailReplacement", "monitorTyping", "autoDetectCollapsed"],
        (result) => {
          const siteEnabled = result.siteEnabled || {};
          const enabled = siteEnabled[currentHostname] !== false;

          // Migrate old matchMode field to partialMatch if present
          const rawTerms = result.userTerms || [];
          const migratedTerms = migrateTerms(rawTerms);
          if (migratedTerms !== rawTerms) {
            chrome.storage.local.set({ userTerms: migratedTerms }, () => {
              if (chrome.runtime.lastError) {
                console.error("[Scrubby] term migration write failed:", chrome.runtime.lastError.message);
              }
            });
          }

          enableToggle.checked = enabled;
          updateStatus(enabled);
          renderPatterns(result.patternSettings || {}, result.emailReplacement || "");
          renderTerms(migratedTerms);
          monitorTypingToggle.checked = result.monitorTyping === true;
          if (result.autoDetectCollapsed) {
            document.getElementById("autoDetectSection").classList.add("section--collapsed");
          }
          // Reveal first, then enable transitions on the next frame.
          // Transitions are defined only under .transitions-ready, so they
          // cannot fire during the initial paint.
          document.body.style.visibility = "";
          setTimeout(() => {
            document.body.classList.add("transitions-ready");
          }, 50);
        }
      );

      // Get replacement count for active tab
      chrome.runtime.sendMessage(
        { type: "getActiveTabCount" },
        (response) => {
          if (response && response.count > 0) {
            countNumber.textContent = response.count;
            replacementCount.style.display = "inline";
            updateStatusCountsVisibility();
          }
        }
      );

      // Load detection count and log dot state from session storage
      if (currentTabId !== null) {
        loadSessionCounts(currentTabId);
      }
    });
  }

  function loadSessionCounts(tabId) {
    chrome.storage.session.get([`scrubBadge_${tabId}`], (data) => {
      const scrubBadge = data[`scrubBadge_${tabId}`] || 0;
      updateLogDot(scrubBadge);
    });
  }

  function updateStatusCountsVisibility() {
    const statusCounts = document.getElementById("statusCounts");
    statusCounts.style.display = replacementCount.style.display !== "none" ? "" : "none";
  }

  function updateLogDot(scrubBadge) {
    if (scrubBadge > 0) {
      logDot.className = "log-dot log-dot--purple";
      logDot.style.display = "";
    } else {
      logDot.style.display = "none";
    }
  }


  // --- Enable/Disable ---

  function updateStatus(enabled) {
    const siteLabel = currentHostname || "this page";
    if (enabled) {
      statusDot.className = "status-dot active";
      statusText.textContent = `Active on ${siteLabel}`;
    } else {
      statusDot.className = "status-dot inactive";
      statusText.textContent = `Disabled on ${siteLabel}`;
    }
  }

  enableToggle.addEventListener("change", () => {
    if (!currentHostname) return;
    const enabled = enableToggle.checked;
    chrome.storage.local.get(["siteEnabled"], (result) => {
      const siteEnabled = result.siteEnabled || {};
      siteEnabled[currentHostname] = enabled;
      chrome.storage.local.set({ siteEnabled }, () => {
        if (chrome.runtime.lastError) {
          console.error("[Scrubby] siteEnabled write failed:", chrome.runtime.lastError.message);
          enableToggle.checked = !enabled;
          updateStatus(!enabled);
        }
      });
    });
    updateStatus(enabled);
  });

  monitorTypingToggle.addEventListener("change", () => {
    const enabled = monitorTypingToggle.checked;
    chrome.storage.local.set({ monitorTyping: enabled }, () => {
      if (chrome.runtime.lastError) {
        console.error("[Scrubby] monitorTyping write failed:", chrome.runtime.lastError.message);
        monitorTypingToggle.checked = !enabled;
        // The direct toggle message below already ran; send the reverse so the
        // content script's in-memory state stays in sync (onChanged won't fire
        // because the write failed and storage still holds the previous value).
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: "toggle-typing-monitor",
              enabled: !enabled,
            }).catch(() => {});
          }
        });
      }
    });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "toggle-typing-monitor",
          enabled,
        }).catch(() => {});
      }
    });
  });

  // --- Pattern Toggles ---

  function renderPatterns(settings, emailReplacement) {
    patternList.innerHTML = "";
    for (const pattern of builtinPatterns) {
      const enabled =
        settings[pattern.key] !== undefined
          ? settings[pattern.key]
          : true;

      const item = document.createElement("div");

      if (pattern.key === "email") {
        item.className = "pattern-item pattern-item--email";
        item.innerHTML = `
          <div class="pattern-item-main">
            <span class="pattern-label">Emails</span>
            <label class="toggle">
              <input type="checkbox" id="pattern-email" ${enabled ? "checked" : ""}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="email-repl-section${enabled ? "" : " hidden"}">
            <div class="email-repl-header">
              <span class="email-repl-label${emailReplacement ? " email-repl-label--set" : ""}">${emailReplacement ? escapeHtml("→\u202F" + emailReplacement) : "Custom replacement"}</span>
              <span class="email-repl-chevron">&#x203A;</span>
            </div>
            <div class="email-repl-panel hidden">
              <div class="email-repl-input-row">
                <input type="text" class="pattern-email-input" placeholder="e.g. fake@company.com" autocomplete="off">
                <button class="email-repl-clear-btn${emailReplacement ? "" : " hidden"}" title="Clear">&#x00D7;</button>
              </div>
              <span class="term-save-indicator email-repl-save-indicator">✓ Saved</span>
            </div>
          </div>
        `;
      } else {
        item.className = "pattern-item";
        item.innerHTML = `
          <label for="pattern-${pattern.key}">${pattern.label}</label>
          <label class="toggle">
            <input type="checkbox" id="pattern-${pattern.key}" ${enabled ? "checked" : ""}>
            <span class="toggle-slider"></span>
          </label>
        `;
      }

      patternList.appendChild(item);

      item
        .querySelector(".toggle input")
        .addEventListener("change", (e) => {
          const input = e.target;
          const newEnabled = input.checked;
          chrome.storage.local.get(["patternSettings"], (result) => {
            const ps = result.patternSettings || {};
            ps[pattern.key] = newEnabled;
            chrome.storage.local.set({ patternSettings: ps }, () => {
              if (chrome.runtime.lastError) {
                console.error("[Scrubby] patternSettings write failed:", chrome.runtime.lastError.message);
                input.checked = !newEnabled;
              }
            });
          });
        });

      if (pattern.key === "email") {
        const toggleLabel      = item.querySelector(".toggle");
        const toggleInput      = item.querySelector(".toggle input");
        const replSection      = item.querySelector(".email-repl-section");
        const replHeader       = item.querySelector(".email-repl-header");
        const replLabel        = item.querySelector(".email-repl-label");
        const replPanel        = item.querySelector(".email-repl-panel");
        const replacementInput = item.querySelector(".pattern-email-input");
        const clearBtn         = item.querySelector(".email-repl-clear-btn");
        const indicator        = item.querySelector(".email-repl-save-indicator");

        replacementInput.value = emailReplacement || "";
        let lastSaved = emailReplacement || "";

        function updateHeader() {
          replLabel.textContent = lastSaved ? "→\u202F" + lastSaved : "Custom replacement";
          replLabel.classList.toggle("email-repl-label--set", !!lastSaved);
          clearBtn.classList.toggle("hidden", !lastSaved);
        }

        function collapsePanel() {
          replPanel.classList.add("hidden");
          replSection.classList.remove("email-repl-section--expanded");
        }

        // Prevent toggle clicks from propagating to the document click handler
        toggleLabel.addEventListener("click", (e) => e.stopPropagation());

        toggleInput.addEventListener("change", (e) => {
          replSection.classList.toggle("hidden", !e.target.checked);
          if (!e.target.checked) collapsePanel();
        });

        replHeader.addEventListener("click", () => {
          const isExpanded = replSection.classList.contains("email-repl-section--expanded");
          if (isExpanded) {
            collapsePanel();
          } else {
            if (expandedTermId) {
              const prev = termList.querySelector(`.term-item[data-id="${expandedTermId}"]`);
              if (prev) {
                prev.querySelector(".term-edit-panel").classList.add("hidden");
                prev.classList.remove("term-item--expanded");
              }
              expandedTermId = null;
            }
            replPanel.classList.remove("hidden");
            replSection.classList.add("email-repl-section--expanded");
            replacementInput.focus();
          }
        });

        clearBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          replacementInput.value = "";
          lastSaved = "";
          chrome.storage.local.set({ emailReplacement: "" });
          updateHeader();
          replacementInput.focus();
        });

        replacementInput.addEventListener("change", (e) => {
          const val = e.target.value.trim().slice(0, MAX_TERM_LENGTH);
          if (val !== e.target.value.trim()) replacementInput.value = val;
          if (val === lastSaved) return;
          lastSaved = val;
          chrome.storage.local.set({ emailReplacement: val }, () => {
            if (chrome.runtime.lastError) {
              console.error("[Scrubby] emailReplacement write failed:", chrome.runtime.lastError.message);
              return;
            }
            indicator.classList.remove("term-save-indicator--active");
            void indicator.offsetWidth;
            indicator.classList.add("term-save-indicator--active");
          });
          updateHeader();
        });
      }
    }
  }

  // --- User Terms ---

  let expandedTermId = null;

  function renderTerms(terms) {
    termList.innerHTML = "";
    expandedTermId = null;
    if (terms.length === 0) {
      emptyState.classList.remove("hidden");
      yourTermsHeading.classList.add("hidden");
    } else {
      emptyState.classList.add("hidden");
      yourTermsHeading.classList.remove("hidden");
    }

    for (const term of [...terms].sort((a, b) => b.createdAt - a.createdAt)) {
      const item = document.createElement("div");
      item.className = "term-item";
      item.dataset.id = term.id;
      const badges = buildBadgesHtml(term);
      item.innerHTML = `
        <div class="term-item-main">
          <span class="term-text">${escapeHtml(term.term)}</span>
          ${badges}
          <button class="remove-btn" data-id="${term.id}" title="Remove">&times;</button>
        </div>
        <div class="term-edit-panel hidden">
          <div class="term-edit-fullname"><span class="term-edit-fullname-label">Term:</span> ${escapeHtml(term.term)}</div>
          <label class="term-opt-check">
            <input type="checkbox" class="edit-case" ${term.caseSensitive ? "checked" : ""}>
            <span>Case sensitive</span>
          </label>
          <label class="term-opt-check">
            <input type="checkbox" class="edit-partial" ${term.partialMatch ? "checked" : ""}>
            <span>Partial matching</span>
          </label>
          <div class="term-partial-warn${term.partialMatch ? "" : " hidden"}">⚠ Partial matching: short terms may match inside common words unexpectedly.</div>
          <label class="term-opt-check">
            <input type="checkbox" class="edit-custom-check" ${term.replacement ? "checked" : ""}>
            <span>Custom replacement</span>
          </label>
          <div class="term-edit-replacement${term.replacement ? "" : " hidden"}">
            <input type="text" class="edit-replacement" placeholder="Replace with...">
          </div>
          <span class="term-save-indicator">✓ Saved</span>
        </div>
      `;
      termList.appendChild(item);

      item.querySelector(".remove-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        removeTerm(term.id);
      });

      item.querySelector(".term-item-main").addEventListener("click", () => {
        toggleEditPanel(term.id, item);
      });

      item.querySelector(".edit-partial").addEventListener("change", (e) => {
        updateTermSetting(term.id, { partialMatch: e.target.checked });
        item.querySelector(".term-partial-warn").classList.toggle("hidden", !e.target.checked);
      });

      item.querySelector(".edit-case").addEventListener("change", (e) => {
        updateTermSetting(term.id, { caseSensitive: e.target.checked });
      });

      const editCustomCheck  = item.querySelector(".edit-custom-check");
      const replacementDiv   = item.querySelector(".term-edit-replacement");
      const replacementInput = item.querySelector(".edit-replacement");
      replacementInput.value = term.replacement || "";

      editCustomCheck.addEventListener("change", (e) => {
        replacementDiv.classList.toggle("hidden", !e.target.checked);
        if (e.target.checked) {
          replacementInput.focus();
        } else {
          replacementInput.value = "";
          updateTermSetting(term.id, { replacement: "" }, { silent: true });
        }
      });

      replacementInput.addEventListener("change", (e) => {
        const val = e.target.value.trim();
        updateTermSetting(term.id, { replacement: val });
        refreshTermBadges(term.id, { ...term, replacement: val });
      });
    }
  }

  const REPLACEMENT_BADGE_MAX = 15;

  function replacementBadgeText(replacement) {
    return "→\u202F" + (replacement.length > REPLACEMENT_BADGE_MAX
      ? replacement.slice(0, REPLACEMENT_BADGE_MAX) + "…"
      : replacement);
  }

  function buildBadgesHtml(term) {
    const badges = [];
    if (term.replacement) badges.push(`<span class="term-badge term-badge--replacement">${escapeHtml(replacementBadgeText(term.replacement))}</span>`);
    if (term.partialMatch) badges.push('<span class="term-badge" title="Partial match">partial</span>');
    if (term.caseSensitive) badges.push('<span class="term-badge" title="Case-sensitive">Aa</span>');
    return badges.join("");
  }

  function toggleEditPanel(termId, item) {
    const panel = item.querySelector(".term-edit-panel");
    if (expandedTermId === termId) {
      panel.classList.add("hidden");
      item.classList.remove("term-item--expanded");
      expandedTermId = null;
    } else {
      if (expandedTermId) {
        const prev = termList.querySelector(`.term-item[data-id="${expandedTermId}"]`);
        if (prev) {
          prev.querySelector(".term-edit-panel").classList.add("hidden");
          prev.classList.remove("term-item--expanded");
        }
      }
      panel.classList.remove("hidden");
      item.classList.add("term-item--expanded");
      expandedTermId = termId;
    }
  }

  function updateTermSetting(id, updates, { silent = false } = {}) {
    if (typeof updates.replacement === "string" && updates.replacement.length > MAX_TERM_LENGTH) {
      updates = { ...updates, replacement: updates.replacement.slice(0, MAX_TERM_LENGTH) };
    }
    chrome.storage.local.get(["userTerms"], (result) => {
      const terms = result.userTerms || [];
      const idx = terms.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const oldTerm = terms[idx]; // snapshot before modification for failure revert
      terms[idx] = { ...terms[idx], ...updates };
      if (!terms[idx].replacement) delete terms[idx].replacement;
      chrome.storage.local.set({ userTerms: terms }, () => {
        if (chrome.runtime.lastError) {
          console.error("[Scrubby] updateTermSetting write failed:", chrome.runtime.lastError.message);
          refreshTermBadges(id, oldTerm); // revert badges to the last persisted state
          return;
        }
        refreshTermBadges(id, terms[idx]);
        if (!silent) flashSaveIndicator(id);
      });
    });
  }

  function flashSaveIndicator(id) {
    const item = termList.querySelector(`.term-item[data-id="${id}"]`);
    if (!item) return;
    const indicator = item.querySelector(".term-save-indicator");
    if (!indicator) return;
    indicator.classList.remove("term-save-indicator--active");
    void indicator.offsetWidth; // force reflow to restart animation
    indicator.classList.add("term-save-indicator--active");
  }

  function refreshTermBadges(id, term) {
    const item = termList.querySelector(`.term-item[data-id="${id}"]`);
    if (!item) return;
    const main = item.querySelector(".term-item-main");
    main.querySelectorAll(".term-badge").forEach((b) => b.remove());
    const removeBtn = main.querySelector(".remove-btn");
    if (term.replacement) {
      const b = document.createElement("span");
      b.className = "term-badge term-badge--replacement";
      b.textContent = replacementBadgeText(term.replacement);
      main.insertBefore(b, removeBtn);
    }
    if (term.partialMatch) {
      const b = document.createElement("span");
      b.className = "term-badge";
      b.title = "Partial match";
      b.textContent = "partial";
      main.insertBefore(b, removeBtn);
    }
    if (term.caseSensitive) {
      const b = document.createElement("span");
      b.className = "term-badge";
      b.title = "Case-sensitive";
      b.textContent = "Aa";
      main.insertBefore(b, removeBtn);
    }
  }

  document.addEventListener("click", (e) => {
    if (expandedTermId) {
      const expandedItem = termList.querySelector(`.term-item[data-id="${expandedTermId}"]`);
      if (expandedItem && !expandedItem.contains(e.target)) {
        expandedItem.querySelector(".term-edit-panel").classList.add("hidden");
        expandedItem.classList.remove("term-item--expanded");
        expandedTermId = null;
      }
    }
    const emailItem = patternList.querySelector(".pattern-item--email");
    if (emailItem && !emailItem.contains(e.target)) {
      const replSection = emailItem.querySelector(".email-repl-section--expanded");
      if (replSection) {
        replSection.querySelector(".email-repl-panel").classList.add("hidden");
        replSection.classList.remove("email-repl-section--expanded");
      }
    }
  });

  // Show an inline error beneath the add-term input.
  function showAddError(message) {
    let errorEl = document.getElementById("termDuplicateError");
    if (!errorEl) {
      errorEl = document.createElement("div");
      errorEl.id = "termDuplicateError";
      errorEl.className = "term-duplicate-error";
      document.querySelector(".add-term-block").appendChild(errorEl);
    }
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
    clearTimeout(errorEl._hideTimer);
    errorEl._hideTimer = setTimeout(() => errorEl.classList.add("hidden"), 3000);
  }

  function showDuplicateError(existingId) {
    showAddError("This term already exists in the list.");

    // Scroll to and flash-highlight the existing term row
    const existingRow = termList.querySelector(`[data-id="${existingId}"]`);
    if (existingRow) {
      existingRow.scrollIntoView({ block: "nearest" });
      existingRow.classList.add("term-item--flash");
      setTimeout(() => existingRow.classList.remove("term-item--flash"), 1000);
    }
  }

  function addTerm() {
    const value = newTermInput.value.trim();
    if (!value) return;

    if (value.length > MAX_TERM_LENGTH) {
      showAddError(`Term is too long (max ${MAX_TERM_LENGTH} characters).`);
      return;
    }

    if (!/[a-zA-Z0-9]/.test(value)) {
      showAddError("Terms must contain at least one letter or number.");
      return;
    }

    const partialMatch = document.getElementById("newTermPartial").checked;
    const caseSensitive = document.getElementById("newTermCaseSensitive").checked;
    const replacement = document.getElementById("newTermReplacement").value.trim();

    addTermBtn.disabled = true;

    chrome.storage.local.get(["userTerms"], (result) => {
      const terms = result.userTerms || [];

      if (terms.length >= MAX_TERM_COUNT) {
        showAddError(`Maximum term limit (${MAX_TERM_COUNT}) reached.`);
        addTermBtn.disabled = false;
        return;
      }

      // Check for duplicates
      const duplicate = terms.find((t) => t.term.toLowerCase() === value.toLowerCase());
      if (duplicate) {
        newTermInput.select();
        showDuplicateError(duplicate.id);
        addTermBtn.disabled = false;
        return;
      }

      const newTerm = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        term: value,
        createdAt: Date.now(),
        partialMatch,
        caseSensitive,
      };
      if (replacement) newTerm.replacement = replacement;
      terms.push(newTerm);

      chrome.storage.local.set({ userTerms: terms }, () => {
        if (chrome.runtime.lastError) {
          console.error("[Scrubby] addTerm write failed:", chrome.runtime.lastError.message);
          showAddError("Failed to save term. Please try again.");
          addTermBtn.disabled = false;
          return;
        }
        renderTerms(terms);
        newTermInput.value = "";
        hideReplacementRow();
        newTermInput.focus();
        addTermBtn.disabled = false;
        const addIndicator = document.getElementById("addTermIndicator");
        addIndicator.classList.remove("term-save-indicator--active");
        void addIndicator.offsetWidth;
        addIndicator.classList.add("term-save-indicator--active");
      });
    });
  }

  function removeTerm(id) {
    const btn = termList.querySelector(`.remove-btn[data-id="${id}"]`);
    if (btn) btn.disabled = true;
    chrome.storage.local.get(["userTerms"], (result) => {
      const terms = (result.userTerms || []).filter((t) => t.id !== id);
      chrome.storage.local.set({ userTerms: terms }, () => {
        if (chrome.runtime.lastError) {
          console.error("[Scrubby] removeTerm write failed:", chrome.runtime.lastError.message);
          if (btn) btn.disabled = false;
          return;
        }
        renderTerms(terms);
      });
    });
  }

  addTermBtn.addEventListener("click", addTerm);
  newTermInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTerm();
  });

  const addReplacementRow         = document.getElementById("addReplacementRow");
  const newTermReplacement        = document.getElementById("newTermReplacement");
  const newTermCustomReplacement  = document.getElementById("newTermCustomReplacement");

  function hideReplacementRow() {
    newTermCustomReplacement.checked = false;
    addReplacementRow.classList.add("hidden");
    newTermReplacement.value = "";
  }

  newTermCustomReplacement.addEventListener("change", (e) => {
    addReplacementRow.classList.toggle("hidden", !e.target.checked);
    if (e.target.checked) newTermReplacement.focus();
    else newTermReplacement.value = "";
  });

  newTermReplacement.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTerm();
  });

  document.getElementById("newTermPartial").addEventListener("change", (e) => {
    document.getElementById("newTermPartialWarn").classList.toggle("hidden", !e.target.checked);
  });

  const helpTexts = {
    partial: "Matches even inside other words, replacing the entire word. Example: \"app\" will replace the whole word \"application\" with a single placeholder. When unchecked, only whole words are matched.",
    case: "When enabled, matching is case-sensitive. Example: \"Acme\" will NOT match \"acme\" or \"ACME\".",
    replacement: "Set a custom replacement instead of the default [TERM_1] placeholder. Example: \"Acme Corp\" can be replaced with \"TechCo\". All occurrences use the same replacement text.",
  };
  const termHelp = document.getElementById("termHelp");
  let activeHelp = null;
  document.querySelectorAll(".opt-info").forEach((el) => {
    if (!el.dataset.help) return; // skip elements without data-help (e.g. monitor typing info)
    el.addEventListener("click", () => {
      const key = el.dataset.help;
      if (activeHelp === key) {
        termHelp.classList.add("hidden");
        activeHelp = null;
      } else {
        termHelp.textContent = helpTexts[key];
        termHelp.classList.remove("hidden");
        activeHelp = key;
      }
    });
  });

  // Monitor typing info icon
  const monitorTypingInfo = document.getElementById("monitorTypingInfo");
  const monitorTypingHelp = document.getElementById("monitorTypingHelp");
  monitorTypingInfo.addEventListener("click", () => {
    const isHidden = monitorTypingHelp.classList.contains("hidden");
    monitorTypingHelp.classList.toggle("hidden", !isHidden);
  });

  // --- Settings page ---

  settingsBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });

  // --- Side panel ---

  sidePanelBtn.addEventListener("click", () => {
    chrome.windows.getCurrent((win) => {
      chrome.sidePanel.open({ windowId: win.id });
      window.close();
    });
  });

  // --- Helpers ---

  // Migrate terms from old matchMode:"word"/"substring" to partialMatch:true/false.
  // Returns the same array reference if no migration was needed.
  function migrateTerms(terms) {
    if (!terms.some((t) => "matchMode" in t)) return terms;
    return terms.map((t) => {
      if (!("matchMode" in t)) return t;
      const { matchMode, ...rest } = t;
      return { ...rest, partialMatch: matchMode === "substring" };
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Auto-Detection collapse ---

  document.getElementById("autoDetectHeader").addEventListener("click", () => {
    const section = document.getElementById("autoDetectSection");
    const collapsed = section.classList.toggle("section--collapsed");
    chrome.storage.local.set({ autoDetectCollapsed: collapsed });
  });

  // --- Start ---
  init();
});
