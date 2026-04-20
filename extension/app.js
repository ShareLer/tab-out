/* ================================================================
   Tab View — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab View's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab View's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   RECENTLY CLOSED — chrome.storage.local

   Records tabs that were recently closed for quick recovery.
   Limited to 50 most recent entries.

   Data shape stored under the "recentlyClosed" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       closedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       favicon: "https://...",       // favicon URL
     },
     ...
   ]
   ---------------------------------------------------------------- */

const MAX_RECENTLY_CLOSED = 50;

/**
 * addToRecentlyClosed(tab)
 *
 * Adds a closed tab to the recently closed list.
 * Maintains max limit by removing oldest entries.
 */
async function addToRecentlyClosed(tab) {
  const { recentlyClosed = [] } = await chrome.storage.local.get('recentlyClosed');

  // Get favicon from URL
  let favicon = '';
  try {
    const domain = new URL(tab.url).hostname.replace(/^www\./, '');
    favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  } catch {}

  // Add new entry at the beginning (most recent)
  recentlyClosed.unshift({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title || tab.url,
    closedAt:  new Date().toISOString(),
    favicon:   favicon,
  });

  // Keep only the most recent entries
  if (recentlyClosed.length > MAX_RECENTLY_CLOSED) {
    recentlyClosed.splice(MAX_RECENTLY_CLOSED);
  }

  await chrome.storage.local.set({ recentlyClosed });
}

/**
 * getRecentlyClosed()
 *
 * Returns all recently closed tabs from storage.
 */
async function getRecentlyClosed() {
  const { recentlyClosed = [] } = await chrome.storage.local.get('recentlyClosed');
  return recentlyClosed;
}

/**
 * clearRecentlyClosed(id)
 *
 * Removes a specific entry from recently closed list.
 */
async function clearRecentlyClosed(id) {
  const { recentlyClosed = [] } = await chrome.storage.local.get('recentlyClosed');
  const idx = recentlyClosed.findIndex(t => t.id === id);
  if (idx !== -1) {
    recentlyClosed.splice(idx, 1);
    await chrome.storage.local.set({ recentlyClosed });
  }
}

/**
 * clearAllRecentlyClosed()
 *
 * Clears the entire recently closed list.
 */
async function clearAllRecentlyClosed() {
  await chrome.storage.local.set({ recentlyClosed: [] });
}

/**
 * reopenRecentlyClosed(id)
 *
 * Reopens a closed tab and removes it from the list.
 */
async function reopenRecentlyClosed(id) {
  const { recentlyClosed = [] } = await chrome.storage.local.get('recentlyClosed');
  const entry = recentlyClosed.find(t => t.id === id);
  if (entry) {
    // Open the URL in a new tab
    await chrome.tabs.create({ url: entry.url });
    // Remove from list
    await clearRecentlyClosed(id);
  }
}

/* ----------------------------------------------------------------
   PINNED DOMAINS — chrome.storage.local

   Users can pin domain cards to keep them in a fixed position.
   Pinned domains are stored as an array of domain identifiers.

   Data shape stored under the "pinnedDomains" key:
   ["github.com", "__landing-pages__", ...]
   ---------------------------------------------------------------- */

/**
 * getPinnedDomains()
 *
 * Returns the list of pinned domain identifiers from storage.
 */
async function getPinnedDomains() {
  const { pinnedDomains = [] } = await chrome.storage.local.get('pinnedDomains');
  return pinnedDomains;
}

/**
 * savePinnedDomains(domains)
 *
 * Saves the list of pinned domains to storage.
 */
async function savePinnedDomains(domains) {
  await chrome.storage.local.set({ pinnedDomains: domains });
}

/**
 * pinDomain(domainId)
 *
 * Adds a domain to the pinned list.
 */
async function pinDomain(domainId) {
  const pinned = await getPinnedDomains();
  if (!pinned.includes(domainId)) {
    pinned.push(domainId);
    await savePinnedDomains(pinned);
  }
}

/**
 * unpinDomain(domainId)
 *
 * Removes a domain from the pinned list.
 */
async function unpinDomain(domainId) {
  const pinned = await getPinnedDomains();
  const idx = pinned.indexOf(domainId);
  if (idx !== -1) {
    pinned.splice(idx, 1);
    await savePinnedDomains(pinned);
  }
}

/**
 * isDomainPinned(domainId)
 *
 * Checks if a domain is pinned.
 */
async function isDomainPinned(domainId) {
  const pinned = await getPinnedDomains();
  return pinned.includes(domainId);
}


/* ----------------------------------------------------------------
   QUICK LINKS — chrome.storage.local

   Users can add frequently-used links as "quick links" at the top.
   Quick links are stored as an array of link objects.

   Data shape stored under the "quickLinks" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       addedAt: "2026-04-04T10:00:00.000Z"
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * getQuickLinks()
 *
 * Returns all quick links from storage.
 */
async function getQuickLinks() {
  const { quickLinks = [] } = await chrome.storage.local.get('quickLinks');
  return quickLinks;
}

/**
 * saveQuickLinks(links)
 *
 * Saves quick links to storage.
 */
async function saveQuickLinks(links) {
  await chrome.storage.local.set({ quickLinks: links });
}

