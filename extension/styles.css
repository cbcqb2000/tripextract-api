/**
 * TripExtract — Popup Script
 */

const TRIPEXTRACT_API = "https://tripextract-api.vercel.app";

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  view: "idle",       // idle | not-youtube | loading | results | error
  places: [],
  verifiedCount: 0,
  videoInfo: null,
  errorMsg: "",
  loadingStep: "",    // "transcript" | "ai" | "places"
  selected: new Set(), // indices of selected place cards
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes("youtube.com/watch")) {
    state.view = "not-youtube";
    render();
    return;
  }

  try {
    const info = await sendToContent(tab.id, { type: "GET_VIDEO_INFO" });
    state.videoInfo = info;
  } catch {
    state.videoInfo = { title: tab.title?.replace(" - YouTube", "").trim() };
  }

  // Restore last results for this video if available
  const videoId = new URL(tab.url).searchParams.get("v");
  if (videoId) {
    try {
      const stored = await chrome.storage.local.get(`results_${videoId}`);
      const saved  = stored[`results_${videoId}`];
      if (saved?.places?.length) {
        state.places        = saved.places;
        state.verifiedCount = saved.verifiedCount || 0;
        state.view          = "results";
        render();
        return;
      }
    } catch { /* ignore */ }
  }

  state.view = "idle";
  render();
});

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  document.getElementById("app").innerHTML = buildAppHTML();
  attachEvents();
}

function buildAppHTML() {
  if (state.view === "not-youtube") return buildNotYouTubeHTML();

  let html = "";

  // Video title bar
  if (state.videoInfo?.title) {
    html += `
      <div class="video-info">
        <div class="label">Current video</div>
        <div class="title" title="${esc(state.videoInfo.title)}">${esc(state.videoInfo.title)}</div>
      </div>`;
  }

  // Extract button
  if (state.view !== "loading") {
    html += `
      <div class="extract-section">
        <button class="btn-extract" id="btnExtract">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
          ${state.places.length > 0 ? "Re-extract places" : "Extract places"}
        </button>
      </div>`;
  }

  // Loading
  if (state.view === "loading") {
    const steps = {
      transcript: { text: "Reviewing video…",             pct: 20 },
      ai:         { text: "Locating places mentioned…",   pct: 55 },
      places:     { text: "Pinning locations on the map…", pct: 80 },
    };
    const step = steps[state.loadingStep] || { text: "Starting up…", pct: 5 };
    html += `
      <div class="status-area">
        <div class="status-message loading">
          <div class="spinner"></div>
          <span>${step.text}</span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width:${step.pct}%"></div>
        </div>
      </div>`;
  }

  // Error
  if (state.view === "error") {
    html += `
      <div class="status-area">
        <div class="status-message error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          <span>${esc(state.errorMsg)}</span>
        </div>
      </div>`;
  }

  // Results
  if (state.places.length > 0) {
    html += buildResultsHTML();
  }

  return html;
}

function buildNotYouTubeHTML() {
  return `
    <div class="empty-state">
      <div class="icon">🗺️</div>
      <h3>Open a YouTube travel video</h3>
      <p>Navigate to a YouTube video, then click the TripExtract icon to extract all the places mentioned.</p>
    </div>`;
}

// ─── Results ──────────────────────────────────────────────────────────────────

function buildResultsHTML() {
  const count       = state.places.length;
  const verified    = state.verifiedCount;
  const selCount    = state.selected.size;
  const allSelected = selCount === count;
  const hasVerified = state.places.some((p) => p.verified);

  const verifiedBadge = hasVerified
    ? `<span class="verified-summary">${verified}/${count} verified</span>`
    : "";

  const actionBar = selCount > 0 ? `
    <div class="action-bar">
      <span class="action-bar-count"><strong>${selCount}</strong> of ${count} selected</span>
      <button class="btn-action btn-action--copy" id="btnCopySelected">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
        Copy
      </button>
      <button class="btn-action btn-action--email" id="btnEmailSelected">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
        </svg>
        Email
      </button>
    </div>` : "";

  return `
    <div class="results-header">
      <div class="results-count">
        <span>${count}</span> place${count !== 1 ? "s" : ""} found ${verifiedBadge}
      </div>
      <button class="btn-copy-all" id="btnCopyAll">Copy all</button>
    </div>
    <div class="select-row">
      <label>
        <input type="checkbox" class="select-all-check" id="chkSelectAll" ${allSelected ? "checked" : ""}>
        ${allSelected ? "Deselect all" : "Select all"}
      </label>
    </div>
    <div class="places-list">
      ${state.places.map((p, i) => buildPlaceCard(p, i)).join("")}
    </div>
    ${actionBar}`;
}

