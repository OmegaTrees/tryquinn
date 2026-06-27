// ==UserScript==
// @name         Quinn Audio Collector
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  Collects audio URLs + titles on tryquinn.com with floating UI + multi-creator crawler
// @match        https://www.tryquinn.com/*
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
'use strict';

const log = {};
let pageTitles = [];
let panelEl = null;
let missedListEl = null;
let countEl = null;
let missedSectionEl = null;
let autoRunning = false;
let queueRunning = false;
let crawlRunning = false;

const CRAWL_KEY = '__quinn_crawl_state';
const CREATOR_LIST_KEY = '__quinn_creator_list'; // { urls: [{url,name,enabled}], savedAt }

function isAudio(url) {
  return typeof url === 'string' &&
    /cloudinary\.com/i.test(url) &&
    /\.(mp4|mp3|m3u8|aac|webm)/i.test(url);
}

function clean(s) {
  return (s || 'unknown').toLowerCase()
    .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function ext(url) {
  const m = url.match(/\.(m3u8|mp3|aac|webm|mp4)/i);
  return m ? m[1].toLowerCase() : 'mp4';
}

function nowPlaying() {
  let title = '', author = '';
  document.querySelectorAll('h4').forEach(el => {
    const p = el.closest('div');
    if (p && p.querySelector('p') && !title) {
      title = el.innerText.trim();
      author = p.querySelector('p').innerText.trim();
    }
  });
  return { title, author };
}

function save(url) {
  if (log[url]) return;
  log[url] = { url, title: '', author: '', ext: ext(url) };
  updatePanel();
  setTimeout(() => {
    const np = nowPlaying();
    if (np.title && !log[url]?.title) {
      log[url].title = np.title;
      log[url].author = np.author;
    }
    updatePanel();
  }, 800);
}

function getAudioTitles() {
  const results = [];
  document.querySelectorAll('a[href^="/audio/"]').forEach(audioLink => {
    const titleEl = audioLink.querySelector('h6');
    if (!titleEl) return;
    const container = audioLink.parentElement;
    const authorEl = container?.querySelector('a[href^="/creators/"] span');
    results.push({
      title: titleEl.textContent.trim(),
      author: authorEl?.textContent.trim() || 'Unknown',
      link: audioLink
    });
  });
  return results;
}

async function loadAllAndScrape() {
  updatePanelStatus('Loading all tracks…');
  while (true) {
    const btn = [...document.querySelectorAll('button')]
      .find(b => /view more|load more/i.test(b.textContent));
    if (!btn || btn.disabled) break;
    btn.click();
    await sleep(1600);
  }
  pageTitles = getAudioTitles();
  updatePanel();
  updatePanelStatus(`Found ${pageTitles.length} tracks on page`);
}

function getMissed() {
  if (!pageTitles.length) return [];
  const capturedTitles = new Set(Object.values(log).map(e => clean(e.title)));
  return pageTitles.filter(pt => !capturedTitles.has(clean(pt.title)));
}

// ─── New Auto Capture (using your exact selectors & flow) ─────────────────
async function autoCapture(autoCaptureBtn) {
  if (autoRunning) {
    autoRunning = false;
    autoCaptureBtn.textContent = '⚡ Auto Capture Missed';
    return;
  }
  // Make sure page titles are loaded first
  if (!pageTitles.length) {
    updatePanelStatus('Loading tracks first…');
    await loadAllAndScrape();
  }
  const missed = getMissed();
  if (!missed.length) {
    updatePanelStatus('Nothing missed!');
    return;
  }

  autoRunning = true;
  autoCaptureBtn.textContent = '⏹ Stop';
  autoCaptureBtn.style.background = '#ef4444';

  try {
    // 1. Load all & scan page titles (the blue Load button) + wait 2 sec
    await loadAllAndScrape();
    await sleep(2000);

    // 2. Start playlist + wait 2 sec
    const playBtn = document.querySelector('path[d^="M10 0C15.5228"]')?.closest('button');
    if (playBtn) playBtn.click();
    await sleep(2000);

    // 3. Open panel + wait 2 sec
    const panelOpenBtn = document.querySelector('div.sc-84a1dcce-0.hztPes');
    if (panelOpenBtn) panelOpenBtn.click();
    await sleep(2000);

    // 4. Loop: capture current, then click next
    while (autoRunning) {
      const currentMissed = getMissed();
      if (currentMissed.length === 0) {
        updatePanelStatus('All missed captured!');
        break;
      }

      // Wait for track to play and audio to be intercepted
      await sleep(3000);
      // Try to tag any un‑titled entries
      const np = nowPlaying();
      Object.values(log).forEach(e => {
        if (!e.title && np.title) {
          e.title = np.title;
          e.author = np.author;
        }
      });
      updatePanel();

      if (!autoRunning) break;

      // Click next button (fixed: removed view: window to avoid sandbox error)
      const nextBtn = document.querySelector('i.next.icon')?.closest('button');
      if (nextBtn) {
        nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        if (typeof nextBtn.click === 'function') nextBtn.click();
        await sleep(0);
      } else {
        updatePanelStatus('No next button, stopping.');
        break;
      }
    }
  } finally {
    autoRunning = false;
    autoCaptureBtn.textContent = '⚡ Auto Capture Missed';
    autoCaptureBtn.style.background = '#8b5cf6';
    updatePanelStatus(`Done! ${Object.keys(log).length} captured`);
  }
}

// ─── New Queue Click Capture (click button[i] -> wait/capture -> click button[i+1]) ──
function dispatchClick(el) {
  // No `view: window` — sandboxed Tampermonkey context throws on that, same fix as next-button.
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  if (typeof el.click === 'function') el.click();
}

// Returns true if queue buttons were found and the loop ran (even if empty result captured),
// false if there were no queue buttons at all (caller can treat as "no tracks").
async function clickQueueAndCapture(queueBtn) {
  if (queueRunning) {
    queueRunning = false;
    queueBtn.textContent = '🎯 Click & Capture Queue';
    return true;
  }

  const buttons = [
    ...document.querySelectorAll('div.sc-9ec2601e-1 svg.sc-2c79d54d-23')
  ];

  if (!buttons.length) {
    updatePanelStatus('No queue buttons found.');
    return false;
  }

  queueRunning = true;
  queueBtn.textContent = '⏹ Stop';
  queueBtn.style.background = '#ef4444';
  updatePanelStatus(`Found ${buttons.length} queue buttons`);

  try {
    for (let i = 0; i < buttons.length; i++) {
      if (!queueRunning) break;

      updatePanelStatus(`Clicking ${i + 1}/${buttons.length}…`);
      dispatchClick(buttons[i]);

      // Wait for the track to load/play so interceptors can catch the audio URL
      await sleep(3000);

      // Tag any un-titled captured entries with whatever is now playing
      const np = nowPlaying();
      Object.values(log).forEach(e => {
        if (!e.title && np.title) {
          e.title = np.title;
          e.author = np.author;
        }
      });
      updatePanel();
    }

    if (queueRunning) {
      // Click the extra panel button if present, same as your snippet
      const panelBtn = document.querySelector('div.sc-84a1dcce-12 svg');
      if (panelBtn) {
        dispatchClick(panelBtn);
        updatePanelStatus('Clicked panel button. Done!');
      } else {
        updatePanelStatus(`Done! ${Object.keys(log).length} captured`);
      }
    }
  } finally {
    queueRunning = false;
    queueBtn.textContent = '🎯 Click & Capture Queue';
    queueBtn.style.background = '#10b981';
  }
  return true;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Save TXT ─────────────────────────────────────────────────────────────
function entriesToLines() {
  return Object.values(log).map(e => {
    const suffix = e.ext === 'm3u8' ? '' : '.mp3';
    return `${e.url} -n ${clean(e.title)} by ${clean(e.author)}${suffix}`;
  });
}

function saveTxt(filenameOverride) {
  const entries = Object.values(log);
  if (!entries.length) { alert('Nothing captured yet.'); return false; }
  const lines = entriesToLines();
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const filename = filenameOverride || 'quinn-links.txt';

  // NOTE: GM_download is intentionally NOT used here. On Chrome +
  // Tampermonkey, GM_download has a known bug where it ignores the `name`
  // field for blob: URLs and falls back to the blob's internal UUID as
  // the filename. The plain anchor `download` attribute is honored
  // reliably by Chrome even for repeated programmatic downloads triggered
  // from script, so it's used as the only method now.
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Revoke slightly later so the download has time to actually start
  // before the blob URL is invalidated.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

// ─── Crawl State (localStorage, survives navigation) ───────────────────────
function getCrawlState() {
  try {
    const raw = localStorage.getItem(CRAWL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setCrawlState(state) {
  localStorage.setItem(CRAWL_KEY, JSON.stringify(state));
}

function clearCrawlState() {
  localStorage.removeItem(CRAWL_KEY);
}

function getCreatorName() {
  // Pull the author straight from a captured entry — the same name that
  // already shows up as "by <author>" in each saved line (e.g. "noble").
  // Prefer the second entry if there is one (the first track is sometimes
  // a generic intro/jingle), otherwise fall back to the first.
  const entries = Object.values(log);
  const pick = entries[1] || entries[0];
  if (pick && pick.author) return pick.author;
  return 'creator';
}

function collectCreatorUrls() {
  const seen = new Set();
  const list = [];
  document.querySelectorAll('a[href^="/creators/"]').forEach(a => {
    const href = a.getAttribute('href');
    const full = new URL(href, window.location.origin).href;
    if (seen.has(full)) return;
    seen.add(full);
    // Try to grab a readable display name near the link (span text, or
    // the link's own text), falling back to the URL slug.
    const span = a.querySelector('span');
    let name = (span?.textContent || a.textContent || '').trim();
    if (!name) {
      const slug = href.replace(/^\/creators\/?/, '').replace(/\/$/, '');
      name = slug || full;
    }
    list.push({ url: full, name });
  });
  return list;
}

// ─── Creator List (editable include/exclude checklist) ────────────────────
function getCreatorListState() {
  try {
    const raw = localStorage.getItem(CREATOR_LIST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setCreatorListState(state) {
  localStorage.setItem(CREATOR_LIST_KEY, JSON.stringify(state));
}

function clearCreatorListState() {
  localStorage.removeItem(CREATOR_LIST_KEY);
}

// Builds (or rebuilds) the creator list from the current /creators page,
// preserving enabled/disabled choices for any URL that was already in a
// saved list (so re-scanning doesn't wipe out your unchecks).
function refreshCreatorList() {
  const found = collectCreatorUrls();
  if (!found.length) {
    alert('No creator links found on this page.');
    return null;
  }
  const existing = getCreatorListState();
  const prevEnabled = new Map(
    (existing?.urls || []).map(e => [e.url, e.enabled])
  );
  const urls = found.map(f => ({
    url: f.url,
    name: f.name,
    enabled: prevEnabled.has(f.url) ? prevEnabled.get(f.url) : true
  }));
  const state = { urls, savedAt: Date.now() };
  setCreatorListState(state);
  return state;
}

function openCreatorListEditor() {
  if (!/\/creators\/?$/.test(location.pathname)) {
    alert('Go to https://www.tryquinn.com/creators first to build the creator list.');
    return;
  }
  const state = refreshCreatorList();
  if (!state) return;
  renderCreatorListEditor(state);
}

function renderCreatorListEditor(state) {
  if (!creatorListBodyEl || !creatorListSectionEl) return;
  creatorListSectionEl.style.display = 'block';
  creatorListBodyEl.innerHTML = '';

  const summary = document.createElement('div');
  summary.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;`;
  const enabledCount = state.urls.filter(u => u.enabled).length;
  const summaryText = document.createElement('span');
  summaryText.style.cssText = `color:#a5b4fc;font-size:10px;`;
  summaryText.textContent = `${enabledCount}/${state.urls.length} selected`;
  summary.appendChild(summaryText);

  const allNoneRow = document.createElement('div');
  allNoneRow.style.cssText = `display:flex;gap:4px;`;
  const allBtn = document.createElement('button');
  allBtn.textContent = 'All';
  allBtn.style.cssText = `background:#333;color:#ccc;border:none;border-radius:3px;font-size:9px;padding:1px 6px;cursor:pointer;`;
  allBtn.addEventListener('click', () => {
    state.urls.forEach(u => u.enabled = true);
    setCreatorListState(state);
    renderCreatorListEditor(state);
  });
  const noneBtn = document.createElement('button');
  noneBtn.textContent = 'None';
  noneBtn.style.cssText = allBtn.style.cssText;
  noneBtn.addEventListener('click', () => {
    state.urls.forEach(u => u.enabled = false);
    setCreatorListState(state);
    renderCreatorListEditor(state);
  });
  allNoneRow.appendChild(allBtn);
  allNoneRow.appendChild(noneBtn);
  summary.appendChild(allNoneRow);
  creatorListBodyEl.appendChild(summary);

  const listEl = document.createElement('div');
  listEl.style.cssText = `max-height:160px;overflow-y:auto;font-size:10px;border-top:1px solid #2a2a2a;`;
  state.urls.forEach((entry, idx) => {
    const row = document.createElement('label');
    row.style.cssText = `
      display:flex; align-items:center; gap:6px; padding:3px 2px;
      border-bottom:1px solid #1e1e1e; cursor:pointer;
      color:${entry.enabled ? '#eee' : '#666'};
    `;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = entry.enabled;
    cb.style.cssText = `flex-shrink:0;cursor:pointer;`;
    cb.addEventListener('change', () => {
      entry.enabled = cb.checked;
      setCreatorListState(state);
      row.style.color = entry.enabled ? '#eee' : '#666';
      summaryText.textContent = `${state.urls.filter(u => u.enabled).length}/${state.urls.length} selected`;
    });
    const nameSpan = document.createElement('span');
    nameSpan.textContent = entry.name;
    nameSpan.style.cssText = `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    row.appendChild(cb);
    row.appendChild(nameSpan);
    listEl.appendChild(row);
  });
  creatorListBodyEl.appendChild(listEl);

  const footerRow = document.createElement('div');
  footerRow.style.cssText = `display:flex;gap:5px;margin-top:6px;`;
  const rescanBtn = makeBtn('↻ Rescan page', '#3b82f6', () => {
    const fresh = refreshCreatorList();
    if (fresh) renderCreatorListEditor(fresh);
  });
  rescanBtn.style.fontSize = '10px';
  const closeBtn = makeBtn('✕ Close', '#555', () => {
    creatorListSectionEl.style.display = 'none';
  });
  closeBtn.style.fontSize = '10px';
  footerRow.appendChild(rescanBtn);
  footerRow.appendChild(closeBtn);
  creatorListBodyEl.appendChild(footerRow);
}

async function startCrawl(crawlBtn) {
  if (crawlRunning || getCrawlState()) {
    // Stop requested — clearing state is what the in-flight crawl step
    // checks against at every await checkpoint, so this halts it promptly
    // even mid-load or mid-queue-capture, instead of finishing the current
    // creator and navigating to the next one anyway.
    crawlRunning = false;
    clearCrawlState();
    crawlBtn.textContent = '🕷 Crawl All Creators';
    crawlBtn.style.background = '#eab308';
    crawlBtn.style.color = '#000';
    updatePanelStatus('Crawl stopped.');
    return;
  }

  if (!/\/creators\/?$/.test(location.pathname)) {
    alert('Go to https://www.tryquinn.com/creators first to start the crawl.');
    return;
  }

  // Prefer the curated list (from the editor) if one exists for this page,
  // filtered down to only the checked-on creators. Falls back to scraping
  // everything fresh if no list has been built yet.
  let urls;
  const listState = getCreatorListState();
  if (listState && listState.urls.length) {
    urls = listState.urls.filter(u => u.enabled).map(u => u.url);
    if (!urls.length) {
      alert('All creators are unchecked in the list — enable at least one, or click "Edit Creator List" to rebuild it.');
      return;
    }
  } else {
    urls = collectCreatorUrls().map(u => u.url);
    if (!urls.length) {
      alert('No creator links found on this page.');
      return;
    }
  }

  const state = {
    urls,
    index: 0,
    done: [] // urls fully processed
  };
  setCrawlState(state);
  updatePanelStatus(`Crawl started: ${urls.length} creators queued`);
  await sleep(500);
  navigateToIndex(state);
}

function navigateToIndex(state) {
  // Always re-read the live state right before navigating — if Stop was
  // clicked, localStorage was cleared and we must NOT navigate using a
  // stale in-memory copy of state.
  const live = getCrawlState();
  if (!live) {
    updatePanelStatus('Crawl stopped.');
    return;
  }
  if (live.index >= live.urls.length) {
    updatePanelStatus('Crawl complete!');
    clearCrawlState();
    return;
  }
  location.href = live.urls[live.index];
}

async function runCrawlStepOnCreatorPage() {
  const state = getCrawlState();
  if (!state) return;
  if (state.index >= state.urls.length) {
    clearCrawlState();
    return;
  }

  crawlRunning = true;
  updatePanelStatus(`Crawling ${state.index + 1}/${state.urls.length}…`);

  // Reset per-page log/pageTitles since this is a fresh page load
  Object.keys(log).forEach(k => delete log[k]);
  pageTitles = [];
  updatePanel();

  // 1. Load all tracks (blue button)
  await loadAllAndScrape();
  if (!getCrawlState()) { updatePanelStatus('Crawl stopped.'); return; } // aborted mid-load
  await sleep(1000);
  if (!getCrawlState()) { updatePanelStatus('Crawl stopped.'); return; }

  // 2. If no tracks, skip silently — no txt
  if (!pageTitles.length) {
    updatePanelStatus('No tracks, skipping…');
    const live = getCrawlState();
    if (!live) return;
    live.index += 1;
    setCrawlState(live);
    await sleep(800);
    navigateToIndex(live);
    return;
  }

  // 3. Click & Capture Queue (green button) — runs its own loop, stops naturally
  const queueBtn = document.getElementById('__quinn_queue_btn');
  const found = await clickQueueAndCapture(queueBtn || { textContent: '', style: {} });
  if (!getCrawlState()) { updatePanelStatus('Crawl stopped.'); return; } // aborted mid-queue

  if (!found) {
    // No queue buttons found despite having page titles — treat as empty, skip
    updatePanelStatus('No queue buttons, skipping…');
    const live = getCrawlState();
    if (!live) return;
    live.index += 1;
    setCrawlState(live);
    await sleep(800);
    navigateToIndex(live);
    return;
  }

  // 4. Queue loop finished naturally — treat as done regardless of missed count
  const creatorName = getCreatorName();
  const saved = saveTxt(`${creatorName}.txt`);

  // Give the download a moment to actually register before navigating away —
  // navigating too fast can cancel an in-flight blob download.
  await sleep(saved ? 1500 : 300);
  if (!getCrawlState()) { updatePanelStatus('Crawl stopped.'); return; }

  const live = getCrawlState();
  if (!live) return;
  live.index += 1;
  setCrawlState(live);
  updatePanelStatus(`Saved "${creatorName}.txt". Moving to next…`);
  await sleep(1000);
  navigateToIndex(live);
}

// ─── Floating Panel ───────────────────────────────────────────────────────
let creatorListSectionEl = null;
let creatorListBodyEl = null;

function buildPanel() {
  const panel = document.createElement('div');
  panel.id = '__quinn_panel';
  panel.style.cssText = `
    position: fixed; bottom: 18px; right: 18px; z-index: 999999;
    background: #111; color: #eee; border: 1px solid #333;
    border-radius: 10px; font-family: monospace; font-size: 12px;
    width: 240px; box-shadow: 0 4px 20px rgba(0,0,0,0.6); user-select: none;
  `;
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a;
    border-radius: 10px 10px 0 0; cursor: move;
  `;
  header.innerHTML = `<span style="color:#f97316;font-weight:bold;">🎵 Quinn Collector</span>`;
  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = '−';
  toggleBtn.style.cssText = `background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:0 2px;`;
  header.appendChild(toggleBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.id = '__quinn_body';
  body.style.cssText = `padding: 8px 10px;`;

  const countRow = document.createElement('div');
  countRow.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;`;
  countEl = document.createElement('span');
  countEl.textContent = '0 captured';
  countEl.style.color = '#4ade80';
  const statusEl = document.createElement('span');
  statusEl.id = '__quinn_status';
  statusEl.style.cssText = `color:#888;font-size:11px;`;
  countRow.appendChild(countEl);
  countRow.appendChild(statusEl);
  body.appendChild(countRow);

  // Row 1: Save, Load, Clear
  const btnRow = document.createElement('div');
  btnRow.style.cssText = `display:flex;gap:5px;margin-bottom:5px;`;
  btnRow.appendChild(makeBtn('💾 Save', '#f97316', () => saveTxt()));
  btnRow.appendChild(makeBtn('🔄 Load', '#3b82f6', loadAllAndScrape));
  btnRow.appendChild(makeBtn('🗑 Clear', '#555', () => {
    Object.keys(log).forEach(k => delete log[k]);
    updatePanel();
  }));
  body.appendChild(btnRow);

  // Row 2: Auto Capture (full width)
  const autoRow = document.createElement('div');
  autoRow.style.cssText = `margin-bottom:5px;`;
  const autoCaptureBtn = makeBtn('⚡ Auto Capture Missed', '#8b5cf6', () => autoCapture(autoCaptureBtn));
  autoCaptureBtn.style.width = '100%';
  autoCaptureBtn.style.fontSize = '11px';
  autoRow.appendChild(autoCaptureBtn);
  body.appendChild(autoRow);

  // Row 3: Click & Capture Queue (full width, new button)
  const queueRow = document.createElement('div');
  queueRow.style.cssText = `margin-bottom:5px;`;
  const queueBtn = makeBtn('🎯 Click & Capture Queue', '#10b981', () => clickQueueAndCapture(queueBtn));
  queueBtn.id = '__quinn_queue_btn';
  queueBtn.style.width = '100%';
  queueBtn.style.fontSize = '11px';
  queueRow.appendChild(queueBtn);
  body.appendChild(queueRow);

  // Row 4: Edit Creator List (full width, new button) — only really useful on /creators
  const editListRow = document.createElement('div');
  editListRow.style.cssText = `margin-bottom:5px;`;
  const editListBtn = makeBtn('📋 Edit Creator List', '#6366f1', openCreatorListEditor);
  editListBtn.style.width = '100%';
  editListBtn.style.fontSize = '11px';
  editListRow.appendChild(editListBtn);
  body.appendChild(editListRow);

  // Creator list editor panel (hidden until "Edit Creator List" is clicked)
  creatorListSectionEl = document.createElement('div');
  creatorListSectionEl.style.cssText = `
    display:none; margin-bottom:8px; background:#0c0c0c; border:1px solid #2a2a2a;
    border-radius:6px; padding:6px;
  `;
  creatorListBodyEl = document.createElement('div');
  creatorListSectionEl.appendChild(creatorListBodyEl);
  body.appendChild(creatorListSectionEl);

  // Row 5: Crawl All Creators (full width) — only really useful on /creators
  const crawlRow = document.createElement('div');
  crawlRow.style.cssText = `margin-bottom:8px;`;
  const crawlBtn = makeBtn('🕷 Crawl All Creators', '#eab308', () => startCrawl(crawlBtn));
  crawlBtn.id = '__quinn_crawl_btn';
  crawlBtn.style.width = '100%';
  crawlBtn.style.fontSize = '11px';
  crawlBtn.style.color = '#000';
  crawlRow.appendChild(crawlBtn);
  body.appendChild(crawlRow);

  missedSectionEl = document.createElement('div');
  missedSectionEl.style.display = 'none';
  const missedHeader = document.createElement('div');
  missedHeader.style.cssText = `color:#f87171;font-size:11px;margin-bottom:4px;font-weight:bold;`;
  missedHeader.textContent = '⚠ Missed:';
  missedSectionEl.appendChild(missedHeader);
  missedListEl = document.createElement('div');
  missedListEl.style.cssText = `max-height:120px;overflow-y:auto;font-size:10px;color:#fca5a5;line-height:1.6;`;
  missedSectionEl.appendChild(missedListEl);
  body.appendChild(missedSectionEl);

  panel.appendChild(body);

  let collapsed = false;
  toggleBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'block';
    toggleBtn.textContent = collapsed ? '+' : '−';
  });

  makeDraggable(panel, header);
  document.body.appendChild(panel);
  panelEl = panel;

  // If a crawl is in progress, reflect it in the UI and resume on this page
  const state = getCrawlState();
  if (state && state.index < state.urls.length) {
    crawlBtn.textContent = '⏹ Stop Crawl';
    crawlBtn.style.background = '#ef4444';
    crawlBtn.style.color = '#fff';
    if (!/\/creators\/?$/.test(location.pathname)) {
      // We're on a creator page mid-crawl — run the step
      setTimeout(() => { runCrawlStepOnCreatorPage(); }, 1200);
    }
  }
}

function makeBtn(label, bg, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = `
    flex:1; background:${bg}; color:#fff; border:none;
    border-radius:5px; padding:4px 3px; font-size:10px;
    cursor:pointer; font-family:monospace;
  `;
  b.addEventListener('click', fn);
  return b;
}

function updatePanel() {
  if (!countEl) return;
  countEl.textContent = `${Object.keys(log).length} captured`;
  const missed = getMissed();
  if (missed.length > 0) {
    missedSectionEl.style.display = 'block';
    missedListEl.innerHTML = missed
      .map(m => `<div>• ${m.title} <span style="color:#888">— ${m.author}</span></div>`)
      .join('');
  } else {
    missedSectionEl.style.display = 'none';
    missedListEl.innerHTML = '';
  }
}

function updatePanelStatus(msg) {
  const el = document.getElementById('__quinn_status');
  if (el) el.textContent = msg;
}

function makeDraggable(el, handle) {
  let ox = 0, oy = 0, startX = 0, startY = 0;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    const rect = el.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
    el.style.left = ox + 'px'; el.style.top = oy + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
    const onMove = ev => {
      el.style.left = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, ox + ev.clientX - startX)) + 'px';
      el.style.top  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, oy + ev.clientY - startY)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function injectPanel() {
  if (document.body) { buildPanel(); return; }
  new MutationObserver((_, obs) => {
    if (document.body) { obs.disconnect(); buildPanel(); }
  }).observe(document.documentElement, { childList: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectPanel);
} else {
  injectPanel();
}

// ─── Intercepts ──────────────────────────────────────────────────────────
const _fetch = window.fetch;
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input?.url;
  if (isAudio(url)) save(url);
  return _fetch.apply(this, arguments);
};

const _open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m, url) {
  if (isAudio(url)) save(url);
  return _open.apply(this, arguments);
};

new MutationObserver(muts => {
  for (const m of muts) {
    if (m.type === 'attributes') {
      const src = m.target.src || m.target.getAttribute('src');
      if (isAudio(src)) save(src);
    }
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      [n, ...n.querySelectorAll('video,audio,source')].forEach(el => {
        const src = el.src || el.getAttribute?.('src');
        if (isAudio(src)) save(src);
      });
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

setInterval(() => {
  document.querySelectorAll('video,audio,source').forEach(el => {
    const src = el.src || el.currentSrc;
    if (isAudio(src)) save(src);
  });
}, 2000);

document.addEventListener('click', () => {
  setTimeout(() => {
    const np = nowPlaying();
    if (!np.title) return;
    Object.values(log).forEach(e => {
      if (!e.title) { e.title = np.title; e.author = np.author; }
    });
    updatePanel();
  }, 900);
}, true);

GM_registerMenuCommand('Show collected links', () => {
  const entries = Object.values(log);
  if (!entries.length) { alert('Nothing captured yet.'); return; }
  alert(entries.map(e => `${e.url} -n ${clean(e.title)} by ${clean(e.author)}${e.ext === 'm3u8' ? '' : '.mp3'}`).join('\n\n'));
});

GM_registerMenuCommand('Save as .txt', () => saveTxt());
GM_registerMenuCommand('Clear log', () => { Object.keys(log).forEach(k => delete log[k]); updatePanel(); alert('Cleared.'); });
GM_registerMenuCommand('Count captured', () => alert(`${Object.keys(log).length} audio(s) captured.`));
GM_registerMenuCommand('Load all & scan page titles', loadAllAndScrape);
GM_registerMenuCommand('Edit creator list', openCreatorListEditor);
GM_registerMenuCommand('Clear creator list', () => { clearCreatorListState(); alert('Creator list cleared.'); });
GM_registerMenuCommand('Stop crawl (clear state)', () => { clearCrawlState(); alert('Crawl state cleared.'); });

})();
