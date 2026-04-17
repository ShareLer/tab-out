/**
 * background.js — Service Worker for Badge Updates & Recently Closed
 *
 * Chrome's "always-on" background script for Tab View.
 * Responsibilities:
 * 1. Keep the toolbar badge showing the current open tab count
 * 2. Track all open tabs' info so we can save to Recently Closed when closed
 *
 * Badge color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

const MAX_RECENTLY_CLOSED = 50;

// Cache of all open tabs' info (keyed by tabId)
// This allows us to get URL/title when a tab is closed (onRemoved doesn't provide it)
const tabsCache = new Map();

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Update tabs cache with current info
    tabs.forEach(tab => {
      if (tab.id && tab.url) {
        tabsCache.set(tab.id, {
          url: tab.url,
          title: tab.title || tab.url,
        });
      }
    });

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Recently Closed tracker ───────────────────────────────────────────────────

/**
 * addToRecentlyClosed(tab)
 *
 * Saves a closed tab to the recently closed list in storage.
 */
async function addToRecentlyClosed(tab) {
  // Skip chrome internal pages
  const url = tab.url || '';
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://') ||
    url.startsWith('brave://')
  ) {
    return;
  }

  try {
    const { recentlyClosed = [] } = await chrome.storage.local.get('recentlyClosed');

    // Get favicon from URL
    let favicon = '';
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
    } catch {}

    // Add new entry at the beginning (most recent)
    recentlyClosed.unshift({
      id:        Date.now().toString(),
      url:       url,
      title:     tab.title || url,
      closedAt:  new Date().toISOString(),
      favicon:   favicon,
    });

    // Keep only the most recent entries
    if (recentlyClosed.length > MAX_RECENTLY_CLOSED) {
      recentlyClosed.splice(MAX_RECENTLY_CLOSED);
    }

    await chrome.storage.local.set({ recentlyClosed });
  } catch (err) {
    console.warn('[tab-view] Failed to save to recently closed:', err);
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Track new tabs and update badge
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id && tab.url) {
    tabsCache.set(tab.id, {
      url: tab.url,
      title: tab.title || tab.url,
    });
  }
  updateBadge();
});

// Track closed tabs — save to Recently Closed and update badge
chrome.tabs.onRemoved.addListener((tabId) => {
  // Get tab info from cache before removing
  const tabInfo = tabsCache.get(tabId);
  if (tabInfo) {
    addToRecentlyClosed(tabInfo);
    tabsCache.delete(tabId);
  }
  updateBadge();
});

// Track tab URL/title changes and update badge
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId && (changeInfo.url || changeInfo.title)) {
    tabsCache.set(tabId, {
      url: tab.url,
      title: tab.title || tab.url,
    });
  }
  updateBadge();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
