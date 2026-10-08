const msg = document.getElementById('msg');

function isScribd(url) {
  try {
    return /(^|\.)scribd\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function openManager(params = '') {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html${params}`) });
  window.close();
}

document.getElementById('scan').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isScribd(tab.url)) {
    msg.textContent = 'The current tab is not a scribd.com page.';
    return;
  }
  // The manager tab runs the scan, so closing this popup does not cancel it.
  await openManager(`?scanTab=${tab.id}`);
});

document.getElementById('open').addEventListener('click', () => openManager());