const TYPE_EMOJI = {
  restaurant:   "🍽️",
  cafe:         "☕",
  bar:          "🍺",
  hotel:        "🏨",
  landmark:     "🏛️",
  neighborhood: "🏘️",
  park:         "🌳",
  market:       "🛒",
  museum:       "🖼️",
  attraction:   "⭐",
  other:        "📍",
};

function buildPlaceCard(place, index) {
  const emoji     = TYPE_EMOJI[place.type] || "📍";
  const mapsUrl   = buildMapsUrl(place);
  const typeLabel = place.type
    ? place.type.charAt(0).toUpperCase() + place.type.slice(1)
    : "Place";

  const addressLine = place.address
    ? `<div class="place-address">
         <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
           <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
         </svg>
         ${esc(place.address)}
       </div>`
    : place.city
    ? `<div class="place-address place-address--ai">
         <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
           <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
         </svg>
         ${esc(place.city)}
       </div>`
    : "";

  const verifiedBadge = place.verified
    ? `<span class="badge badge--verified">
         <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
           <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
         </svg>
         Verified
       </span>`
    : "";

  const reviewsUrl = place.reviewsUrl || (place.placeId ? `https://search.google.com/local/reviews?placeid=${place.placeId}` : null);
  const ratingLine = place.verified && place.rating
    ? `<div class="place-rating">
         <span class="stars">${renderStars(place.rating)}</span>
         <span class="rating-num">${place.rating.toFixed(1)}</span>
         ${place.userRatingCount ? `<span class="rating-count">(${formatCount(place.userRatingCount)})</span>` : ""}
         ${reviewsUrl ? `<a class="rating-reviews-link" href="${reviewsUrl}" target="_blank" rel="noopener">Reviews →</a>` : ""}
       </div>`
    : "";

  const isSelected = state.selected.has(index);
  return `
    <div class="place-card ${place.verified ? "place-card--verified" : ""} ${isSelected ? "place-card--selected" : ""}" data-index="${index}">
      <div class="place-card-top place-card-check">
        <input type="checkbox" class="place-checkbox" data-check="${index}" ${isSelected ? "checked" : ""}>
        <div class="place-name-block">
          <div class="place-name-row">
            <div class="place-name" title="${esc(place.name)}">${esc(place.name)}</div>
            ${verifiedBadge}
          </div>
          <div class="place-meta">${typeLabel}${place.since ? ` · Est. ${place.since}` : ""}</div>
        </div>
      </div>
      ${addressLine}
      ${ratingLine}
      ${place.knownFor ? `<div class="place-known-for">${esc(place.knownFor)}</div>` : ""}
      <div class="place-actions">
        <a class="btn-maps" href="${mapsUrl}" target="_blank" rel="noopener">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
          ${place.verified ? "Open in Maps" : "Search in Maps"}
        </a>
        ${place.websiteUrl ? `
        <a class="btn-website" href="${place.websiteUrl}" target="_blank" rel="noopener" title="Visit website">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
          </svg>
        </a>` : ""}
        <button class="btn-copy-card" data-copy="${index}" title="Copy place info">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
          </svg>
        </button>
      </div>
    </div>`;
}


// ─── Events ───────────────────────────────────────────────────────────────────

function attachEvents() {
  document.getElementById("btnExtract")?.addEventListener("click", handleExtract);

  // Copy all
  document.getElementById("btnCopyAll")?.addEventListener("click", () => {
    copyToClipboard(state.places.map(formatPlaceForCopy).join("\n\n"));
    showToast("All places copied!");
  });

  // Select all / deselect all
  document.getElementById("chkSelectAll")?.addEventListener("change", (e) => {
    if (e.target.checked) {
      state.places.forEach((_, i) => state.selected.add(i));
    } else {
      state.selected.clear();
    }
    render();
  });

  // Individual card checkboxes
  document.querySelectorAll("[data-check]").forEach((chk) => {
    chk.addEventListener("change", (e) => {
      const i = parseInt(e.target.dataset.check, 10);
      if (e.target.checked) state.selected.add(i);
      else state.selected.delete(i);
      render();
    });
  });

  // Copy selected
  document.getElementById("btnCopySelected")?.addEventListener("click", () => {
    const text = [...state.selected]
      .sort((a, b) => a - b)
      .map((i) => formatPlaceForCopy(state.places[i]))
      .join("\n\n");
    copyToClipboard(text);
    showToast(`${state.selected.size} place${state.selected.size !== 1 ? "s" : ""} copied!`);
  });

  // Email selected
  document.getElementById("btnEmailSelected")?.addEventListener("click", handleEmailSelected);

  // Copy individual card
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.copy, 10);
      if (state.places[i]) {
        copyToClipboard(formatPlaceForCopy(state.places[i]));
        showToast("Copied!");
      }
    });
  });
}

// ─── Email modal ──────────────────────────────────────────────────────────────

function handleEmailSelected() {
  const selectedPlaces = [...state.selected]
    .sort((a, b) => a - b)
    .map((i) => state.places[i]);

  showEmailModal(selectedPlaces);
}

