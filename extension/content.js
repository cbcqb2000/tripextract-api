/**
 * TripExtract — Content Script
 *
 * Kept intentionally minimal. Transcript extraction now happens entirely
 * in background.js via chrome.scripting.executeScript (world: "MAIN"),
 * which bypasses both the isolated-world restriction and YouTube's CSP.
 *
 * This file only handles GET_VIDEO_INFO, which reads basic DOM data
 * that's safely accessible from the isolated world.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_VIDEO_INFO") {
    sendResponse(getVideoInfo());
  }
});

function getVideoInfo() {
  const videoId = new URLSearchParams(window.location.search).get("v");
  const title =
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.innerText ||
    document.querySelector("h1.style-scope.ytd-watch-metadata")?.innerText ||
    document.querySelector("h1.ytd-video-primary-info-renderer yt-formatted-string")?.innerText ||
    document.title.replace(" - YouTube", "").trim();
  return { videoId, title, url: window.location.href };
}

console.log("[TripExtract] Ready on:", window.location.href);
