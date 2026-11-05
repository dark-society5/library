/*
 * Google Drive folder browser for the SGML Study Library.
 * Folder enumeration is separate from document import:
 *   - Folder: embeddedfolderview HTML -> child names + file IDs.
 *   - Document: js/sgml-document-fetcher.js -> SGML's own ?gdrive= import flow.
 */
(() => {
  'use strict';

  const DRIVE_FOLDER_ID = '1ix3U1QiAh-8bsl5VVmINBaeN-ZAK69Il';
  const FOLDER_URL = 'https://proxy.cors.dev/https://drive.google.com/embeddedfolderview?id=' + encodeURIComponent(DRIVE_FOLDER_ID);

  let documents = [];
  let activeRefresh = null;
  let lastError = '';

  // Page-lifetime cache: refreshes keep loaded content; a full page reload clears it.
  const sessionContentCache = new Map();
  const pendingLoads = new Map();

  function extractDriveId(value) {
    const source = String(value || '').trim();
    if (!source) return '';
    const patterns = [
      /\/(?:file|document|spreadsheets|presentation|forms)\/d\/([a-zA-Z0-9_-]+)/i,
      /\/d\/([a-zA-Z0-9_-]+)/i,
      /[?&]id=([a-zA-Z0-9_-]+)/i
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match && match[1]) return match[1];
    }
    return /^[a-zA-Z0-9_-]{10,}$/.test(source) ? source : '';
  }

  function cleanText(value) {
    return String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function titleFromFileName(name) {
    const cleaned = cleanText(name);
    return cleaned.replace(/\.[^.]+$/, '').trim() || cleaned || 'Untitled document';
  }

  // Sort by the first character's class: symbols, numbers, uppercase,
  // lowercase, then uncased letters. Keep natural numeric ordering inside
  // each group (for example, File 2 before File 10).
  function nameSortGroup(value) {
    const first = Array.from(String(value || '').trim())[0] || '';
    if (/^\p{N}$/u.test(first)) return 1;
    if (/^\p{Lu}$/u.test(first)) return 2;
    if (/^\p{Ll}$/u.test(first)) return 3;
    if (/^\p{L}$/u.test(first)) return 4;
    return 0;
  }

  function compareDocumentNames(a, b) {
    const groupDifference = nameSortGroup(a.title) - nameSortGroup(b.title);
    if (groupDifference) return groupDifference;
    return a.title.localeCompare(b.title, undefined, {
      numeric: true,
      sensitivity: 'variant'
    });
  }

  function readResourceKey(href, entry) {
    try {
      const fromLink = new URL(href, 'https://drive.google.com').searchParams.get('resourcekey');
      if (fromLink) return fromLink;
    } catch (_) {}
    return entry && (entry.getAttribute('data-resourcekey') || entry.getAttribute('data-resource-key')) || '';
  }

  function makeDocument(id, name, href, resourceKey) {
    const cached = sessionContentCache.get(id);
    return {
      id,
      name: cleanText(name) || (id + '.docx'),
      title: titleFromFileName(name),
      extension: ((String(name || '').match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase(),
      resourceKey: resourceKey || '',
      sourceUrl: 'https://drive.google.com/file/d/' + id + '/view',
      content: cached ? cached.content : '',
      searchText: cached && cached.searchText ? cached.searchText : '',
      loaded: Boolean(cached),
      loading: pendingLoads.has(id),
      error: ''
    };
  }

  // Use Drive's embedded folder markup and the exact selectors from the
  // user's working folder-listing example: .flip-entry, its /file/d/ link,
  // and .flip-entry-title. Include a broader fallback for newer markup.
  function parseFolderListing(html) {
    const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const seen = new Set();
    const result = [];
    const entries = Array.from(parsed.querySelectorAll('.flip-entry'));

    function addEntry(entry, link, titleElement) {
      if (!link) return;
      const href = link.getAttribute('href') || link.href || '';
      const id = extractDriveId(href) || extractDriveId(entry && entry.getAttribute('data-id'));
      if (!id || seen.has(id)) return;
      const name = cleanText(titleElement && titleElement.textContent) ||
        cleanText(link.getAttribute('aria-label')) ||
        cleanText(link.getAttribute('title')) ||
        cleanText(link.textContent) ||
        ('Document ' + id);
      if (/^folder\b/i.test(name) || /\/folders\//i.test(href)) return;
      seen.add(id);
      result.push(makeDocument(id, name, href, readResourceKey(href, entry)));
    }

    if (entries.length) {
      entries.forEach(entry => {
        const link = entry.querySelector('a[href*="/file/d/"], a[href*="/document/d/"]');
        const titleElement = entry.querySelector('.flip-entry-title');
        addEntry(entry, link, titleElement);
      });
    }

    // Newer/alternate Drive responses may not use .flip-entry. Fall back to
    // direct file anchors, but never use folder navigation links as documents.
    if (!result.length) {
      Array.from(parsed.querySelectorAll('a[href]')).forEach(link => {
        const href = link.getAttribute('href') || '';
        if (/\/folders\//i.test(href)) return;
        const entry = link.closest('[data-id], .flip-entry') || link.parentElement;
        const titleElement = entry && entry.querySelector('.flip-entry-title');
        addEntry(entry, link, titleElement);
      });
    }

    result.sort(compareDocumentNames);
    return result;
  }

  async function fetchFolderListing() {
    // Folder enumeration is intentionally its own fetcher. The SGML file
    // importer is used later, only after a document is selected.
    const response = await fetch(FOLDER_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error('Could not fetch the Google Drive folder (HTTP ' + response.status + ').');
    }
    const html = await response.text();
    const items = parseFolderListing(html);
    if (!items.length) {
      throw new Error('Drive returned the folder page, but no .flip-entry files could be read. Check that the folder is shared as Anyone with the link — Viewer.');
    }
    return items;
  }

  function applyCachedContent(item, cached) {
    item.content = cached.content;
    item.searchText = cached.searchText || '';
    item.loaded = true;
    item.loading = false;
    item.error = '';
    return item;
  }

  async function loadDocument(item) {
    if (!item) throw new Error('The selected document is no longer in this folder.');

    const cached = sessionContentCache.get(item.id);
    if (cached) return applyCachedContent(item, cached);

    const active = pendingLoads.get(item.id);
    if (active) {
      item.loading = true;
      try {
        return applyCachedContent(item, await active);
      } catch (error) {
        item.error = String(error && error.message || error);
        throw error;
      } finally {
        item.loading = false;
        document.dispatchEvent(new CustomEvent('sgml-library:item-updated', { detail: { item } }));
      }
    }

    if (!window.SGMLDocumentFetcher || typeof window.SGMLDocumentFetcher.fetchAndConvertById !== 'function') {
      throw new Error('The SGML Drive document fetcher is unavailable. Refresh the page and retry.');
    }

    item.loading = true;
    item.error = '';
    document.dispatchEvent(new CustomEvent('sgml-library:item-updated', { detail: { item } }));

    const task = window.SGMLDocumentFetcher.fetchAndConvertById(item.id, item.name, item.resourceKey)
      .then(async converted => {
        // Build the plain-text search index in a Web Worker so large imported
        // documents do not make typing or scrolling compete with text parsing.
        const searchIndexResult = window.SGMLSearchIndexer
          ? await window.SGMLSearchIndexer.index(item.id, converted.content)
          : '';
        // The Worker retains the normalized body; the UI keeps a copy only
        // when the browser has to use the no-Worker fallback.
        const searchText = typeof searchIndexResult === 'string' ? searchIndexResult : '';
        const entry = {
          content: converted.content,
          searchText,
          kind: converted.kind,
          fileName: converted.fileName,
          warnings: converted.warnings
        };
        sessionContentCache.set(item.id, entry);
        return entry;
      });
    pendingLoads.set(item.id, task);

    try {
      return applyCachedContent(item, await task);
    } catch (error) {
      item.error = String(error && error.message || error);
      throw error;
    } finally {
      item.loading = false;
      pendingLoads.delete(item.id);
      document.dispatchEvent(new CustomEvent('sgml-library:item-updated', { detail: { item } }));
    }
  }

  async function refreshDocument(id) {
    const safeId = extractDriveId(id);
    const item = documents.find(entry => entry.id === safeId);
    if (!item) throw new Error('The selected document is no longer in this folder.');

    // A reader-pane refresh deliberately bypasses the page-session cache so
    // the selected file is fetched and converted again from Google Drive.
    const pending = pendingLoads.get(safeId);
    if (pending) {
      try { await pending; } catch (_) {}
    }
    sessionContentCache.delete(safeId);
    item.content = '';
    item.searchText = '';
    item.loaded = false;
    item.loading = false;
    item.error = '';
    document.dispatchEvent(new CustomEvent('sgml-library:item-updated', { detail: { item } }));
    return loadDocument(item);
  }

  async function refresh() {
    if (activeRefresh) return activeRefresh;
    activeRefresh = (async () => {
      lastError = '';
      const refreshed = await fetchFolderListing();
      // Reattach the session cache to fresh folder metadata without re-downloading.
      documents = refreshed.map(item => {
        const cached = sessionContentCache.get(item.id);
        if (cached) applyCachedContent(item, cached);
        return item;
      });
      document.dispatchEvent(new CustomEvent('sgml-library:loaded', { detail: { documents } }));
      document.dispatchEvent(new CustomEvent('sgml-library:ready', { detail: { documents } }));
      return documents;
    })();
    try {
      return await activeRefresh;
    } catch (error) {
      lastError = String(error && error.message || error);
      throw error;
    } finally {
      activeRefresh = null;
    }
  }

  window.SGMLDriveLibrary = {
    folderId: DRIVE_FOLDER_ID,
    refresh,
    refreshDocument,
    loadDocument,
    getDocuments: () => documents.slice(),
    getDocumentById: id => documents.find(item => item.id === id) || null,
    getLastError: () => lastError,
    extractDriveId,
    parseFolderListing,
    titleFromFileName,
    fetchById: async (id, fileName, resourceKey = '') => {
      const safeId = extractDriveId(id);
      if (!safeId) throw new Error('Enter a valid Google Drive file ID or file URL.');
      const item = makeDocument(safeId, cleanText(fileName) || (safeId + '.docx'), '', resourceKey);
      await loadDocument(item);
      return item;
    },
    clearSessionCache: () => sessionContentCache.clear(),
    getSessionCacheSize: () => sessionContentCache.size
  };
})();