function showEmailModal(places) {
  // Remove any existing modal
  document.getElementById("emailModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "emailModal";
  modal.className = "email-modal-overlay";
  modal.innerHTML = `
    <div class="email-modal">
      <div class="email-modal-header">
        <span>Send ${places.length} place${places.length !== 1 ? "s" : ""} to email</span>
        <button class="email-modal-close" id="emailModalClose">✕</button>
      </div>
      <div class="email-modal-body">
        <input
          type="email"
          id="emailModalInput"
          class="email-modal-input"
          placeholder="your@email.com"
          autocomplete="email"
        />
        <button class="email-modal-send" id="emailModalSend">Send</button>
      </div>
      <div class="email-modal-status" id="emailModalStatus"></div>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById("emailModalClose").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

  const input = document.getElementById("emailModalInput");
  input.focus();

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendEmail(places, modal);
  });

  document.getElementById("emailModalSend").addEventListener("click", () => {
    sendEmail(places, modal);
  });
}

async function sendEmail(places, modal) {
  const input  = document.getElementById("emailModalInput");
  const status = document.getElementById("emailModalStatus");
  const btn    = document.getElementById("emailModalSend");
  const to     = input.value.trim();

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    status.textContent = "Please enter a valid email address.";
    status.className   = "email-modal-status error";
    return;
  }

  btn.disabled    = true;
  btn.textContent = "Sending…";
  status.textContent = "";
  status.className   = "email-modal-status";

  try {
    const videoTitle = state.videoInfo?.title || "YouTube Travel Video";
    const resp = await fetch(`${TRIPEXTRACT_API}/api/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, videoTitle, places }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Send failed");

    status.textContent = "Sent! Check your inbox.";
    status.className   = "email-modal-status success";
    btn.textContent    = "Sent ✓";

    setTimeout(() => modal.remove(), 2000);
  } catch (e) {
    status.textContent = e.message || "Something went wrong. Try again.";
    status.className   = "email-modal-status error";
    btn.disabled    = false;
    btn.textContent = "Send";
  }
}

// ─── Extract flow ─────────────────────────────────────────────────────────────

async function handleExtract() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Step 1 — transcript
  state.view        = "loading";
  state.loadingStep = "transcript";
  state.selected.clear();
  render();

  const transcriptResponse = await chrome.runtime.sendMessage({
    type:  "GET_TRANSCRIPT",
    tabId: tab.id,
  });

  if (!transcriptResponse?.success) {
    state.view = "error";
    const raw = transcriptResponse?.error || "";
    if (raw) console.warn("[TripExtract] transcript error:", raw);
    state.errorMsg = "Couldn't read this video. Try refreshing the page and clicking Extract again.";
    render();
    return;
  }

  // Step 2 — AI + Places
  state.loadingStep = "ai";
  render();

  setTimeout(() => {
    if (state.view === "loading") { state.loadingStep = "places"; render(); }
  }, 1500);

  try {
    const response = await chrome.runtime.sendMessage({
      type:       "EXTRACT_PLACES",
      transcript: transcriptResponse.transcript,
      videoTitle: transcriptResponse.title || state.videoInfo?.title,
    });

    if (!response?.success) throw new Error(response?.error || "Extraction failed");

    state.places        = response.places;
    state.verifiedCount = response.verifiedCount || 0;
    state.view          = "results";

    // Persist results so they survive popup close/reopen
    const videoId = new URL(tab.url).searchParams.get("v");
    if (videoId) {
      chrome.storage.local.set({
        [`results_${videoId}`]: {
          places:        state.places,
          verifiedCount: state.verifiedCount,
        },
      });
    }

    render();
  } catch (err) {
    state.view     = "error";
    state.errorMsg = err.message;
    render();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function buildMapsUrl(place) {
  if (place.mapsUrl)  return place.mapsUrl;
  if (place.placeId)  return `https://www.google.com/maps/place/?q=place_id:${place.placeId}`;
  const q = encodeURIComponent([place.name, place.city].filter(Boolean).join(", "));
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function formatPlaceForCopy(place) {
  const emoji = TYPE_EMOJI[place.type] || "📍";
  let text = `${emoji} ${place.name}`;
  if (place.address)  text += `\n📍 ${place.address}`;
  else if (place.city) text += `\n📍 ${place.city}`;
  if (place.rating)   text += `\n⭐ ${place.rating.toFixed(1)}`;
  if (place.knownFor) text += `\n${place.knownFor}`;
  if (place.dishes)   text += `\nTry: ${place.dishes}`;
  text += `\n${buildMapsUrl(place)}`;
  return text;
}

function renderStars(rating) {
  const full  = Math.floor(rating);
  const half  = rating - full >= 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  return "★".repeat(full) + (half ? "½" : "") + "☆".repeat(empty);
}

function formatCount(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2000);
}

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
