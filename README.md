# ListDL — bulk-download a Scribd list

A Chrome extension that goes through a Scribd list (or your **Saved** page) and
downloads each document by clicking **Scribd's own Download button**, one at a
time, in your normal logged-in browser.

It does **not** rebuild documents from the page viewer, and it does not get around
paywalls or download restrictions. If Scribd shows no Download button for a document
on your account, ListDL marks it **no-download** and moves on.

---

## Install (one time)

1. Download this repository: **Code → Download ZIP** on GitHub. Unzip it.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked**, then select the `extension` folder inside the unzipped folder.
5. Optional: click the puzzle-piece icon in the toolbar and pin **ListDL**.

## Download a list

1. Log in to Scribd in Chrome.
2. Open the list you want, for example your **Saved** page or a list in your library.
3. Click the **ListDL** icon, then **Scan this list**.
   A manager tab opens. It scrolls the list page (and clicks “Load more” if there is one)
   until every item has loaded. Large lists can take a minute.
4. Check the table of found documents. Books, audiobooks and other non-document items
   are listed under *Not documents* and skipped.
5. Optional: adjust the speed settings.
   - **Documents at a time** (default 3, max 5): how many document pages load at once.
   - **Pause after each document** (default 2 seconds).

   Lower numbers are gentler on Scribd. If you start seeing *failed* items or Scribd
   asks you to verify you're human, lower **Documents at a time** and raise the pause.
6. Click **Start downloading**. Keep the manager tab open.
   For each document, ListDL opens the page in a background tab, clicks **Download**,
   picks **PDF** in the dialog if one appears, waits for the file to start, then closes the tab.
   Pages load in parallel, but the Download clicks happen one at a time. That's how
   ListDL knows which file belongs to which document.
7. Files are saved to `Downloads/ListDL/<list name>/<document title>.pdf`.

### Tips

- **Pause** stops after the documents already in progress. **Start downloading** resumes where it stopped.
- **Retry failed** runs the *failed* and *no-download* items again.
- **Export report (CSV)** saves the status of every item.
- Documents downloaded in an earlier run are marked *done* and skipped. Tick
  **Re-download items already saved** to fetch them again.
- Don't start other downloads in Chrome during a run. ListDL treats any download that
  starts while it is processing a document as that document's file.
- If Chrome asks *“This site is trying to download multiple files”*, click **Allow**.
- If Chrome is set to *Ask where to save each file*, you'll get a save dialog for every
  document. Turn that off under `chrome://settings/downloads` for a hands-off run.

## Status meanings

| Status | Meaning |
|---|---|
| pending | Not processed yet |
| working | Being processed now |
| saving | Download started, file still being written |
| done | File saved (path shown in Details) |
| no-download | No Download button found. Usually Scribd doesn't offer a download for this document on your account. |
| failed | Something went wrong (page timeout, a click that started no download, download interrupted). See Details. |

## Known limitations — please read

- **Not yet tested on the real scribd.com.** The cloud machine this was built on cannot
  reach scribd.com, so I couldn't check Scribd's actual page layout. ListDL finds
  buttons by visible text and labels (“Download”, “PDF”, “Load more”), not by exact
  page code. It was tested end-to-end against a mock site (see *Tests*). If Scribd labels
  things differently, scanning or downloading may not work. In that case, open an issue
  that includes the **Details** column from the manager.
- Scribd's page design can change at any time and may break the button detection.
- Only `scribd.com/document/…`, `/doc/…` and `/presentation/…` links are collected.

## Terms of use and copyright

ListDL only automates clicks you could make yourself, on documents Scribd already lets
your account download. Scribd decides what is downloadable: it depends on your
subscription and on whether the uploader enabled downloads
([UPDF guide](https://updf.com/knowledge/scribd-to-pdf/), a third-party source).

Scribd has taken action against tools that bypass its restrictions. In 2019 it had a
“Scribd-Downloader” project removed from GitHub under the DMCA
([TorrentFreak](https://torrentfreak.com/scribd-files-complaint-against-drm-circumvention-tool-190224/),
[WIPR](https://www.worldipreview.com/copyright/scribd-targets-student-creator-of-unauthorised-download-tool-17566)).
Scribd's [Global Terms of Use](https://support.scribd.com/hc/articles/210129326) apply
to automated use too. Read them yourself; this README is not legal advice. Downloaded
files are still under their owners' copyright.

## Privacy

ListDL has no server. It sends nothing anywhere. It stores the scanned list and download
status in Chrome's local extension storage, on your computer only.

Permissions it uses:

| Permission | Why |
|---|---|
| `scribd.com` site access | Read list pages and click Download on document pages |
| `scripting` | Run the scan and click steps in those pages |
| `tabs` | Open and close a background tab for each document, and check that the current tab is on Scribd |
| `downloads` | Notice when each file starts, and name it `ListDL/<list>/<title>` |
| `storage` | Remember the list and progress between sessions |

## Tests

`test/mock-server.js` is a fake Scribd-like site. It has a list with “Load more”, a
document with a direct Download link, documents with a *Download → PDF → Download*
dialog, a document without a download option, and a book link. `test/e2e.js` loads the
extension into headless Chromium and checks scanning, downloading, skipping, file naming
and tab cleanup.

```bash
npm install playwright-core   # once
node test/e2e.js              # set CHROME=/path/to/chrome if needed
```