/**
 * addQuickLink(url, title)
 *
 * Adds a new quick link to storage.
 */
async function addQuickLink(url, title) {
  const links = await getQuickLinks();
  links.push({
    id:      Date.now().toString(),
    url:     url,
    title:   title || url,
    addedAt: new Date().toISOString(),
  });
  await saveQuickLinks(links);
}

/**
 * removeQuickLink(id)
 *
 * Removes a quick link from storage.
 */
async function removeQuickLink(id) {
  const links = await getQuickLinks();
  const idx = links.findIndex(l => l.id === id);
  if (idx !== -1) {
    links.splice(idx, 1);
    await saveQuickLinks(links);
  }
}

/**
 * updateQuickLink(id, url, title)
 *
 * Updates an existing quick link in storage.
 */
async function updateQuickLink(id, url, title) {
  const links = await getQuickLinks();
  const idx = links.findIndex(l => l.id === id);
  if (idx !== -1) {
    links[idx].url = url;
    links[idx].title = title || url;
    await saveQuickLinks(links);
  }
}


/* ----------------------------------------------------------------
   RENDER QUICK LINKS
   ---------------------------------------------------------------- */

/**
 * renderQuickLinks()
 *
 * Renders the quick links section at the top of the dashboard.
 * Always shows the section; displays empty state message when no links.
 */
