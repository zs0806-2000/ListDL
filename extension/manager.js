import { collectListItems, clickDownload } from './page-scripts.js';

// This page is a normal extension tab, so it stays alive for as long as it is
// open. The queue runs here rather than in a service worker, which Chrome may
// stop at any time. Everything that must survive a reload lives in storage.

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_LOAD_TIMEOUT_MS = 45000;
const DIRECT_WAIT_MS = 1500; // a Download button that starts the file directly does so quickly
const DIALOG_FIND_MS = 6000; // how long to look for the PDF / confirm dialog after the first click
const DIALOG_WAIT_MS = 30000; // how long to wait for the file after choosing PDF / confirming

let job = null; // { listTitle, pageUrl, items: [...], skippedNonDocuments: [...] }
let running = false;
// Several documents load in parallel, but only one at a time may be between
// "click Download" and "download started": that is how each new download is
// matched to its document. `current` is the document holding that slot.
let current = null; // { item, downloadId, resolve }
let clickLock = Promise.resolve();
const downloadToItem = new Map(); // downloadId -> item id

// ---------- storage ----------

async function loadJob() {
  ({ job = null } = await chrome.storage.local.get('job'));
}

async function saveJob() {
  await chrome.storage.local.set({ job });
}

async function getDoneIds() {
  const { doneIds = [] } = await chrome.storage.local.get('doneIds');
  return new Set(doneIds);
}

async function markDoneId(id) {
  const ids = await getDoneIds();
  ids.add(id);
  await chrome.storage.local.set({ doneIds: [...ids] });
}

// ---------- rendering ----------

function setStatus(text) {
  $('status').textContent = text;
}

function render() {
  const rows = $('rows');
  rows.replaceChildren();
  if (!job) {
    $('title').textContent = 'ListDL';
    $('source').textContent = 'No list scanned yet. Open a Scribd list, click the ListDL icon, then “Scan this list”.';
    $('summary').textContent = '';
    $('skipped-wrap').hidden = true;
    return;
  }
  $('title').textContent = job.listTitle;
  $('source').textContent = job.pageUrl;

  const counts = {};
  job.items.forEach((item, i) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    const tr = document.createElement('tr');
    const num = document.createElement('td');
    num.textContent = String(i + 1);
    const titleCell = document.createElement('td');
    const a = document.createElement('a');
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = item.title || `Document ${item.id}`;
    titleCell.append(a);
    const status = document.createElement('td');
    status.textContent = item.status;
    status.className = `s-${item.status}`;
    const detail = document.createElement('td');
    detail.textContent = item.detail || '';
    tr.append(num, titleCell, status, detail);
    rows.append(tr);
  });
  $('summary').textContent =
    `${job.items.length} documents · ` +
    Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');

  const skipped = job.skippedNonDocuments || [];
  $('skipped-wrap').hidden = skipped.length === 0;
  $('skipped').replaceChildren(
    ...skipped.map((url) => {
      const li = document.createElement('li');
      li.textContent = url;
      return li;
    })
  );
}

function setRunning(value) {
  running = value;
  $('start').disabled = value;
  $('retry').disabled = value;
  $('clear').disabled = value;
  $('parallel').disabled = value;
  $('delay').disabled = value;
  $('pause').disabled = !value;
}

// ---------- tab helpers ----------

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('page took too long to load'));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // It may already be complete.
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && listener(tabId, { status: 'complete' }), () => {});
  });
}

async function runInTab(tabId, func, arg) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [arg] });
  return result?.result;
}

// ---------- downloads ----------

