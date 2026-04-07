# Scrubby — Mask what AI knows about you

A Chrome extension that replaces your personal and work info with placeholders before it reaches AI chats. You decide what to mask — your name, company, product names, anything you don't want AI to remember. Add your terms once, and they're masked automatically on every paste or while typing.

Unlike other tools in this space that focus on auto-detecting PII, Scrubby is built around user-defined terms. No NER model will flag your company name or internal project codenames as sensitive — those are only sensitive because you say they are.

All processing happens **entirely in your browser**. No accounts, no cloud, no analytics, no network requests.

## Installation

Scrubby is not yet on the Chrome Web Store. To install manually:

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the folder containing `manifest.json`
6. Click the puzzle piece icon in Chrome's toolbar and pin Scrubby for easy access

To update, pull the latest changes (or re-download), and click the refresh icon on Scrubby's card in `chrome://extensions/`.

## What It Does

Scrubby works in two modes:

**Paste masking** — when you paste text into a supported AI chat, Scrubby intercepts the paste and replaces sensitive values before the site ever sees them.

**Replace as you type** (opt-in) — as you type, Scrubby automatically replaces custom terms as you finish each word. No paste required.

In both modes, it replaces:

- **Your custom terms** → `[TERM_1]`, `[TERM_2]`, ... (or a custom replacement you define)
- **Email addresses** → `user1@example.com`, `user2@example.com`, ... (or a custom replacement)
- **Phone numbers** → `[PHONE_1]`, `[PHONE_2]`, ...
- **SSNs** → `[SSN_1]`, ...
- **Credit card numbers** → `[CREDIT_CARD_1]`, ...

Numbered placeholders let the AI still reason about distinct entities — `[TERM_1]` and `[TERM_2]` stay distinguishable, unlike generic `[REDACTED]`.

## Features

### Custom Terms
Add any words or phrases you want masked: your name, company, project names, colleagues, anything. Per-term options:
- **Partial match** — mask the term even when it appears mid-word (replaces the whole containing word)
- **Case sensitive** — control whether matching is case-sensitive
- **Custom replacement** — use your own placeholder instead of `[TERM_N]`

### Replace as You Type (opt-in)
Enable "Replace as you type" to auto-replace custom terms as you type them, not just on paste. Replacements happen automatically as you finish typing each word. Disabled by default — with an explicit disclaimer that keystrokes may be captured by the site before Scrubby can intervene.

### Paste Masking
Intercepts clipboard pastes before the text reaches the page. Sensitive values are replaced inline — the site never sees the originals.

### Side Panel — Replacement Log
Open the side panel to review every masked paste and auto-replaced term in the current tab. Each entry shows the placeholder and the original value, with **Copy** and **Restore** actions per row. Entries from auto-replace are labeled **typed**.

> Restore is the only action that writes original values back to the page — and only when you explicitly trigger it from the extension-owned side panel. Your original data never touches the host site's DOM otherwise.

### Per-Site Enable/Disable
Turn Scrubby off for specific sites from the Settings page without affecting other sites.

### Export / Import / Backup
- **Export** — save your custom terms as a `.txt` or `.csv` file
- **Import** — load terms from a `.txt` or `.csv` file (merges with existing settings; CSV supports per-term options)
- **Backup / Restore** — full settings snapshot as JSON (terms + pattern toggles + site settings + email replacement + typing preference)

## Privacy

- **No network permissions.** The extension cannot make outbound requests. Chrome enforces this at the browser level.
- **No accounts.** No server. No analytics.
- **Local storage only.** Your terms live in `chrome.storage.local` on your machine. Replacement logs are RAM-only (`chrome.storage.session`) and are cleared when the tab closes.
- **Open source.** Read the code and verify.

## Usage

1. Click the Scrubby icon to open the popup
2. Add terms you want masked — your name, company, project names
3. Toggle built-in detection patterns (email, phone, SSN, credit card) on or off
4. Optionally enable **Replace as you type** to mask terms as you type, not just on paste
5. Paste into any supported AI chat — your terms are replaced automatically
6. Click **Open Log** to see what was replaced in the side panel

## Supported Sites

- ChatGPT (chatgpt.com, chat.openai.com)
- Claude (claude.ai)
- Gemini (gemini.google.com)
- Perplexity (perplexity.ai)
- Copilot (copilot.microsoft.com)
- Mistral (chat.mistral.ai)
- Poe (poe.com)

## Project Structure

```
scrubby/
├── manifest.json       # Extension manifest (Manifest V3)
├── background.js       # Service worker — badge counts, messaging, log storage
├── content.js          # Paste interception, masking, typing auto-replace
├── content.css         # Toast notification styles
├── rules.js            # Pattern engine — regex + user terms
├── popup.html          # Main settings popup
├── popup.js
├── popup.css
├── settings.html       # Export / import / backup / per-site toggles
├── settings.js
├── sidepanel.html      # Replacement log
├── sidepanel.js
├── sidepanel.css
└── icons/
```

## License

GPL-3.0