async function renderQuickLinks() {
  const section = document.getElementById('quickLinksSection');
  const container = document.getElementById('quickLinksContainer');
  const countEl = document.getElementById('quickLinksCount');
  const emptyEl = document.getElementById('quickLinksEmpty');

  if (!section || !container) return;

  const links = await getQuickLinks();

  // Section is always visible now
  section.style.display = 'block';

  if (links.length === 0) {
    countEl.textContent = '';
    container.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }

  // Hide empty state when there are links
  if (emptyEl) emptyEl.style.display = 'none';

  countEl.textContent = `${links.length} link${links.length !== 1 ? 's' : ''}`;

  container.innerHTML = links.map((link, index) => {
    let domain = '';
    try { domain = new URL(link.url).hostname.replace(/^www\./, ''); } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : '';
    const displayTitle = link.title || link.url;
    const safeUrl = (link.url || '').replace(/"/g, '&quot;');
    const safeTitle = displayTitle.replace(/"/g, '&quot;');

    return `<div class="quick-link-card" data-quick-link-id="${link.id}" draggable="true" data-index="${index}">
      <a href="${safeUrl}" target="_blank" rel="noopener" class="quick-link-link" draggable="false" title="${safeTitle}">
        <div class="quick-link-icon">
          ${faviconUrl ? `<img class="quick-link-favicon" src="${faviconUrl}" alt="" data-fallback="true">` : ''}
        </div>
        <span class="quick-link-title">${displayTitle}</span>
      </a>
      <div class="quick-link-actions">
        <button class="quick-link-edit" data-action="edit-quick-link" data-quick-link-id="${link.id}" data-quick-link-url="${safeUrl}" data-quick-link-title="${safeTitle}" title="Edit this link">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" /></svg>
        </button>
        <button class="quick-link-remove" data-action="remove-quick-link" data-quick-link-id="${link.id}" title="Remove this link">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  // Handle favicon load errors (CSP-safe)
  container.querySelectorAll('.quick-link-favicon[data-fallback]').forEach(img => {
    img.addEventListener('error', function() {
      this.style.display = 'none';
    });
  });

  // Setup drag handlers for quick links
  setupQuickLinksDragHandlers(container);

  // Setup favicon error handlers
  setupFaviconErrorHandlers();
}


/* ----------------------------------------------------------------
   DRAG & DROP FOR QUICK LINKS

   Uses pure pointer events (pointerdown/pointermove/pointerup)
   instead of HTML5 drag API for more reliable control,
   especially when dealing with <a> child elements.
   ---------------------------------------------------------------- */

let draggedQuickLink = null;
let draggedIndex = -1;
let dragGhostElement = null;
let dragStartX = 0;
let dragStartY = 0;
let hasStartedDrag = false;
let lastTargetSlot = -1; // Track last target slot to avoid unnecessary updates
const DRAG_THRESHOLD = 8; // Minimum distance (pixels) to consider as drag vs click

/**
 * setupQuickLinksDragHandlers(container)
 *
 * Sets up pointer event handlers for quick link cards.
 */
function setupQuickLinksDragHandlers(container) {
  const cards = container.querySelectorAll('.quick-link-card');

  cards.forEach(card => {
    card.addEventListener('pointerdown', handlePointerDown, { passive: false });
  });

  // Global events for drag continuation and end
  document.addEventListener('pointermove', handlePointerMove, { passive: false });
  document.addEventListener('pointerup', handlePointerUp);
  document.addEventListener('pointercancel', handlePointerUp);
}

function handlePointerDown(e) {
  // Only handle left mouse button (button 0)
  // Ignore right-click (button 2), middle-click (button 1), etc.
  if (e.button !== 0) {
    return;
  }

  // Don't start drag from action buttons or modal
  if (e.target.closest('.quick-link-actions') || e.target.closest('.modal-overlay')) {
    return;
  }

  const card = e.currentTarget;

  // Prevent default behavior (including link clicks) immediately
  // We'll handle the click ourselves if it's not a drag
  e.preventDefault();

  // Record starting position
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  hasStartedDrag = false;
  lastTargetSlot = -1;

  // Mark this card as potential drag target
  draggedQuickLink = card;
  draggedIndex = parseInt(card.dataset.index);

  // Capture pointer for reliable tracking
  card.setPointerCapture(e.pointerId);
}

function handlePointerMove(e) {
  if (!draggedQuickLink) return;

  const deltaX = e.clientX - dragStartX;
  const deltaY = e.clientY - dragStartY;
  const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

  // Check if we've crossed the drag threshold
  if (!hasStartedDrag && distance > DRAG_THRESHOLD) {
    hasStartedDrag = true;

    // Prevent link click and other default behaviors
    e.preventDefault();

    // Create ghost element
    createDragGhost(draggedQuickLink, e.clientX, e.clientY);

    // Mark original card as dragging (completely hidden)
    draggedQuickLink.classList.add('dragging');
    draggedQuickLink.style.opacity = '0';
  }

  // If dragging, update ghost position and check for drop targets
  if (hasStartedDrag && dragGhostElement) {
    e.preventDefault();

    // Update ghost position
    dragGhostElement.style.left = e.clientX - 40 + 'px';
    dragGhostElement.style.top = e.clientY - 40 + 'px';

    // Find potential drop target (only update when target actually changes)
    updateDropTarget(e.clientX, e.clientY);
  }
}

function handlePointerUp(e) {
  if (!draggedQuickLink) return;

  // If we actually dragged, perform the reorder
  if (hasStartedDrag) {
    e.preventDefault();

    // Use the last calculated target slot
    const targetIndex = lastTargetSlot >= 0 ? lastTargetSlot : draggedIndex;

    // Reorder if target is different from source
    if (targetIndex !== draggedIndex) {
      performReorder(draggedIndex, targetIndex);
    } else {
      cleanupDrag();
    }
  } else {
    // This was a click, not a drag - open the link
    const link = draggedQuickLink.querySelector('.quick-link-link');
    if (link) {
      const href = link.getAttribute('href');
      if (href) {
        window.open(href, '_blank', 'noopener');
      }
    }
    cleanupDrag();
  }
}

function createDragGhost(card, x, y) {
  // Remove existing ghost if any
  if (dragGhostElement) {
    dragGhostElement.remove();
  }

  dragGhostElement = document.createElement('div');
  dragGhostElement.className = 'quick-link-drag-ghost';

  // Clone the card's visual content
  const icon = card.querySelector('.quick-link-icon');
  const title = card.querySelector('.quick-link-title');

  dragGhostElement.innerHTML = `
    <div class="quick-link-icon" style="width:48px;height:48px;border-radius:50%;background:var(--card-bg);border:2px solid var(--accent-amber);display:flex;align-items:center;justify-content:center;">
      ${icon ? icon.innerHTML : ''}
    </div>
    <span class="quick-link-title" style="font-size:12px;font-weight:500;color:var(--ink);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:72px;">
      ${title ? title.textContent : ''}
    </span>
  `;

  dragGhostElement.style.left = x - 40 + 'px';
  dragGhostElement.style.top = y - 40 + 'px';
  document.body.appendChild(dragGhostElement);
}

function updateDropTarget(x, y) {
  const container = document.getElementById('quickLinksContainer');
  if (!container) return;

  const cards = Array.from(container.querySelectorAll('.quick-link-card'));
  if (cards.length === 0) return;

  // Find the nearest card (excluding the dragging one) to determine drop position
  let nearestCard = null;
  let nearestDistance = Infinity;
  let ghostIsBefore = false;

  for (const card of cards) {
    if (card.classList.contains('dragging')) continue;

    const rect = card.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const distance = Math.abs(x - centerX);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestCard = card;
      ghostIsBefore = x < centerX;
    }
  }

  // If no nearest card found (only dragging card exists), target is dragged index
  if (!nearestCard) {
    lastTargetSlot = draggedIndex;
    return;
  }

  const nearestIndex = parseInt(nearestCard.dataset.index);

  // Calculate target slot based on ghost position relative to nearest card
  // We need to account for where the dragged card came from
  let targetSlot;

  if (ghostIsBefore) {
    // Ghost is before the nearest card
    if (nearestIndex < draggedIndex) {
      // Nearest card is before original position, so ghost should be at nearest position
      targetSlot = nearestIndex;
    } else {
      // Nearest card is after original position, ghost takes the slot before nearest
      targetSlot = nearestIndex - 1;
    }
  } else {
    // Ghost is after the nearest card
    if (nearestIndex < draggedIndex) {
      // Nearest card is before original position, ghost is after nearest
      targetSlot = nearestIndex + 1;
    } else {
      // Nearest card is after original position, ghost fills in at nearest position
      targetSlot = nearestIndex;
    }
  }

  // Clamp to valid range
  targetSlot = Math.max(0, Math.min(targetSlot, cards.length - 1));

  // Only update shift animations if target slot actually changed
  if (targetSlot !== lastTargetSlot) {
    lastTargetSlot = targetSlot;

    // Clear previous shift states without animation
    cards.forEach(card => {
      card.classList.remove('shift-left', 'shift-right');
    });

    // Apply shift animations based on new target
    if (targetSlot !== draggedIndex) {
      cards.forEach(card => {
        if (card.classList.contains('dragging')) return;

        const cardIndex = parseInt(card.dataset.index);

        if (draggedIndex < targetSlot) {
          // Dragged card moving right: cards in between shift left to fill gap
          if (cardIndex > draggedIndex && cardIndex <= targetSlot) {
            card.classList.add('shift-left');
          }
        } else if (draggedIndex > targetSlot) {
          // Dragged card moving left: cards in between shift right to make room
          if (cardIndex >= targetSlot && cardIndex < draggedIndex) {
            card.classList.add('shift-right');
          }
        }
      });
    }
  }
}

async function performReorder(fromIndex, toIndex) {
  const links = await getQuickLinks();
  if (fromIndex < 0 || fromIndex >= links.length || toIndex < 0 || toIndex >= links.length) {
    cleanupDrag();
    return;
  }

  const [movedLink] = links.splice(fromIndex, 1);
  links.splice(toIndex, 0, movedLink);
  await saveQuickLinks(links);

  // Cleanup drag state first
  cleanupDrag();

  // Re-render
  await renderQuickLinks();
}

function cleanupDrag() {
  // Remove ghost
  if (dragGhostElement) {
    dragGhostElement.remove();
    dragGhostElement = null;
  }

  // Reset all cards
  document.querySelectorAll('.quick-link-card').forEach(card => {
    card.classList.remove('dragging', 'shift-left', 'shift-right');
    card.style.opacity = '';
  });

  // Reset state
  draggedQuickLink = null;
  draggedIndex = -1;
  hasStartedDrag = false;
  lastTargetSlot = -1;
}

/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * setupFaviconErrorHandlers()
 *
 * Sets up error handlers for all favicon images to hide them on load failure.
 * This is CSP-safe because it uses event listeners instead of inline handlers.
 */
function setupFaviconErrorHandlers() {
  document.querySelectorAll('.chip-favicon, .quick-link-favicon').forEach(img => {
    if (!img.dataset.errorHandler) {
      img.dataset.errorHandler = 'true';
      img.addEventListener('error', function() {
        this.style.display = 'none';
      });
    }
  });
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "2026.04.17 | 星期四"
 */
function getDateDisplay() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const weekday = weekdays[now.getDay()];

  return `${year}.${month}.${day} | ${weekday}`;
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, isPinned)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 * isPinned = boolean, whether this domain is pinned
 */
function renderDomainCard(group, isPinned = false) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  // Pin icon button (pushpin/thumbtack style)
  // Filled when pinned, outlined when not pinned
  const pinIcon = isPinned
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="pin-svg"><path d="M16 12V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v8c0 1.1.9 2 2 2h2v6l2 2 2-2v-6h2c1.1 0 2-.9 2-2z"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke="currentColor" class="pin-svg"><path stroke-linecap="round" stroke-linejoin="round" d="M16 12V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v8c0 1.1.9 2 2 2h2v6l2 2 2-2v-6h2c1.1 0 2-.9 2-2z"/></svg>`;

  const pinBtn = `<button class="pin-btn ${isPinned ? 'pinned' : ''}" data-action="toggle-pin" data-domain-id="${stableId}" title="${isPinned ? 'Unpin this card' : 'Pin this card to keep it in place'}">${pinIcon}</button>`;

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'} ${isPinned ? 'is-pinned' : ''}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          ${pinBtn}
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   RECENTLY CLOSED — Render Column
   ---------------------------------------------------------------- */

/**
 * renderRecentlyClosedColumn()
 *
 * Reads recently closed tabs from chrome.storage.local and renders
 * the right-side column. Always visible, shows empty state when no items.
 */
async function renderRecentlyClosedColumn() {
  const column    = document.getElementById('deferredColumn');
  const list      = document.getElementById('deferredList');
  const empty     = document.getElementById('deferredEmpty');
  const countEl   = document.getElementById('deferredCount');
  const clearBtn  = document.querySelector('[data-action="clear-all-recent"]');

  if (!column) return;

  try {
    const items = await getRecentlyClosed();

    // Column is always visible
    column.style.display = 'block';

    if (items.length === 0) {
      // Show empty state
      list.style.display = 'none';
      empty.style.display = 'block';
      countEl.textContent = '';
      if (clearBtn) clearBtn.style.display = 'none';
    } else {
      // Render items
      countEl.textContent = `${items.length}`;
      list.innerHTML = items.map(item => renderRecentlyClosedItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'inline-flex';
    }

  } catch (err) {
    console.warn('[tab-view] Could not load recently closed:', err);
    // Still show column with empty state on error
    column.style.display = 'block';
    list.style.display = 'none';
    empty.style.display = 'block';
    countEl.textContent = '';
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

/**
 * renderRecentlyClosedItem(item)
 *
 * Builds HTML for one recently closed item: favicon, title, time ago,
 * reopen button, dismiss button.
 */
function renderRecentlyClosedItem(item) {
  const ago = timeAgo(item.closedAt);
  const safeTitle = (item.title || item.url).replace(/"/g, '&quot;');
  const safeUrl = item.url.replace(/"/g, '&quot;');
  const faviconUrl = item.favicon || '';

  return `
    <div class="deferred-item" data-recent-id="${item.id}">
      <button class="recent-reopen" data-action="reopen-recent" data-recent-id="${item.id}" title="Reopen this tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
      </button>
      <div class="deferred-info">
        <a href="${safeUrl}" target="_blank" rel="noopener" class="deferred-title" title="${safeTitle}">
          ${faviconUrl ? `<img src="${faviconUrl}" alt="" class="deferred-favicon" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px">` : ''}${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="clear-recent" data-recent-id="${item.id}" title="Remove from list">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * updateRecentlyClosedCount()
 *
 * Updates the count display without re-rendering the entire list.
 * Also handles empty state visibility.
 */
function updateRecentlyClosedCount() {
  const countEl = document.getElementById('deferredCount');
  const list    = document.getElementById('deferredList');
  const empty   = document.getElementById('deferredEmpty');
  const clearBtn = document.querySelector('[data-action="clear-all-recent"]');

  if (!countEl || !list || !empty) return;

  const itemCount = list.querySelectorAll('.deferred-item').length;
  countEl.textContent = itemCount > 0 ? `${itemCount}` : '';

  // Show/hide empty state and clear button
  if (itemCount === 0) {
    list.style.display = 'none';
    empty.style.display = 'block';
    if (clearBtn) clearBtn.style.display = 'none';
  } else {
    list.style.display = 'block';
    empty.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'inline-flex';
  }
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Pinned domains keep their pinned position
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }

  // Get pinned domains for sorting
  const pinnedDomains = await getPinnedDomains();

  // Helper to convert domain to stableId
  function domainToId(domain) {
    return 'domain-' + domain.replace(/[^a-z0-9]/g, '-');
  }

  // Sort groups: pinned domains stay in their pinned order, others sort normally
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aId = domainToId(a.domain);
    const bId = domainToId(b.domain);
    const aPinIdx = pinnedDomains.indexOf(aId);
    const bPinIdx = pinnedDomains.indexOf(bId);

    // Both pinned: maintain pinned order
    if (aPinIdx !== -1 && bPinIdx !== -1) return aPinIdx - bPinIdx;

    // Only a pinned: a comes first (after already-placed pinned items)
    if (aPinIdx !== -1) return -1;

    // Only b pinned: b comes first
    if (bPinIdx !== -1) return 1;

    // Neither pinned: use original sorting logic
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => {
      const stableId = domainToId(g.domain);
      const isPinned = pinnedDomains.includes(stableId);
      return renderDomainCard(g, isPinned);
    }).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Render Quick Links ---
  await renderQuickLinks();

  // --- Render "Recently Closed" column ---
  await renderRecentlyClosedColumn();

  // --- Setup favicon error handlers (CSP-safe) ---
  setupFaviconErrorHandlers();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Toggle pin on a domain card ----
  if (action === 'toggle-pin') {
    e.stopPropagation(); // don't trigger parent card's click
    const domainId = actionEl.dataset.domainId;
    if (!domainId) return;

    const card = actionEl.closest('.mission-card');
    if (!card) return;

    const pinned = await getPinnedDomains();
    const isCurrentlyPinned = pinned.includes(domainId);

    if (isCurrentlyPinned) {
      await unpinDomain(domainId);
      card.classList.remove('is-pinned');
      actionEl.classList.remove('pinned');
      showToast('Card unpinned');
    } else {
      await pinDomain(domainId);
      card.classList.add('is-pinned');
      actionEl.classList.add('pinned');
      showToast('Card pinned');
    }

    // Update pin icon SVG
    const newIcon = isCurrentlyPinned
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke="currentColor" class="pin-svg"><path stroke-linecap="round" stroke-linejoin="round" d="M16 12V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v8c0 1.1.9 2 2 2h2v6l2 2 2-2v-6h2c1.1 0 2-.9 2-2z"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="pin-svg"><path d="M16 12V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v8c0 1.1.9 2 2 2h2v6l2 2 2-2v-6h2c1.1 0 2-.9 2-2z"/></svg>`;
    actionEl.innerHTML = newIcon;

    // Re-render dashboard to apply new sorting order
    await renderDashboard();
    return;
  }

  // ---- Show add link modal ----
  if (action === 'show-add-link-modal') {
    const modal = document.getElementById('addLinkModal');
    if (modal) {
      modal.style.display = 'flex';
      // Focus the URL input
      setTimeout(() => {
        const urlInput = document.getElementById('addLinkUrl');
        if (urlInput) urlInput.focus();
      }, 100);
    }
    return;
  }

  // ---- Close add link modal ----
  if (action === 'close-add-link-modal') {
    const modal = document.getElementById('addLinkModal');
    if (modal) {
      modal.style.display = 'none';
      // Clear edit mode
      delete modal.dataset.editLinkId;
      // Reset modal title and button text
      const modalTitle = modal.querySelector('.modal-header h3');
      if (modalTitle) modalTitle.textContent = 'Add Quick Link';
      const saveBtn = modal.querySelector('[data-action="save-quick-link"]');
      if (saveBtn) saveBtn.textContent = 'Add Link';
      // Clear the inputs
      const urlInput = document.getElementById('addLinkUrl');
      const titleInput = document.getElementById('addLinkTitle');
      if (urlInput) urlInput.value = '';
      if (titleInput) titleInput.value = '';
    }
    return;
  }

  // ---- Save quick link ----
  if (action === 'save-quick-link') {
    const modal = document.getElementById('addLinkModal');
    const urlInput = document.getElementById('addLinkUrl');
    const titleInput = document.getElementById('addLinkTitle');
    const url = urlInput ? urlInput.value.trim() : '';
    const title = titleInput ? titleInput.value.trim() : '';

    if (!url) {
      showToast('Please enter a URL');
      return;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      showToast('Please enter a valid URL');
      return;
    }

    // Check if this is edit mode or add mode
    const editLinkId = modal ? modal.dataset.editLinkId : null;

    if (editLinkId) {
      // Update existing link
      await updateQuickLink(editLinkId, url, title);
      showToast('Quick link updated');
    } else {
      // Add new link
      await addQuickLink(url, title);
      showToast('Quick link added');
    }

    // Close modal and reset
    if (modal) {
      modal.style.display = 'none';
      delete modal.dataset.editLinkId;
      // Reset modal title and button text
      const modalTitle = modal.querySelector('.modal-header h3');
      if (modalTitle) modalTitle.textContent = 'Add Quick Link';
      const saveBtn = modal.querySelector('[data-action="save-quick-link"]');
      if (saveBtn) saveBtn.textContent = 'Add Link';
    }
    if (urlInput) urlInput.value = '';
    if (titleInput) titleInput.value = '';

    await renderQuickLinks();
    return;
  }

  // ---- Edit quick link ----
  if (action === 'edit-quick-link') {
    e.stopPropagation();
    const linkId = actionEl.dataset.quickLinkId;
    const linkUrl = actionEl.dataset.quickLinkUrl;
    const linkTitle = actionEl.dataset.quickLinkTitle;
    if (!linkId) return;

    // Show modal with existing data
    const modal = document.getElementById('addLinkModal');
    const urlInput = document.getElementById('addLinkUrl');
    const titleInput = document.getElementById('addLinkTitle');
    const modalTitle = modal ? modal.querySelector('.modal-header h3') : null;

    if (modal && urlInput && titleInput) {
      // Set edit mode
      modal.dataset.editLinkId = linkId;
      urlInput.value = linkUrl || '';
      titleInput.value = linkTitle || '';
      // Change modal title for edit mode
      if (modalTitle) modalTitle.textContent = 'Edit Quick Link';
      // Change save button text
      const saveBtn = modal.querySelector('[data-action="save-quick-link"]');
      if (saveBtn) saveBtn.textContent = 'Save Changes';
      modal.style.display = 'flex';
      setTimeout(() => urlInput.focus(), 50);
    }
    return;
  }

  // ---- Remove quick link ----
  if (action === 'remove-quick-link') {
    e.stopPropagation();
    const linkId = actionEl.dataset.quickLinkId;
    if (!linkId) return;

    await removeQuickLink(linkId);

    // Animate the card out
    const linkCard = actionEl.closest('.quick-link-card');
    if (linkCard) {
      playCloseSound();
      linkCard.style.transition = 'opacity 0.2s, transform 0.2s';
      linkCard.style.opacity = '0';
      linkCard.style.transform = 'scale(0.8)';
      setTimeout(() => {
        linkCard.remove();
        // Check if should show empty state
        const container = document.getElementById('quickLinksContainer');
        const emptyEl = document.getElementById('quickLinksEmpty');
        const countEl = document.getElementById('quickLinksCount');
        if (container && container.children.length === 0) {
          if (emptyEl) emptyEl.style.display = 'block';
          if (countEl) countEl.textContent = '';
        }
      }, 200);
    }

    showToast('Quick link removed');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Pause auto-refresh to avoid re-render during animation
    pauseRefresh();

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);

    // Note: background.js will automatically add to Recently Closed via tabs.onRemoved

    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
        // Resume refresh after animations complete
        setTimeout(() => resumeRefresh(), 100);
      }, 200);
    } else {
      resumeRefresh();
    }

    // Update footer and refresh recently closed column
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    await renderRecentlyClosedColumn();

    showToast('Tab closed');
    return;
  }

  // ---- Reopen a recently closed tab ----
  if (action === 'reopen-recent') {
    const recentId = actionEl.dataset.recentId;
    if (!recentId) return;

    await reopenRecentlyClosed(recentId);
    showToast('Tab reopened');

    // Remove item from UI with animation
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        // Update count only, don't re-render entire list
        updateRecentlyClosedCount();
      }, 300);
    }
    return;
  }

  // ---- Clear a recently closed entry ----
  if (action === 'clear-recent') {
    const recentId = actionEl.dataset.recentId;
    if (!recentId) return;

    await clearRecentlyClosed(recentId);

    // Remove item from UI with animation
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        // Update count only, don't re-render entire list
        updateRecentlyClosedCount();
      }, 300);
    }
    return;
  }

  // ---- Clear all recently closed entries ----
  if (action === 'clear-all-recent') {
    await clearAllRecentlyClosed();
    showToast('Cleared all');

    // Fade out all items then clear
    const items = document.querySelectorAll('.deferred-item');
    items.forEach(item => {
      item.classList.add('removing');
    });

    setTimeout(() => {
      const list = document.getElementById('deferredList');
      if (list) list.innerHTML = '';
      updateRecentlyClosedCount();
    }, 300);
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    // Pause auto-refresh to avoid card disappearing then reappearing
    pauseRefresh();

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
      // Resume refresh after animation completes (300ms)
      setTimeout(() => resumeRefresh(), 350);
    } else {
      resumeRefresh();
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    // Pause auto-refresh to avoid re-render during animation
    pauseRefresh();

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    // Resume refresh after animations complete
    setTimeout(() => resumeRefresh(), 250);

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    // Pause auto-refresh to avoid re-render during animation
    pauseRefresh();

    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    // Resume refresh after animations complete
    setTimeout(() => resumeRefresh(), 400);

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Modal overlay click to close ----
document.addEventListener('click', (e) => {
  const modal = document.getElementById('addLinkModal');
  if (!modal) return;

  // Only close if clicking directly on the overlay (not the modal content)
  if (e.target === modal && modal.style.display !== 'none') {
    modal.style.display = 'none';
    const urlInput = document.getElementById('addLinkUrl');
    const titleInput = document.getElementById('addLinkTitle');
    if (urlInput) urlInput.value = '';
    if (titleInput) titleInput.value = '';
  }
});

// ---- Escape key to close modal ----
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('addLinkModal');
    if (modal && modal.style.display !== 'none') {
      modal.style.display = 'none';
      const urlInput = document.getElementById('addLinkUrl');
      const titleInput = document.getElementById('addLinkTitle');
      if (urlInput) urlInput.value = '';
      if (titleInput) titleInput.value = '';
    }
  }
});


/* ----------------------------------------------------------------
   SIDEBAR RESIZER — drag to resize sidebar width

   Uses pointer events for smooth dragging experience.
   Stores the preferred width in localStorage for persistence.
   ---------------------------------------------------------------- */

const SIDEBAR_MIN_WIDTH = 140;
const SIDEBAR_MAX_WIDTH = 600; // Allow sidebar to take up more space
const SIDEBAR_STORAGE_KEY = 'tabView-sidebarWidth';

function initSidebarResizer() {
  const resizer = document.getElementById('sidebarResizer');
  const sidebar = document.getElementById('sidebar');

  if (!resizer || !sidebar) return;

  // Restore saved width from localStorage
  const savedWidth = localStorage.getItem(SIDEBAR_STORAGE_KEY);
  if (savedWidth) {
    const width = parseInt(savedWidth);
    if (width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH) {
      sidebar.style.width = width + 'px';
    }
  }

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener('pointerdown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;

    resizer.classList.add('dragging');
    resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    const deltaX = e.clientX - startX;
    const newWidth = startWidth + deltaX;

    // Clamp to min/max bounds
    const clampedWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, newWidth));
    sidebar.style.width = clampedWidth + 'px';
  });

  resizer.addEventListener('pointerup', (e) => {
    if (!isDragging) return;

    isDragging = false;
    resizer.classList.remove('dragging');
    resizer.releasePointerCapture(e.pointerId);

    // Save the new width to localStorage
    localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebar.offsetWidth.toString());
  });

  resizer.addEventListener('pointercancel', (e) => {
    if (!isDragging) return;

    isDragging = false;
    resizer.classList.remove('dragging');
    resizer.releasePointerCapture(e.pointerId);
  });
}


/* ----------------------------------------------------------------
   TAB CHANGE LISTENER — auto-refresh dashboard when tabs change

   Monitors chrome.tabs events and re-renders the dashboard when:
   - A new tab is opened
   - A tab is closed
   - A tab's URL changes (navigation)

   Can be paused temporarily to avoid re-render during user-initiated actions.
   ---------------------------------------------------------------- */

let isRefreshPaused = false;

function pauseRefresh() {
  isRefreshPaused = true;
}

function resumeRefresh() {
  isRefreshPaused = false;
}

function setupTabChangeListener() {
  // Debounce timer to avoid rapid re-renders
  let refreshTimer = null;
  const REFRESH_DELAY = 300; // Wait 300ms before refreshing

  // Cache of tabs' URL without query string to detect non-query URL changes
  const tabsUrlCache = new Map();
  // Cache of tabs' titles to detect first meaningful title load
  const tabsTitleCache = new Map();

  /**
   * getUrlWithoutQuery(url)
   * Returns URL without query string (the part after ?).
   * Used to compare if only query params changed.
   */
  function getUrlWithoutQuery(url) {
    if (!url) return '';
    // Split at '?' and take the first part
    const queryIndex = url.indexOf('?');
    if (queryIndex !== -1) {
      return url.substring(0, queryIndex);
    }
    return url;
  }

  /**
   * needsRefreshForUrlChange(tabId, newUrl)
   * Determines if URL change requires dashboard refresh.
   * Returns false only when query string changed (but base URL same).
   */
  function needsRefreshForUrlChange(tabId, newUrl) {
    const newBaseUrl = getUrlWithoutQuery(newUrl);
    const oldBaseUrl = tabsUrlCache.get(tabId) || '';

    // Update cache
    tabsUrlCache.set(tabId, newBaseUrl);

    // Refresh if base URL (without query) changed
    return newBaseUrl !== oldBaseUrl;
  }

  /**
   * isTitleChangeMeaningful(tabId, newTitle, tabUrl)
   * Determines if title change is meaningful and requires refresh.
   *
   * Meaningful changes include:
   * 1. First meaningful title load: from empty/URL placeholder to real title
   * 2. Title becomes richer: new title is longer than old title by >= 5 chars
   *    (e.g., "Cooper" -> "Cooper - 文档详情页")
   *
   * NOT meaningful (won't refresh):
   * - Title becomes shorter or stays same length (e.g., "(3) Gmail" -> "Gmail")
   * - Counter changes (e.g., "(3) Gmail" -> "(5) Gmail")
   */
  function isTitleChangeMeaningful(tabId, newTitle, tabUrl) {
    const oldTitle = tabsTitleCache.get(tabId) || '';
    const urlWithoutQuery = getUrlWithoutQuery(tabUrl || '');

    // Update cache
    tabsTitleCache.set(tabId, newTitle);

    // Check 1: First meaningful title load
    // oldTitle was placeholder (empty or URL-like)
    const wasPlaceholder = !oldTitle || oldTitle === tabUrl || oldTitle === urlWithoutQuery;
    // newTitle is meaningful (not empty, not URL-like)
    const newIsMeaningful = newTitle && newTitle !== tabUrl && newTitle !== urlWithoutQuery;
    if (wasPlaceholder && newIsMeaningful) {
      return true;
    }

    // Check 2: Title becomes significantly richer/longer
    // This catches cases like "Cooper" -> "Cooper - 文档详情页"
    if (oldTitle && newTitle) {
      // Compare stripped titles (remove counters like "(3)")
      const oldStripped = oldTitle.replace(/^\([\d,]+\)\s*/, '');
      const newStripped = newTitle.replace(/^\([\d,]+\)\s*/, '');
      // Refresh if new stripped title is at least 5 chars longer
      if (newStripped.length >= oldStripped.length + 5) {
        return true;
      }
    }

    return false;
  }

  function scheduleRefresh() {
    // Skip refresh if paused (e.g., during card animation)
    if (isRefreshPaused) return;

    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (!isRefreshPaused) {
        renderDashboard();
      }
      refreshTimer = null;
    }, REFRESH_DELAY);
  }

  // Initialize cache with current tabs
  chrome.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      if (tab.id && tab.url) {
        tabsUrlCache.set(tab.id, getUrlWithoutQuery(tab.url));
      }
      if (tab.id && tab.title) {
        tabsTitleCache.set(tab.id, tab.title);
      }
    });
  });

  // Listen for new tabs - always refresh
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id && tab.url) {
      tabsUrlCache.set(tab.id, getUrlWithoutQuery(tab.url));
    }
    if (tab.id && tab.title) {
      tabsTitleCache.set(tab.id, tab.title);
    }
    scheduleRefresh();
  });

  // Listen for closed tabs - always refresh
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabsUrlCache.delete(tabId);
    tabsTitleCache.delete(tabId);
    scheduleRefresh();
  });

  // Listen for tab URL and title changes
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check URL changes - refresh unless only query changed
    if (changeInfo.url) {
      if (needsRefreshForUrlChange(tabId, changeInfo.url)) {
        scheduleRefresh();
      }
    }

    // Check title changes - refresh only on meaningful title change
    if (changeInfo.title) {
      if (isTitleChangeMeaningful(tabId, changeInfo.title, tab.url)) {
        scheduleRefresh();
      }
    }
  });
}


/* ----------------------------------------------------------------
   RECENTLY CLOSED COLLAPSE TOGGLE

   Allow user to collapse/expand the Recently Closed section.
   State is saved in localStorage.
   ---------------------------------------------------------------- */

const RECENTLY_CLOSED_COLLAPSED_KEY = 'tabView-recentlyClosedCollapsed';

function initRecentlyClosedToggle() {
  const toggleBtn = document.getElementById('recentlyClosedToggle');
  const column    = document.getElementById('deferredColumn');

  if (!toggleBtn || !column) return;

  // Restore saved state
  const isCollapsed = localStorage.getItem(RECENTLY_CLOSED_COLLAPSED_KEY) === 'true';
  if (isCollapsed) {
    column.classList.add('collapsed');
    toggleBtn.classList.add('collapsed');
  }

  // Toggle on click
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowCollapsed = column.classList.toggle('collapsed');
    toggleBtn.classList.toggle('collapsed');

    // Save state
    localStorage.setItem(RECENTLY_CLOSED_COLLAPSED_KEY, nowCollapsed.toString());
  });
}


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
initSidebarResizer();
setupTabChangeListener();
initRecentlyClosedToggle();
