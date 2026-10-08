// Functions injected into Scribd pages with chrome.scripting.executeScript.
// Each one must be self-contained: it is serialized and runs in the page,
// so it cannot use anything defined outside its own body.

/**
 * Scrolls a list page until no new items load, then returns every
 * document link on it.
 */
export async function collectListItems({ maxRounds = 300, pauseMs = 1500 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DOC_RE = /^https?:\/\/([a-z0-9-]+\.)?scribd\.com(?::\d+)?\/(document|doc|presentation)\/(\d+)/i;
  const OTHER_RE = /^https?:\/\/([a-z0-9-]+\.)?scribd\.com(?::\d+)?\/(book|audiobook|podcast|article|sheet-music|magazine)\/(\d+)/i;
  const MORE_RE = /^(load|show|see|view) more\b/i;

  const labelOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim();

  function scrollEverything() {
    window.scrollTo(0, document.documentElement.scrollHeight);
    // Some layouts scroll an inner container instead of the window.
    for (const el of document.querySelectorAll('main, [class*="scroll" i], [class*="list" i]')) {
      if (el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight;
    }
  }

  function clickLoadMore() {
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (MORE_RE.test(labelOf(el)) && el.offsetParent !== null) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function snapshot() {
    const docs = new Map();
    const other = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      const m = href.match(DOC_RE);
      if (m) {
        const id = m[3];
        const title = (a.getAttribute('title') || a.getAttribute('aria-label') || a.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        const prev = docs.get(id);
        // Keep the longest label seen for this id; cover images often have an empty one.
        if (!prev || title.length > prev.title.length) {
          docs.set(id, { id, url: href.split(/[?#]/)[0], title });
        }
      } else if (OTHER_RE.test(href)) {
        other.add(href.split(/[?#]/)[0]);
      }
    }
    return { docs, other };
  }

  let lastCount = -1;
  let stableRounds = 0;
  for (let round = 0; round < maxRounds && stableRounds < 3; round++) {
    scrollEverything();
    const clicked = clickLoadMore();
    await sleep(pauseMs);
    const count = snapshot().docs.size;
    if (count === lastCount && !clicked) stableRounds++;
    else stableRounds = 0;
    lastCount = count;
  }

  const { docs, other } = snapshot();
  const heading = document.querySelector('h1');
  return {
    listTitle: (heading?.textContent || document.title || 'Scribd list').trim(),
    pageUrl: location.href,
    items: [...docs.values()],
    skippedNonDocuments: [...other],
  };
}

/**
 * Clicks Scribd's own Download control on a document page.
 * phase "primary": the Download button on the page.
 * phase "secondary": an option inside the dialog that opens after it
 * (a PDF choice, or a confirming Download button).
 * With dryRun (primary phase only), it waits for the button but doesn't click it.
 * Returns { clicked: boolean, label?: string, reason?: string }
 * (with dryRun, clicked means the button was found).
 */
export async function clickDownload({ phase = 'primary', timeoutMs = 20000, dryRun = false } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const labelOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  // Ignore "Download the app" style links.
  const isAppPromo = (label) => /\bapp\b/i.test(label);

  function findPrimary() {
    const candidates = document.querySelectorAll(
      'button, a, [role="button"], [data-e2e*="download" i], [data-testid*="download" i]'
    );
    for (const el of candidates) {
      if (!visible(el) || !enabled(el)) continue;
      if (el.closest('[role="dialog"]')) continue;
      const label = labelOf(el);
      const attrHit = /download/i.test(
        (el.getAttribute('data-e2e') || '') + (el.getAttribute('data-testid') || '')
      );
      if ((/^download\b/i.test(label) || attrHit) && !isAppPromo(label)) return { el, label };
    }
    return null;
  }

  function dialogClickables() {
    const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]');
    return [...dialogs].flatMap((d) =>
      [...d.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="radio"], label')]
        .filter((el) => visible(el) && enabled(el))
    );
  }
  const findPdf = () => dialogClickables().find((el) => /\bpdf\b/i.test(labelOf(el)));
  const findConfirm = () =>
    dialogClickables().find((el) => /^download\b/i.test(labelOf(el)) && !isAppPromo(labelOf(el)));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (phase === 'primary') {
      const hit = findPrimary();
      if (hit) {
        if (!dryRun) hit.el.click();
        return { clicked: true, label: hit.label };
      }
    } else {
      // The dialog may offer a format choice (PDF) and/or a confirming Download button.
      const labels = [];
      const pdf = findPdf();
      if (pdf) {
        labels.push(labelOf(pdf));
        pdf.click();
        await sleep(700);
      }
      const confirm = findConfirm();
      if (confirm && confirm !== pdf) {
        labels.push(labelOf(confirm));
        confirm.click();
      }
      if (labels.length) return { clicked: true, label: labels.join(' → ') };
    }
    await sleep(500);
  }
  return {
    clicked: false,
    reason: phase === 'secondary' ? 'no PDF/confirm option found in dialog' : 'no Download button on page',
  };
}
