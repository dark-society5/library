/* Worker client for indexing document bodies and searching the loaded index. */
(() => {
  'use strict';

  let worker = null;
  let workerFailed = false;
  let nextId = 1;
  const pending = new Map();
  const fallbackDocuments = new Map();

  function fallbackExtract(html) {
    const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
    parsed.querySelectorAll('script, style, noscript, template, svg, iframe, object, button, textarea, select')
      .forEach(node => node.remove());
    return String(parsed.body ? parsed.body.textContent : parsed.documentElement.textContent)
      .replace(/[\u00a0\s]+/g, ' ').trim().toLocaleLowerCase();
  }

  function fallbackSearch(query, documents) {
    const needle = String(query || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (!needle) return [];
    const matches = [];
    for (const item of Array.isArray(documents) ? documents : []) {
      const id = String(item && item.id || '');
      const titleMatches = String(item && item.title || '').toLocaleLowerCase().includes(needle);
      let text = fallbackDocuments.get(id);
      if (typeof text !== 'string' && item && item.content) {
        text = fallbackExtract(item.content);
        fallbackDocuments.set(id, text);
      }
      text = typeof text === 'string' ? text : '';
      let occurrenceCount = 0;
      let offset = 0;
      while (text && (offset = text.indexOf(needle, offset)) !== -1) {
        occurrenceCount += 1;
        offset += Math.max(needle.length, 1);
      }
      if (occurrenceCount || titleMatches) matches.push({ id, occurrenceCount, titleOnly: occurrenceCount === 0 });
    }
    return matches;
  }

  function startWorker() {
    if (worker || workerFailed || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker(new URL('./search-index-worker.js?v=20261105-worker-search-v4', document.baseURI));
      worker.addEventListener('message', event => {
        const data = event.data || {};
        const resolve = pending.get(data.id);
        if (!resolve) return;
        pending.delete(data.id);
        resolve(data);
      });
      worker.addEventListener('error', () => {
        workerFailed = true;
        try { worker.terminate(); } catch (_) {}
        worker = null;
        pending.forEach(resolve => resolve(null));
        pending.clear();
      });
    } catch (_) {
      workerFailed = true;
      worker = null;
    }
    return worker;
  }

  function request(payload) {
    const activeWorker = startWorker();
    if (!activeWorker) return Promise.resolve(null);
    const id = nextId++;
    return new Promise(resolve => {
      pending.set(id, resolve);
      try { activeWorker.postMessage({ ...payload, id }); }
      catch (_) { pending.delete(id); resolve(null); }
    });
  }

  async function index(documentId, html) {
    const id = String(documentId || '');
    const result = await request({ type: 'index', documentId: id, html: String(html || '') });
    if (result && result.indexed) return true;
    // Rare fallback for browsers that block Workers (for example, file://).
    // The extracted text is kept locally only in this fallback mode.
    const text = fallbackExtract(html);
    fallbackDocuments.set(id, text);
    return text;
  }

  async function search(query, documents) {
    const result = await request({
      type: 'search',
      query: String(query || ''),
      documents: (Array.isArray(documents) ? documents : []).map(item => ({
        id: String(item.id || ''),
        title: String(item.title || '')
      }))
    });
    if (result && Array.isArray(result.results)) return result.results;
    return fallbackSearch(query, documents);
  }

  window.SGMLSearchIndexer = { index, search };
})();
