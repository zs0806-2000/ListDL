// Minimal stand-in for Scribd pages, used only to test the extension's plumbing.
// It does NOT reproduce Scribd's real markup.
const http = require('http');
const https = require('https');
const fs = require('fs');

const TOTAL = 12;
const NO_DOWNLOAD = new Set(['1003']);
const DIRECT = new Set(['1002']); // Download button starts the file without a dialog

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Mock</title></head><body>${body}</body></html>`;

function listPage() {
  return page(`
  <h1>My Test List</h1>
  <div id="items"></div>
  <a href="/book/555/Some-Book">A book (should be skipped)</a>
  <button id="more">Load more</button>
  <script>
    let shown = 0;
    function add(n) {
      for (let i = 0; i < n && shown < ${TOTAL}; i++, shown++) {
        const id = 1001 + shown;
        const div = document.createElement('div');
        div.innerHTML = '<a href="/document/' + id + '/Doc-' + id + '"><img alt=""></a> ' +
                        '<a href="/document/' + id + '/Doc-' + id + '?from=list">Mock Document ' + id + '</a>';
        document.getElementById('items').append(div);
      }
      if (shown >= ${TOTAL}) document.getElementById('more').remove();
    }
    add(5);
    document.getElementById('more').addEventListener('click', () => setTimeout(() => add(5), 300));
  </script>`);
}

function docPage(id) {
  if (NO_DOWNLOAD.has(id)) return page(`<h1>Doc ${id}</h1><a href="/app">Download the app</a>`);
  if (DIRECT.has(id)) return page(`<h1>Doc ${id}</h1><a href="/file/${id}.pdf"><span>Download</span></a>`);
  return page(`
  <h1>Doc ${id}</h1>
  <button aria-label="Download" id="dl">⬇</button>
  <script>
    document.getElementById('dl').addEventListener('click', () => {
      const d = document.createElement('div');
      d.setAttribute('role', 'dialog');
      d.innerHTML = '<label><input type="radio" name="f"> PDF</label><label><input type="radio" name="f"> TXT</label>' +
                    '<button id="go">Download</button>';
      document.body.append(d);
      let fmt = null;
      d.querySelectorAll('label')[0].addEventListener('click', () => fmt = 'pdf');
      d.querySelector('#go').addEventListener('click', () => { if (fmt) location.href = '/file/${id}.' + fmt; });
    });
  </script>`);
}

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  let m;
  if (url.pathname === '/list') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(listPage());
  } else if ((m = url.pathname.match(/^\/document\/(\d+)/))) {
    res.writeHead(200, { 'content-type': 'text/html' }).end(docPage(m[1]));
  } else if ((m = url.pathname.match(/^\/file\/(\d+)\.(\w+)$/))) {
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="server-name-${m[1]}.${m[2]}"`,
    }).end(`%PDF-1.4 mock ${m[1]}\n`);
  } else {
    res.writeHead(404).end('not found');
  }
}

// With TLS_KEY/TLS_CERT set it serves https (Chrome holds plain-http downloads
// for confirmation in headless mode, so the e2e test uses https).
const port = Number(process.env.PORT || 8080);
if (process.env.TLS_KEY && process.env.TLS_CERT) {
  https.createServer({ key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) }, handler)
    .listen(port, '127.0.0.1');
} else {
  http.createServer(handler).listen(port, '127.0.0.1');
}
