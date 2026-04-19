# TripExtract — Setup Guide

## How to load the extension in Chrome (takes 2 minutes)

### Step 1: Open Chrome extensions
Go to `chrome://extensions` in your browser address bar.

### Step 2: Enable Developer Mode
Toggle **Developer mode** ON (top-right corner of the extensions page).

### Step 3: Load the extension
Click **"Load unpacked"** → navigate to and select the **TripExtract** folder (the one containing `manifest.json`).

The TripExtract icon (orange map pin) will appear in your Chrome toolbar.  
If you don't see it, click the puzzle piece icon and pin TripExtract.

---

## How to use it

1. Go to any YouTube travel or food tour video
2. Click the **TripExtract** icon in your toolbar
3. First time only: click **"API Key Settings"** → paste your Anthropic API key → Save
4. Click **"Extract places"**
5. Wait ~5–10 seconds while it reads the transcript and asks Claude to find all places
6. Click **"Open in Maps"** on any place card to go straight to Google Maps

---

## API Keys

### Anthropic API Key (Required)
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up / log in → **API Keys** → **Create Key**
3. Copy the key (`sk-ant-…`) and paste it into TripExtract's **API Key Settings**

**Cost:** Uses Claude Haiku 4.5. A typical travel video transcript costs under $0.01.

---

### Google Places API Key (Optional — adds verified addresses + ratings)

Without this key, every place card shows a Google Maps *search* link.  
With this key, every card shows the **real verified address**, star rating, and a direct place link.

**Setup steps:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Go to **APIs & Services → Library** → search **"Places API (New)"** → Enable it
4. Go to **APIs & Services → Credentials** → **Create Credentials → API Key**
5. (Recommended) Restrict the key to "Places API (New)" in the key settings
6. Paste the key (`AIzaSy…`) into TripExtract's settings under **Google Places API Key**

**Cost:** $0.032 per place verified (Text Search). A 10-place video = ~$0.32.  
Google gives $200/month free credit, which covers ~6,000 verifications.

---

## File structure

```
TripExtract/
├── manifest.json      — Extension config (Manifest V3)
├── background.js      — Service worker: Claude API calls
├── content.js         — YouTube page script: transcript extraction
├── popup.html         — Extension popup shell
├── popup.js           — Popup UI logic + place card rendering
├── styles.css         — Shared styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── SETUP.md           — This file
```

---

## How transcript extraction works

The extension uses two strategies in order:

**Strategy 1 (Primary — instant, no UI interaction):**
YouTube injects a JavaScript object called `ytInitialPlayerResponse` into every watch page.
This object contains metadata for all caption tracks including a direct URL to the caption
data. The extension fetches this URL and parses the JSON3 caption format into clean text.
This works on ~95% of videos that have any captions (including auto-generated ones).

**Strategy 2 (Fallback — DOM scraping):**
If Strategy 1 fails, the extension clicks YouTube's "⋮ More actions" menu → "Show transcript"
and scrapes the text from the transcript panel that opens.

If neither works, the extension tells you "No captions available for this video."

---

## Troubleshooting

**"No captions found"** — The video has no captions (very rare for English videos). Try a different video.

**"Could not parse AI response"** — Usually a network hiccup. Click Extract again.

**Extension doesn't appear** — Make sure Developer Mode is on and you selected the right folder (the one with `manifest.json` inside).

**Maps link wrong place** — The MVP uses Google Maps search queries. A future version will add Google Places API for exact address verification.

---

## What's next (roadmap)

- [ ] Google Places API integration for verified addresses
- [ ] "Send to phone" (email/SMS) 
- [ ] Export to Google Maps list
- [ ] Freemium usage counter
- [ ] Chrome Web Store listing
