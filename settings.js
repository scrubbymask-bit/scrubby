/**
 * LLM Scrub — Settings Page
 * Handles export/import of terms (plain text and CSV) and backup/restore of
 * all settings (JSON). Runs as a standalone tab, not inside the popup.
 */

// Sites must match manifest.json host_permissions
const SITES = [
  { hostname: "chatgpt.com",             label: "ChatGPT" },
  { hostname: "chat.openai.com",         label: "ChatGPT (OpenAI)" },
  { hostname: "claude.ai",               label: "Claude" },
  { hostname: "gemini.google.com",       label: "Gemini" },
  { hostname: "www.perplexity.ai",       label: "Perplexity" },
  { hostname: "copilot.microsoft.com",   label: "Copilot" },
  { hostname: "chat.mistral.ai",         label: "Mistral" },
  { hostname: "poe.com",                 label: "Poe" },
];

const MAX_TERM_LENGTH  = 500;
const MAX_TERM_COUNT   = 1000;
// patternSettings keys must match rules.js builtinPatterns
const KNOWN_PATTERN_KEYS = ["email", "phone", "ssn", "creditCard"];

document.addEventListener("DOMContentLoaded", () => {
  const exportTermsBtn  = document.getElementById("exportTermsBtn");
  const importTermsBtn  = document.getElementById("importTermsBtn");
  const importTermsFile = document.getElementById("importTermsFile");
  const exportCsvBtn    = document.getElementById("exportCsvBtn");
  const importCsvBtn    = document.getElementById("importCsvBtn");
  const importCsvFile   = document.getElementById("importCsvFile");
  const backupBtn       = document.getElementById("backupBtn");
  const restoreBtn      = document.getElementById("restoreBtn");
  const restoreFile     = document.getElementById("restoreFile");
  const siteList        = document.getElementById("siteList");

  // --- Feedback bar ---

  let feedbackTimer = null;

  function showFeedback(message, type = "") {
    const bar = document.getElementById("feedbackBar");
    bar.textContent = message;
    bar.className = "feedback-bar" + (type ? " " + type : "");
    // Force reflow so the transition fires even when re-showing quickly
    bar.offsetHeight; // eslint-disable-line no-unused-expressions
    bar.classList.add("visible");
    clearTimeout(feedbackTimer);
    const duration = type === "error" ? 6000 : 3500;
    feedbackTimer = setTimeout(() => bar.classList.remove("visible"), duration);
  }

  // --- Supported Sites toggles ---

  function renderSiteList(siteEnabled) {
    siteList.innerHTML = "";
    for (const site of SITES) {
      const enabled = siteEnabled[site.hostname] !== false;
      const item = document.createElement("div");
      item.className = "pattern-item";
      item.innerHTML = `
        <label for="site-${site.hostname}">${site.label}<span class="pattern-hostname"> ${site.hostname}</span></label>
        <label class="toggle">
          <input type="checkbox" id="site-${site.hostname}" ${enabled ? "checked" : ""}>
          <span class="toggle-slider"></span>
        </label>
      `;
      siteList.appendChild(item);

      item.querySelector("input").addEventListener("change", (e) => {
        chrome.storage.local.get(["siteEnabled"], (r) => {
          const se = r.siteEnabled || {};
          se[site.hostname] = e.target.checked;
          chrome.storage.local.set({ siteEnabled: se }, () => {
            if (chrome.runtime.lastError) {
              console.error("[Scrubby] siteEnabled write failed:", chrome.runtime.lastError.message);
            }
          });
        });
      });
    }
  }

  chrome.storage.local.get(["siteEnabled"], (result) => {
    renderSiteList(result.siteEnabled || {});
  });

  // --- Inline hint toggles ---

  document.querySelectorAll(".settings-hint-toggle").forEach((el) => {
    el.addEventListener("click", () => {
      const hint = document.getElementById(el.dataset.hint);
      hint.classList.toggle("hidden");
    });
  });

  // --- Export Terms (plain text, one per line) ---

  exportTermsBtn.addEventListener("click", () => {
    chrome.storage.local.get(["userTerms"], (result) => {
      const terms = result.userTerms || [];
      const text = terms.map((t) => t.term).join("\n");
      download(text, "llm-scrub-terms.txt", "text/plain");
    });
  });

  // --- Import Terms (plain text, one per line) ---

  importTermsBtn.addEventListener("click", () => {
    importTermsFile.click();
  });

  importTermsFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target.result;

      if (content.startsWith("{\\rtf")) {
        showFeedback(
          "This looks like a Rich Text file. Please re-save it as plain text (.txt) before importing.",
          "error"
        );
        return;
      }

      chrome.storage.local.get(["userTerms"], (result) => {
        const existing = result.userTerms || [];
        const existingLower = new Set(existing.map((t) => t.term.toLowerCase()));
        const available = MAX_TERM_COUNT - existing.length;

        const added = [];
        let skippedLength  = 0;
        let skippedCount   = 0;
        let skippedNoAlnum = 0;

        for (const line of content.split(/\r?\n/)) {
          const value = line.trim();
          if (!value || existingLower.has(value.toLowerCase())) continue;
          if (!/[a-zA-Z0-9]/.test(value))    { skippedNoAlnum++; continue; }
          if (value.length > MAX_TERM_LENGTH) { skippedLength++;  continue; }
          if (added.length >= available)      { skippedCount++;   continue; }
          existingLower.add(value.toLowerCase());
          added.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            term: value,
            createdAt: Date.now(),
          });
        }

        if (added.length === 0) {
          if (skippedLength > 0 || skippedCount > 0 || skippedNoAlnum > 0) {
            const parts = [];
            if (skippedNoAlnum) parts.push(`${skippedNoAlnum} term${skippedNoAlnum !== 1 ? "s" : ""} had no alphanumeric characters`);
            if (skippedLength)  parts.push(`${skippedLength} term${skippedLength !== 1 ? "s" : ""} exceeded the ${MAX_TERM_LENGTH}-character limit`);
            if (skippedCount)   parts.push(`${skippedCount} term${skippedCount !== 1 ? "s" : ""} would exceed the ${MAX_TERM_COUNT}-term limit`);
            showFeedback(`No terms imported — ${parts.join("; ")}.`, "error");
          } else {
            showFeedback("No changes — all terms already match.");
          }
          return;
        }

        chrome.storage.local.set({ userTerms: [...existing, ...added] }, () => {
          if (chrome.runtime.lastError) {
            showFeedback("Failed to save terms: " + chrome.runtime.lastError.message, "error");
            return;
          }
          const parts = [`Imported ${added.length} new term${added.length !== 1 ? "s" : ""}`];
          if (skippedNoAlnum) parts.push(`${skippedNoAlnum} skipped (no alphanumeric characters)`);
          if (skippedLength)  parts.push(`${skippedLength} skipped (too long)`);
          if (skippedCount)   parts.push(`${skippedCount} skipped (limit reached)`);
          showFeedback(parts.join(", ") + ".", "success");
        });
      });
    };
    reader.readAsText(file);
    importTermsFile.value = "";
  });

  // --- Export Terms (CSV) ---

  exportCsvBtn.addEventListener("click", () => {
    chrome.storage.local.get(["userTerms"], (result) => {
      const terms = result.userTerms || [];
      const lines = ["term,replacement,partialMatch,caseSensitive"];
      for (const t of terms) {
        lines.push(toCsvLine([
          t.term,
          t.replacement || "",
          t.partialMatch ? "TRUE" : "FALSE",
          t.caseSensitive ? "TRUE" : "FALSE",
        ]));
      }
      download(lines.join("\n"), "llm-scrub-terms.csv", "text/csv");
    });
  });

  // --- Import Terms (CSV) ---

  importCsvBtn.addEventListener("click", () => {
    importCsvFile.click();
  });

  importCsvFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target.result;

      if (content.startsWith("{\\rtf")) {
        showFeedback(
          "This looks like a Rich Text file. Please re-save it as plain text (.txt) before importing.",
          "error"
        );
        return;
      }

      const rows = parseCsv(content);
      if (!rows) {
        showFeedback('Invalid CSV: missing required "term" column header.', "error");
        return;
      }

      chrome.storage.local.get(["userTerms"], (result) => {
        const existing = result.userTerms || [];

        // Build a lookup from the import file keyed by lowercase term name.
        const rowsByKey = new Map();
        for (const row of rows) {
          if (row.term) rowsByKey.set(row.term.toLowerCase(), row);
        }

        // Update settings on existing terms where the imported values differ.
        let updated = 0;
        const mergedExisting = existing.map((t) => {
          const importedRow = rowsByKey.get(t.term.toLowerCase());
          if (!importedRow) return t;
          const sameSettings =
            (t.partialMatch  || false) === importedRow.partialMatch &&
            (t.caseSensitive || false) === importedRow.caseSensitive &&
            (t.replacement   || "")   === (importedRow.replacement || "");
          if (sameSettings) return t;
          updated++;
          const merged = { ...t, partialMatch: importedRow.partialMatch, caseSensitive: importedRow.caseSensitive };
          if (importedRow.replacement) {
            merged.replacement = importedRow.replacement;
          } else {
            delete merged.replacement;
          }
          return merged;
        });

        // Add genuinely new terms (with length and count guards).
        const existingLower = new Set(existing.map((t) => t.term.toLowerCase()));
        const available = MAX_TERM_COUNT - existing.length;
        const added = [];
        let skippedLength  = 0;
        let skippedCount   = 0;
        let skippedNoAlnum = 0;

        for (const row of rows) {
          if (!row.term || existingLower.has(row.term.toLowerCase())) continue;
          if (!/[a-zA-Z0-9]/.test(row.term))        { skippedNoAlnum++; continue; }
          if (row.term.length > MAX_TERM_LENGTH)     { skippedLength++;  continue; }
          if (added.length >= available)             { skippedCount++;   continue; }
          const newTerm = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            term: row.term,
            partialMatch: row.partialMatch,
            caseSensitive: row.caseSensitive,
            createdAt: Date.now(),
          };
          if (row.replacement) newTerm.replacement = row.replacement;
          added.push(newTerm);
        }

        if (added.length === 0 && updated === 0) {
          if (skippedLength > 0 || skippedCount > 0 || skippedNoAlnum > 0) {
            const parts = [];
            if (skippedNoAlnum) parts.push(`${skippedNoAlnum} term${skippedNoAlnum !== 1 ? "s" : ""} had no alphanumeric characters`);
            if (skippedLength)  parts.push(`${skippedLength} term${skippedLength !== 1 ? "s" : ""} exceeded the ${MAX_TERM_LENGTH}-character limit`);
            if (skippedCount)   parts.push(`${skippedCount} term${skippedCount !== 1 ? "s" : ""} would exceed the ${MAX_TERM_COUNT}-term limit`);
            showFeedback(`No terms imported — ${parts.join("; ")}.`, "error");
          } else {
            showFeedback("No changes — all terms already match.");
          }
          return;
        }

        chrome.storage.local.set({ userTerms: [...mergedExisting, ...added] }, () => {
          if (chrome.runtime.lastError) {
            showFeedback("Failed to save terms: " + chrome.runtime.lastError.message, "error");
            return;
          }
          const parts = [];
          if (added.length > 0)
            parts.push(`Imported ${added.length} new term${added.length !== 1 ? "s" : ""}`);
          if (updated > 0)
            parts.push(`updated ${updated} existing term${updated !== 1 ? "s" : ""}`);
          if (skippedNoAlnum)
            parts.push(`${skippedNoAlnum} skipped (no alphanumeric characters)`);
          if (skippedLength)
            parts.push(`${skippedLength} skipped (too long)`);
          if (skippedCount)
            parts.push(`${skippedCount} skipped (limit reached)`);
          // Capitalise first letter to handle the "Updated N…" only case.
          const msg = parts.join(", ");
          showFeedback(msg.charAt(0).toUpperCase() + msg.slice(1) + ".", "success");
        });
      });
    };
    reader.readAsText(file);
    importCsvFile.value = "";
  });

  // --- Backup Settings (full JSON) ---

  backupBtn.addEventListener("click", () => {
    chrome.storage.local.get(["userTerms", "patternSettings", "siteEnabled", "emailReplacement", "monitorTyping"], (result) => {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        userTerms: result.userTerms || [],
        patternSettings: result.patternSettings || {},
        siteEnabled: result.siteEnabled || {},
        emailReplacement: result.emailReplacement || "",
        monitorTyping: result.monitorTyping === true,
      };
      download(JSON.stringify(data, null, 2), "llm-scrub-backup.json", "application/json");
    });
  });

  // --- Restore Settings (full JSON) ---

  restoreBtn.addEventListener("click", () => {
    restoreFile.click();
  });

  restoreFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      let data;
      try {
        data = JSON.parse(event.target.result);
      } catch (_) {
        showFeedback("Failed to parse backup file.", "error");
        return;
      }

      const sanitized = validateAndSanitizeBackup(data);
      if (!sanitized) {
        showFeedback("Invalid backup file.", "error");
        return;
      }

      chrome.storage.local.set(sanitized, () => {
        if (chrome.runtime.lastError) {
          showFeedback("Failed to restore backup: " + chrome.runtime.lastError.message, "error");
          return;
        }
        renderSiteList(sanitized.siteEnabled);
        showFeedback("Backup restored successfully.", "success");
      });
    };
    reader.readAsText(file);
    restoreFile.value = "";
  });

  // --- Helpers ---

  // Validates and sanitizes a parsed backup object before writing to storage.
  // Returns a clean { userTerms, patternSettings, siteEnabled } object, or null
  // if the backup is structurally invalid. All IDs are re-generated to prevent
  // any injected values from reaching innerHTML (data-id attribute).
  function validateAndSanitizeBackup(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (typeof data.version !== "number") return null;
    if (!Array.isArray(data.userTerms)) return null;
    if (data.userTerms.length > MAX_TERM_COUNT) return null;

    const userTerms = [];
    for (const item of data.userTerms) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      if (typeof item.term !== "string" || item.term.length === 0) return null;
      if (item.term.length > MAX_TERM_LENGTH) return null;
      // Re-generate ID — never trust an ID from an external file
      const restored = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        term: item.term,
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        partialMatch:  item.partialMatch  === true,
        caseSensitive: item.caseSensitive === true,
      };
      if (typeof item.replacement === "string" && item.replacement && item.replacement.length <= MAX_TERM_LENGTH) {
        restored.replacement = item.replacement;
      }
      userTerms.push(restored);
    }

    // Only keep known pattern keys with boolean values; discard everything else
    const patternSettings = {};
    if (data.patternSettings && typeof data.patternSettings === "object" && !Array.isArray(data.patternSettings)) {
      for (const key of KNOWN_PATTERN_KEYS) {
        if (typeof data.patternSettings[key] === "boolean") {
          patternSettings[key] = data.patternSettings[key];
        }
      }
    }

    // Only keep string hostname keys with boolean values
    const siteEnabled = {};
    if (data.siteEnabled && typeof data.siteEnabled === "object" && !Array.isArray(data.siteEnabled)) {
      for (const [key, val] of Object.entries(data.siteEnabled)) {
        if (typeof val === "boolean") siteEnabled[key] = val;
      }
    }

    const emailReplacement = typeof data.emailReplacement === "string" ? data.emailReplacement : "";
    const monitorTyping = data.monitorTyping === true;

    return { userTerms, patternSettings, siteEnabled, emailReplacement, monitorTyping };
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Auto-detect CSV delimiter by counting unquoted occurrences in the header line.
  function detectDelimiter(headerLine) {
    const commas = (headerLine.match(/,/g) || []).length;
    const semicolons = (headerLine.match(/;/g) || []).length;
    return semicolons > commas ? ";" : ",";
  }

  // Parse a CSV field value from a raw (possibly quoted) string.
  function parseCsvField(raw) {
    const s = raw.trim();
    if (s.startsWith('"')) {
      return s.slice(1, s.endsWith('"') ? -1 : undefined).replace(/""/g, '"');
    }
    return s;
  }

  // Split a CSV line into fields, respecting quoted fields.
  function parseCsvLine(line, delimiter) {
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        fields.push(parseCsvField(current));
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(parseCsvField(current));
    return fields;
  }

  // Parse full CSV text. Returns an array of term objects, or null if the
  // required "term" header column is missing.
  function parseCsv(text) {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0) return [];

    const delimiter = detectDelimiter(lines[0]);
    const headers = parseCsvLine(lines[0], delimiter).map((h) => h.toLowerCase());
    const termIdx = headers.indexOf("term");
    if (termIdx === -1) return null;

    const partialMatchIdx  = headers.indexOf("partialmatch");
    const caseSensitiveIdx = headers.indexOf("casesensitive");
    const replacementIdx   = headers.indexOf("replacement");

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = parseCsvLine(line, delimiter);
      const term = fields[termIdx] || "";
      if (!term) continue;

      const rawPartialMatch  = partialMatchIdx  !== -1 ? (fields[partialMatchIdx]  || "") : "";
      const rawCaseSensitive = caseSensitiveIdx !== -1 ? (fields[caseSensitiveIdx] || "") : "";
      const rawReplacement   = replacementIdx   !== -1 ? (fields[replacementIdx]   || "") : "";

      rows.push({
        term,
        partialMatch:  rawPartialMatch.toLowerCase()  === "true",
        caseSensitive: rawCaseSensitive.toLowerCase() === "true",
        replacement:   rawReplacement,
      });
    }
    return rows;
  }

  // Encode a single CSV line, quoting fields that contain commas, quotes, or newlines.
  function toCsvLine(fields) {
    return fields.map((f) => {
      const s = String(f);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(",");
  }
});