function sanitize(name, fallback) {
  const clean = (name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return clean || fallback;
}

// Resolves with the download id once a download starts, or null on timeout.
function waitForDownload(timeoutMs) {
  return new Promise((resolve) => {
    if (current.downloadId) return resolve(current.downloadId);
    const timer = setTimeout(() => {
      current.resolve = null;
      resolve(null);
    }, timeoutMs);
    current.resolve = (id) => {
      clearTimeout(timer);
      current.resolve = null;
      resolve(id);
    };
  });
}

// Any download that starts while a document holds the click slot is treated
// as that document's file, so avoid starting other downloads in this browser
// while a run is active.
chrome.downloads.onCreated.addListener((dl) => {
  if (!current || current.downloadId || dl.byExtensionId === chrome.runtime.id) return;
  current.downloadId = dl.id;
  downloadToItem.set(dl.id, current.item.id);
  current.resolve?.(dl.id);
});

chrome.downloads.onDeterminingFilename.addListener((dl, suggest) => {
  let itemId = downloadToItem.get(dl.id);
  // In case this event arrives before onCreated for the same download.
  if (!itemId && current && !current.downloadId && dl.byExtensionId !== chrome.runtime.id) {
    current.downloadId = dl.id;
    downloadToItem.set(dl.id, current.item.id);
    current.resolve?.(dl.id);
    itemId = current.item.id;
  }
  const item = itemId && job?.items.find((i) => i.id === itemId);
  if (!item) {
    suggest();
    return;
  }
  const ext = (dl.filename.match(/\.[a-z0-9]{2,5}$/i) || ['.pdf'])[0].toLowerCase();
  const folder = sanitize(job.listTitle, 'Scribd list');
  const file = sanitize(item.title, `scribd-${item.id}`);
  suggest({ filename: `ListDL/${folder}/${file}${ext}`, conflictAction: 'uniquify' });
});

chrome.downloads.onChanged.addListener(async (delta) => {
  const itemId = downloadToItem.get(delta.id);
  const item = itemId && job?.items.find((i) => i.id === itemId);
  if (!item || !delta.state) return;
  if (delta.state.current === 'complete') {
    const [dl] = await chrome.downloads.search({ id: delta.id });
    item.status = 'done';
    item.detail = dl?.filename || 'saved';
    await markDoneId(item.id);
  } else if (delta.state.current === 'interrupted') {
    const [dl] = await chrome.downloads.search({ id: delta.id });
    item.status = 'failed';
    item.detail = `download interrupted (${dl?.error || 'unknown reason'})`;
  } else {
    return;
  }
  downloadToItem.delete(delta.id);
  await saveJob();
  render();
});

// ---------- queue ----------

// Runs fn while holding the click slot (see `current` above).
function withClickSlot(fn) {
  const result = clickLock.then(fn);
  clickLock = result.catch(() => {});
  return result;
}

async function processItem(item) {
  item.status = 'working';
  item.detail = 'opening page';
  render();

  const tab = await chrome.tabs.create({ url: item.url, active: false });
  try {
    // Slow part, done in parallel: load the page and wait for its Download button.
    await waitForTabComplete(tab.id, PAGE_LOAD_TIMEOUT_MS);
    const found = await runInTab(tab.id, clickDownload, { phase: 'primary', timeoutMs: 20000, dryRun: true });
    if (!found?.clicked) {
      item.status = 'no-download';
      item.detail = found?.reason || 'no Download button found';
      return;
    }
    item.detail = 'waiting for its turn to click';
    render();

    // Short part, one document at a time: click and wait for the file to start.
    await withClickSlot(async () => {
      current = { item, downloadId: null, resolve: null };
      try {
        const first = await runInTab(tab.id, clickDownload, { phase: 'primary', timeoutMs: 5000 });
        if (!first?.clicked) throw new Error(first?.reason || 'Download button disappeared');
        const clicked = [first.label];

        let downloadId = await waitForDownload(DIRECT_WAIT_MS);
        if (!downloadId) {
          const second = await runInTab(tab.id, clickDownload, { phase: 'secondary', timeoutMs: DIALOG_FIND_MS });
          if (second?.clicked) clicked.push(second.label);
          downloadId = await waitForDownload(second?.clicked ? DIALOG_WAIT_MS : 0);
        }

        if (downloadId) {
          // onChanged moves it to "done" (or "failed") when the file finishes.
          if (item.status === 'working') {
            item.status = 'saving';
            item.detail = `clicked: ${clicked.join(' → ')}`;
          }
        } else {
          item.status = 'failed';
          item.detail = `clicked “${clicked.join(' → ')}” but no download started`;
        }
      } finally {
        current = null;
      }
    });
  } catch (err) {
    item.status = 'failed';
    item.detail = err?.message || String(err);
  } finally {
    // Closing the tab does not cancel a download that has already started.
    await chrome.tabs.remove(tab.id).catch(() => {});
    await saveJob();
    render();
  }
}

async function run(statuses) {
  if (!job || running) return;
  setRunning(true);
  try {
    const delayMs = Math.max(0, Number($('delay').value) || 0) * 1000;
    const parallel = Math.min(5, Math.max(1, Number($('parallel').value) || 3));
    const todo = job.items.filter((i) => statuses.includes(i.status));
    let next = 0;
    let finished = 0;
    const progress = () =>
      setStatus(`Processed ${finished} of ${todo.length} (${parallel} at a time)…`);
    progress();

    // Each worker takes the next document from the shared queue until it is empty.
    async function worker(n) {
      // Stagger start-up so the first pages don't all load at the same instant.
      await sleep(n * 1000);
      while (running && next < todo.length) {
        await processItem(todo[next++]);
        finished++;
        progress();
        if (running && next < todo.length && delayMs) await sleep(delayMs);
      }
    }
    await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, (_, n) => worker(n)));
    setStatus(running ? 'Finished. Files still saving will update below.' : 'Paused.');
  } finally {
    setRunning(false);
  }
}

