/**
 * LLM Scrub — Rules Engine
 * Handles both auto-detected patterns (regex) and user-defined terms.
 * All processing is local. Nothing leaves the browser.
 */

const LLMScrubRules = (() => {
  // Built-in regex patterns for auto-detection
  // NOTE: order matters — creditCard must run before phone to prevent the phone
  // regex from matching digit subsequences inside card numbers before Luhn validation.
  const builtinPatterns = {
    email: {
      label: "Email",
      regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
      placeholder: "EMAIL",
      enabled: true,
    },
    creditCard: {
      label: "Credit Card",
      // Requires digit groups separated by spaces or dashes to avoid matching
      // unbroken digit strings (IDs, timestamps, etc.). Covers 13-19 digit cards:
      // standard 4-4-4-4 (Visa/MC/Discover), Amex 4-6-5, and longer variants.
      regex: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}\b|\b\d{4}[ -]\d{6}[ -]\d{5}\b/g,
      placeholder: "CREDIT_CARD",
      enabled: true,
    },
    phone: {
      label: "Phone Number",
      // Four alternatives:
      // 1. Compact international: +381694449990 (+ followed by 7-15 consecutive digits)
      // 2. Formatted NANP: (555) 123-4567 / (555)123-4567 / 555-123-4567 / +1-555-123-4567
      //    Separator after parenthesized area code is optional to handle (555)123-4567 style.
      // 3. Bare 10-digit US: 5551234567 — uses \w guards (not just \d) so digits adjacent to
      //    letters (e.g. tracking numbers like 1Z999AA10123456784) are not matched.
      // 4. Spaced/dashed international: +44 7911 123456 / +49 30 12345678 — country code
      //    (1-3 digits) followed by 2-4 separator-delimited groups of 2-8 digits each.
      regex: /(?<!\d)\+\d{7,15}(?!\d)|(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)|(?<!\w)(?:\+?1[-.\s]?)?\d{10}(?!\w)|(?<!\w)\+\d{1,3}(?:[\s-]\d{2,8}){2,4}(?!\w)/g,
      placeholder: "PHONE",
      enabled: true,
    },
    ssn: {
      label: "SSN",
      regex: /\b\d{3}-\d{2}-\d{4}\b/g,
      placeholder: "SSN",
      enabled: true,
    },
  };

  /**
   * Build a regex and metadata for matching a single user term.
   * Shared between scrub() (paste path) and the content script (typing path)
   * to ensure identical matching semantics in both contexts.
   *
   * isPartial=true  → bare escaped pattern, no word boundaries (caller expands
   *                   to the full containing word as needed).
   * isPartial=false → \b-anchored where the term starts/ends with \w; a
   *                   non-capturing possessive group (?:'s|'s)? is appended when
   *                   the term ends with \w, and the term itself is wrapped in
   *                   capture group 1 so callers can isolate it from the suffix.
   *
   * Returns { regex, hasPossessiveGroup }.
   */
  function buildTermPattern(term, caseSensitive, isPartial) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = caseSensitive ? "g" : "gi";
    if (isPartial) {
      return { regex: new RegExp(escaped, flags), hasPossessiveGroup: false };
    }
    const firstIsWord = /\w/.test(term[0]);
    const lastIsWord  = /\w/.test(term[term.length - 1]);
    if (lastIsWord) {
      return {
        regex: new RegExp(
          `${firstIsWord ? "\\b" : ""}(${escaped})(?:'s|\u2019s)?\\b`,
          flags
        ),
        hasPossessiveGroup: true,
      };
    }
    return {
      regex: new RegExp(`${firstIsWord ? "\\b" : ""}${escaped}`, flags),
      hasPossessiveGroup: false,
    };
  }

  /**
   * Scrub text using both builtin patterns and user-defined terms.
   * Returns { scrubbed, replacements } where replacements is an array of
   * { original, replacement, type, position } objects.
   * options.emailReplacement: if non-empty, use as exact replacement for all
   * emails; otherwise use user1@example.com, user2@example.com, … format.
   */
  function scrub(text, userTerms = [], patternSettings = {}, options = {}) {
    const replacements = [];
    let scrubbed = text;

    // 1. User-defined terms first (they're exact matches, higher priority)
    //    Sort by length descending so longer matches aren't partially eaten by shorter ones.
    const sortedTerms = [...userTerms].sort(
      (a, b) => b.term.length - a.term.length
    );

    if (sortedTerms.some((t) => t.term)) {
      // Identify email spans in the current text so term replacement doesn't
      // corrupt email addresses (e.g. "internal.acme.com" matching inside
      // "admin@internal.acme.com" and producing "admin@[TERM_1]").
      const emailIsEnabled =
        patternSettings.email !== undefined
          ? patternSettings.email
          : builtinPatterns.email.enabled;
      const emailSpans = [];
      if (emailIsEnabled) {
        const epRegex = new RegExp(
          builtinPatterns.email.regex.source,
          builtinPatterns.email.regex.flags
        );
        let em;
        while ((em = epRegex.exec(scrubbed)) !== null) {
          emailSpans.push({ start: em.index, end: em.index + em[0].length });
        }
      }

      // Find all URLs once (for URL-expansion logic: "company.com" as a term
      // should replace the entire "https://company.com/" not just the host).
      const urlRegex = /https?:\/\/\S+/gi;
      const urls = [];
      let urlMatch;
      while ((urlMatch = urlRegex.exec(scrubbed)) !== null) {
        urls.push({ start: urlMatch.index, end: urlMatch.index + urlMatch[0].length });
      }

      // Collect all term spans across every term before applying any replacement.
      // This gives us a single sorted list so we can assign TERM_1..N in
      // top-to-bottom document order rather than resetting per term.
      const allTermSpans = [];

      for (const { term, partialMatch, matchMode, caseSensitive = false, replacement } of sortedTerms) {
        if (!term) continue;
        // Support both new (partialMatch) and old (matchMode) storage schema
        const isPartial = partialMatch !== undefined ? partialMatch : matchMode === "substring";

        const { regex: termRegex, hasPossessiveGroup } = buildTermPattern(term, caseSensitive, isPartial);
        let match;
        while ((match = termRegex.exec(scrubbed)) !== null) {
          const mStart = match.index;
          // When the possessive capture group is active, match[1] is the term alone.
          // Use its length as mEnd so the possessive suffix stays in the output.
          const mEnd = hasPossessiveGroup ? mStart + match[1].length : mStart + match[0].length;

          // Skip matches that fall entirely inside a protected email address.
          if (emailSpans.some((e) => mStart >= e.start && mEnd <= e.end)) continue;

          // For partial mode, expand the matched region to the full containing
          // word (continuous non-whitespace run) so the placeholder replaces the
          // whole word rather than leaving a partial stub like "[TERM_1]lication".
          let spanStart = mStart;
          let spanEnd = mEnd;
          if (isPartial) {
            while (spanStart > 0 && !/\s/.test(scrubbed[spanStart - 1])) spanStart--;
            while (spanEnd < scrubbed.length && !/\s/.test(scrubbed[spanEnd])) {
              // Stop before a possessive suffix ('s or \u2019s) at the end of the word.
              // "end of word" means the 's is followed by whitespace, punctuation, or EOS.
              const ch = scrubbed[spanEnd];
              if (ch === "'" || ch === "\u2019") {
                const afterApos = scrubbed[spanEnd + 1];
                if ((afterApos === "s" || afterApos === "S") &&
                    (spanEnd + 2 >= scrubbed.length || /[\s\W]/.test(scrubbed[spanEnd + 2]))) {
                  break;
                }
              }
              spanEnd++;
            }
          }

          // Skip matches that overlap a span already claimed by a longer term.
          if (allTermSpans.some((s) => spanStart < s.end && spanEnd > s.start)) continue;

          // Expand to the full URL when the match is inside one.
          let inUrl = false;
          for (const url of urls) {
            if (mStart >= url.start && mEnd <= url.end) {
              // Only add URL span if not already claimed.
              if (!allTermSpans.some((s) => s.start === url.start && s.end === url.end)) {
                allTermSpans.push({ start: url.start, end: url.end, replacement: replacement || null });
              }
              inUrl = true;
              break;
            }
          }
          if (!inUrl) {
            allTermSpans.push({ start: spanStart, end: spanEnd, replacement: replacement || null });
          }
        }
      }

      // Sort by document position. Assign placeholders in forward order so
      // TERM_N numbering reflects document order; only increment the counter
      // for spans without a custom replacement. Then apply in reverse so
      // earlier replacements don't shift the indices of later ones.
      allTermSpans.sort((a, b) => a.start - b.start);
      let termN = options.startCounters?.term ?? 0;
      for (const span of allTermSpans) {
        span.placeholder = span.replacement ? span.replacement : `[TERM_${++termN}]`;
      }
      for (let i = allTermSpans.length - 1; i >= 0; i--) {
        const { start, end, placeholder } = allTermSpans[i];
        replacements.push({
          original: scrubbed.substring(start, end),
          replacement: placeholder,
          type: "user_term",
          position: start,
        });
        scrubbed =
          scrubbed.substring(0, start) + placeholder + scrubbed.substring(end);
      }
    }

    // 2. Built-in patterns
    for (const [key, pattern] of Object.entries(builtinPatterns)) {
      // Check if this pattern is enabled (user might have toggled it off)
      const isEnabled =
        patternSettings[key] !== undefined
          ? patternSettings[key]
          : pattern.enabled;

      if (!isEnabled) continue;

      // Need a fresh regex each time (because of lastIndex with /g flag)
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);

      const matches = [];
      let m;
      while ((m = regex.exec(scrubbed)) !== null) {
        // Skip if this match overlaps with something already replaced (contains [ ])
        if (m[0].includes("[") && m[0].includes("]")) continue;
        matches.push({ value: m[0], index: m.index });
      }

      // Replace in reverse to preserve indices; number by forward position (i+1),
      // offset by startCounters so numbers don't collide with existing placeholders.
      const startN = options.startCounters?.[key] ?? 0;
      for (let i = matches.length - 1; i >= 0; i--) {
        let placeholder;
        if (key === "email") {
          const emailReplacement = options.emailReplacement || "";
          placeholder = emailReplacement ? emailReplacement : `user${startN + i + 1}@example.com`;
        } else {
          placeholder = `[${pattern.placeholder}_${startN + i + 1}]`;
        }
        replacements.push({
          original: matches[i].value,
          replacement: placeholder,
          type: key,
          position: matches[i].index,
        });
        scrubbed =
          scrubbed.substring(0, matches[i].index) +
          placeholder +
          scrubbed.substring(matches[i].index + matches[i].value.length);
      }
    }

    return { scrubbed, replacements };
  }

  return { scrub, buildTermPattern };
})();

// Make available for content script (both run in same content script context)
if (typeof window !== "undefined") {
  window.LLMScrubRules = LLMScrubRules;
}