// ---------- scanning ----------

async function scan(tabId) {
  setStatus('Scanning the list — scrolling until every item has loaded. This can take a minute…');
  try {
    const result = await runInTab(tabId, collectListItems, {});
    if (!result) throw new Error('the page returned nothing');
    const doneIds = await getDoneIds();
    job = {
      listTitle: result.listTitle,
      pageUrl: result.pageUrl,
      skippedNonDocuments: result.skippedNonDocuments,
      items: result.items.map((it) => ({
        ...it,
        status: doneIds.has(it.id) ? 'done' : 'pending',
        detail: doneIds.has(it.id) ? 'downloaded in an earlier run' : '',
      })),
    };
    await saveJob();
    setStatus(
      result.items.length
        ? `Found ${result.items.length} documents. Press “Start downloading”.`
        : 'No document links were found on that page. Is it a Scribd list or Saved page?'
    );
  } catch (err) {
    setStatus(`Scan failed: ${err?.message || err}`);
  }
  render();
}

// ---------- CSV ----------

function exportCsv() {
  if (!job) return;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['id', 'title', 'url', 'status', 'detail'].join(',')];
  for (const i of job.items) lines.push([i.id, i.title, i.url, i.status, i.detail].map(esc).join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${sanitize(job.listTitle, 'scribd-list')}-report.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- wiring ----------

$('start').addEventListener('click', () => {
  const statuses = ['pending'];
  if ($('redownload').checked) statuses.push('done', 'no-download', 'failed');
  run(statuses);
});
$('retry').addEventListener('click', () => run(['failed', 'no-download']));
$('pause').addEventListener('click', () => {
  running = false;
  $('pause').disabled = true;
  setStatus('Pausing after the documents in progress…');
});
$('export').addEventListener('click', exportCsv);
$('clear').addEventListener('click', async () => {
  job = null;
  await chrome.storage.local.remove('job');
  setStatus('');
  render();
});

window.addEventListener('beforeunload', (e) => {
  if (running) e.preventDefault();
});

(async () => {
  await loadJob();
  // Items left mid-flight by a closed tab go back in the queue.
  if (job) {
    for (const i of job.items) {
      if (i.status === 'working') {
        i.status = 'pending';
        i.detail = 'interrupted; will retry';
      } else if (i.status === 'saving') {
        i.status = 'failed';
        i.detail = 'manager tab closed while saving — check your Downloads folder, then Retry if missing';
      }
    }
  }
  render();
  const scanTab = Number(new URLSearchParams(location.search).get('scanTab'));
  if (scanTab) {
    history.replaceState(null, '', location.pathname); // don't rescan on reload
    await scan(scanTab);
  }
})();
