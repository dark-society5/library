(() => {
  'use strict';

  const app = document.getElementById('sgml-library-app');
  const list = document.getElementById('document-list');
  const search = document.getElementById('document-search');
  const count = document.getElementById('library-count');
  const readerHeading = document.getElementById('reader-heading');
  const readerStatus = document.getElementById('reader-status');
  const welcome = document.getElementById('welcome-state');
  const loading = document.getElementById('loading-state');
  const loadingDetail = document.getElementById('loading-detail');
  const errorBox = document.getElementById('document-error');
  const errorMessage = document.getElementById('document-error-message');
  const renderSurface = document.getElementById('render-surface');
  const openLibraryButton = document.getElementById('open-library');
  const closeLibraryButton = document.getElementById('close-library');
  const backdrop = document.getElementById('drawer-backdrop');
  const refreshButton = document.getElementById('refresh-library');
  const refreshDocumentButton = document.getElementById('refresh-document');
  const searchForm = document.getElementById('document-search-form');
  const retryButton = document.getElementById('retry-document');
  const welcomeButton = document.getElementById('welcome-open-library');
  const toastCard = document.getElementById('sgml-toast-card');
  const toastIcon = document.getElementById('sgml-toast-icon');
  const toastMessage = document.getElementById('sgml-toast-message');

  let selectedId = '';
  let currentItem = null;
  let lastRenderToken = 0;
  let toastTimer = null;
  let searchCursor = null;
  let searchCycleToken = 0;
  let searchInputTimer = null;
  let searchHighlightIdleId = null;
  let lastProcessedQuery = null;
  let searchProcessingPromise = Promise.resolve();
  let searchResultsQuery = '';
  let searchResults = [];

  function escapeHTML(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function setStatus(label, state = 'ready') {
    readerStatus.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    const text = document.createElement('span');
    text.textContent = label;
    readerStatus.append(dot, text);
    readerStatus.dataset.state = state;
  }

  function setToast(message, type = 'info', duration = 3200) {
    if (!toastCard || !toastIcon || !toastMessage) return;
    if (toastTimer) clearTimeout(toastTimer);
    const safeType = ['loading', 'success', 'error', 'info'].includes(type) ? type : 'info';
    toastCard.className = `toast-card visible is-${safeType}`;
    toastCard.setAttribute('role', safeType === 'error' ? 'alert' : 'status');
    toastCard.dataset.toastType = safeType;
    toastIcon.textContent = safeType === 'success' ? '✓' : safeType === 'error' ? '!' : safeType === 'loading' ? '' : 'i';
    toastMessage.textContent = String(message || '');
    if (Number(duration) > 0) toastTimer = setTimeout(hideToast, Number(duration));
  }

  function hideToast() {
    if (!toastCard) return;
    toastCard.classList.remove('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
  }

  function setDrawer(open, options = {}) {
    const isOpen = Boolean(open);
    app.classList.toggle('drawer-open', isOpen);
    openLibraryButton.setAttribute('aria-expanded', String(isOpen));
    backdrop.setAttribute('aria-hidden', String(!isOpen));
    if (isOpen) closeLibraryButton.focus({ preventScroll: true });
    else if (options.restoreFocus !== false && window.matchMedia('(max-width: 760px)').matches) {
      openLibraryButton.focus({ preventScroll: true });
    }
  }

  function showView(view) {
    welcome.hidden = view !== 'welcome';
    loading.hidden = view !== 'loading';
    errorBox.hidden = view !== 'error';
    renderSurface.hidden = view !== 'render';
  }

  function waitForUiPaint() {
    // Yield long enough for the reader/loading state to paint, then invoke the
    // upstream DOM renderer. An idle callback would only delay this work; it
    // cannot move the synchronous DOM renderer off the main thread.
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function documentIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.75h7l4 4V20a.75.75 0 0 1-.75.75h-10.5A.75.75 0 0 1 6 20V4.5a.75.75 0 0 1 .75-.75Z"></path><path d="M14 4v4h4M9 13h6M9 16.5h6"></path></svg>';
  }

  function normalizedQuery(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  function countOccurrences(haystack, needle) {
    if (!haystack || !needle) return 0;
    let count = 0;
    let offset = 0;
    while ((offset = haystack.indexOf(needle, offset)) !== -1) {
      count += 1;
      offset += Math.max(needle.length, 1);
    }
    return count;
  }

  function setCachedSearchResults(query, results) {
    searchResultsQuery = query;
    searchResults = Array.isArray(results) ? results : null;
  }

  async function getSearchTargets(query) {
    const library = window.SGMLDriveLibrary;
    const docs = library ? library.getDocuments() : [];
    if (window.SGMLSearchIndexer && typeof window.SGMLSearchIndexer.search === 'function') {
      return window.SGMLSearchIndexer.search(query, docs.map(item => ({
        id: item.id, title: item.title, content: item.loaded ? item.content : ''
      })));
    }
    return docs.map(item => {
      const titleMatches = item.title.toLocaleLowerCase().includes(query);
      const occurrenceCount = countOccurrences(item.searchText || '', query);
      if (occurrenceCount) return { id: item.id, occurrenceCount, titleOnly: false };
      if (titleMatches) return { id: item.id, occurrenceCount: 0, titleOnly: true };
      return null;
    }).filter(Boolean);
  }

  function clearSearchHighlights(root = document.getElementById('sgml-output')) {
    // Prefer the browser's CSS Custom Highlight API: it paints ranges without
    // rewriting the rendered SGML DOM. Remove both app-owned highlight layers.
    if (window.CSS && window.CSS.highlights) {
      window.CSS.highlights.delete('sgml-search-hit');
      window.CSS.highlights.delete('sgml-search-current');
    }
    if (!root) return;
    const selection = window.getSelection && window.getSelection();
    if (selection && selection.rangeCount && root.contains(selection.anchorNode)) {
      selection.removeAllRanges();
    }
    root.querySelectorAll('mark.sgml-search-hit').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
      parent.normalize();
    });
  }

  // Highlight each rendered occurrence and use the browser's native
  // Selection/Range API for the active result, so the first hit is selected
  // and the reader scrolls to it. Modern browsers use CSS Custom Highlights
  // to avoid rewriting the upstream renderer's DOM.
  function applySearchHighlights(query, requestedIndex = 0) {
    const root = document.getElementById('sgml-output');
    clearSearchHighlights(root);
    if (!root || !query) return { count: 0, activeIndex: -1 };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.length) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (parent && parent.closest('script, style, noscript, template, textarea, input, select, button')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    if (!textNodes.length) return { count: 0, activeIndex: -1 };

    // Flatten visible text while retaining a character-to-node map. This lets
    // a phrase match even when SGML formatting split it across inline tags.
    let flatText = '';
    const startMap = [];
    const endMap = [];
    textNodes.forEach((node, nodeIndex) => {
      const value = node.nodeValue;
      for (let offset = 0; offset < value.length;) {
        const character = String.fromCodePoint(value.codePointAt(offset));
        const endOffset = offset + character.length;
        const startPoint = { nodeIndex, offset };
        const endPoint = { nodeIndex, offset: endOffset };
        if (/\s/.test(character)) {
          if (flatText.endsWith(' ')) {
            endMap[endMap.length - 1] = endPoint;
          } else {
            flatText += ' ';
            startMap.push(startPoint);
            endMap.push(endPoint);
          }
        } else {
          const lowered = character.toLocaleLowerCase();
          for (let index = 0; index < lowered.length; index += 1) {
            flatText += lowered[index];
            startMap.push(startPoint);
            endMap.push(endPoint);
          }
        }
        offset = endOffset;
      }
    });

    const hits = [];
    let searchOffset = 0;
    let found;
    while ((found = flatText.indexOf(query, searchOffset)) !== -1) {
      const firstPoint = startMap[found];
      const lastPoint = endMap[found + query.length - 1];
      if (firstPoint && lastPoint) {
        hits.push({
          startNode: firstPoint.nodeIndex,
          endNode: lastPoint.nodeIndex,
          startOffset: firstPoint.offset,
          endOffset: lastPoint.offset,
          parts: []
        });
      }
      searchOffset = found + Math.max(query.length, 1);
    }
    if (!hits.length) return { count: 0, activeIndex: -1 };

    // Modern browsers can highlight Range objects directly. This avoids
    // inserting hundreds of <mark> nodes into the upstream-rendered DOM.
    if (window.CSS && window.CSS.highlights && typeof window.Highlight === 'function') {
      const ranges = hits.map(hit => {
        const startNode = textNodes[hit.startNode];
        const endNode = textNodes[hit.endNode];
        if (!startNode || !endNode) return null;
        try {
          const range = document.createRange();
          range.setStart(startNode, hit.startOffset);
          range.setEnd(endNode, hit.endOffset);
          return range;
        } catch (_) { return null; }
      }).filter(Boolean);
      if (!ranges.length) return { count: 0, activeIndex: -1 };
      const activeIndex = ((requestedIndex % ranges.length) + ranges.length) % ranges.length;
      window.CSS.highlights.set('sgml-search-hit', new window.Highlight(...ranges));
      window.CSS.highlights.set('sgml-search-current', new window.Highlight(ranges[activeIndex]));
      const selection = window.getSelection && window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(ranges[activeIndex].cloneRange());
      }
      const anchor = ranges[activeIndex].startContainer;
      const anchorElement = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
      if (anchorElement && typeof anchorElement.scrollIntoView === 'function') {
        anchorElement.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      }
      setStatus(`${activeIndex + 1} of ${ranges.length} matches`, 'ready');
      return { count: ranges.length, activeIndex };
    }

    // Legacy fallback for browsers without CSS Custom Highlight support.
    const segmentsByNode = textNodes.map(() => []);
    hits.forEach((hit, hitIndex) => {
      for (let nodeIndex = hit.startNode; nodeIndex <= hit.endNode; nodeIndex += 1) {
        const startOffset = nodeIndex === hit.startNode ? hit.startOffset : 0;
        const endOffset = nodeIndex === hit.endNode ? hit.endOffset : textNodes[nodeIndex].nodeValue.length;
        if (endOffset > startOffset) segmentsByNode[nodeIndex].push({ startOffset, endOffset, hitIndex });
      }
    });

    segmentsByNode.forEach((segments, nodeIndex) => {
      if (!segments.length) return;
      const node = textNodes[nodeIndex];
      if (!node.parentNode) return;
      segments.sort((a, b) => a.startOffset - b.startOffset);
      const original = node.nodeValue;
      const fragment = document.createDocumentFragment();
      let previous = 0;
      segments.forEach(segment => {
        const startOffset = Math.max(segment.startOffset, previous);
        if (segment.endOffset <= startOffset) return;
        if (startOffset > previous) fragment.append(document.createTextNode(original.slice(previous, startOffset)));
        const mark = document.createElement('mark');
        mark.className = 'sgml-search-hit';
        mark.dataset.searchMatch = String(segment.hitIndex);
        mark.textContent = original.slice(startOffset, segment.endOffset);
        hits[segment.hitIndex].parts.push(mark);
        fragment.append(mark);
        previous = segment.endOffset;
      });
      if (previous < original.length) fragment.append(document.createTextNode(original.slice(previous)));
      node.parentNode.replaceChild(fragment, node);
    });

    const validHits = hits.filter(hit => hit.parts.length);
    if (!validHits.length) return { count: 0, activeIndex: -1 };
    const activeIndex = ((requestedIndex % validHits.length) + validHits.length) % validHits.length;
    validHits.forEach((hit, index) => {
      hit.parts.forEach(mark => mark.classList.toggle('is-current', index === activeIndex));
    });

    const activeParts = validHits[activeIndex].parts;
    const selection = window.getSelection && window.getSelection();
    if (selection && activeParts.length) {
      const firstText = activeParts[0].firstChild;
      const lastText = activeParts[activeParts.length - 1].firstChild;
      if (firstText && lastText) {
        const range = document.createRange();
        range.setStart(firstText, 0);
        range.setEnd(lastText, lastText.length);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      activeParts[0].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
    setStatus(`${activeIndex + 1} of ${validHits.length} matches`, 'ready');
    return { count: validHits.length, activeIndex };
  }

  function updateSearchCursor(query, itemId, activeIndex, matchCount) {
    searchCursor = {
      query,
      documentId: itemId,
      matchIndex: activeIndex,
      matchCount
    };
  }

  function cancelScheduledSearchHighlight() {
    if (searchHighlightIdleId === null) return;
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(searchHighlightIdleId);
    else clearTimeout(searchHighlightIdleId);
    searchHighlightIdleId = null;
  }

  function scheduleSearchHighlight(query, matchIndex, cycleToken) {
    cancelScheduledSearchHighlight();
    const run = () => {
      searchHighlightIdleId = null;
      if (cycleToken !== searchCycleToken || query !== normalizedQuery(search.value)) return;
      const result = applySearchHighlights(query, matchIndex);
      if (result.count && currentItem) updateSearchCursor(query, currentItem.id, result.activeIndex, result.count);
    };
    if (typeof window.requestIdleCallback === 'function') {
      searchHighlightIdleId = window.requestIdleCallback(run, { timeout: 180 });
    } else {
      searchHighlightIdleId = window.setTimeout(run, 60);
    }
  }

  async function showSearchTarget(target, targetIndex, matchIndex, query, cycleToken) {
    if (!target || cycleToken !== searchCycleToken) return;
    const library = window.SGMLDriveLibrary;
    const item = library && library.getDocumentById(target.id);
    if (!item) return;

    // Prime the cursor before an asynchronous document load. This prevents a
    // fast Enter/Go press from skipping the first result while the reader loads.
    updateSearchCursor(query, item.id, matchIndex, target.occurrenceCount || 0);

    if (selectedId === item.id && !renderSurface.hidden && item.loaded) {
      const result = applySearchHighlights(query, matchIndex);
      updateSearchCursor(query, item.id, result.activeIndex, result.count);
      renderList();
      return;
    }

    await selectDocument(item.id, {
      fromSearch: true,
      searchQuery: query,
      matchIndex,
      targetIndex
    });
  }

  async function processSearchInput(cycleToken) {
    if (cycleToken !== searchCycleToken) return;
    const query = normalizedQuery(search.value);
    lastProcessedQuery = query;
    searchCursor = null;
    clearSearchHighlights();
    setCachedSearchResults(query, query ? null : []);
    renderList();

    if (!query) {
      if (currentItem && !renderSurface.hidden) setStatus('Rendered', 'ready');
      return;
    }

    const targets = await getSearchTargets(query);
    if (cycleToken !== searchCycleToken || query !== normalizedQuery(search.value)) return;
    setCachedSearchResults(query, targets);
    renderList();

    if (!targets.length) {
      setStatus('No matches', 'ready');
      return;
    }

    // Typing only queries the background index and highlights the current
    // document during an idle slot. It never fetches or renders another file.
    const currentTarget = targets.find(target => target.id === selectedId);
    if (currentTarget && currentTarget.occurrenceCount > 0 && currentItem &&
        currentItem.loaded && !renderSurface.hidden) {
      updateSearchCursor(query, currentItem.id, 0, currentTarget.occurrenceCount);
      scheduleSearchHighlight(query, 0, cycleToken);
      return;
    }

    setStatus(`${targets.length} matching document${targets.length === 1 ? '' : 's'} · press Enter or Go`, 'ready');
  }

  function handleSearchInput() {
    if (searchInputTimer !== null) clearTimeout(searchInputTimer);
    cancelScheduledSearchHighlight();
    const query = normalizedQuery(search.value);
    setCachedSearchResults(query, query ? null : []);
    renderList();
    const cycleToken = ++searchCycleToken;
    searchInputTimer = window.setTimeout(() => {
      searchInputTimer = null;
      searchProcessingPromise = processSearchInput(cycleToken);
    }, 130);
  }

  async function flushPendingSearchInput() {
    const query = normalizedQuery(search.value);
    if (searchInputTimer !== null) {
      clearTimeout(searchInputTimer);
      searchInputTimer = null;
      searchProcessingPromise = processSearchInput(searchCycleToken);
    } else if (lastProcessedQuery !== query) {
      cancelScheduledSearchHighlight();
      searchProcessingPromise = processSearchInput(++searchCycleToken);
    }
    await searchProcessingPromise;

    // If Enter/Go arrives before the idle highlight runs, select the first hit
    // now. advanceSearch() can then move to the following occurrence reliably.
    if (searchHighlightIdleId !== null && searchCursor &&
        searchCursor.query === query && searchCursor.documentId === selectedId) {
      cancelScheduledSearchHighlight();
      const first = applySearchHighlights(query, 0);
      updateSearchCursor(query, selectedId, first.activeIndex, first.count);
    }
  }

  async function advanceSearch() {
    const query = normalizedQuery(search.value);
    if (!query) return;
    const cycleToken = searchCycleToken;
    // flushPendingSearchInput() normally populated this cache. Reuse it so an
    // Enter/Go action does not immediately repeat the same Worker query.
    const targets = searchResultsQuery === query && Array.isArray(searchResults)
      ? searchResults
      : await getSearchTargets(query);
    if (cycleToken !== searchCycleToken || query !== normalizedQuery(search.value)) return;
    setCachedSearchResults(query, targets);
    renderList();
    if (!targets.length) {
      setStatus('No matches', 'ready');
      return;
    }

    let targetIndex = 0;
    let matchIndex = 0;
    const selectedTargetIndex = targets.findIndex(target => target.id === selectedId);
    const cursorIsCurrent = searchCursor && searchCursor.query === query && searchCursor.documentId === selectedId;

    if (cursorIsCurrent && selectedTargetIndex >= 0) {
      const knownCount = Number(searchCursor.matchCount) || 0;
      if (knownCount > 0 && searchCursor.matchIndex + 1 < knownCount) {
        targetIndex = selectedTargetIndex;
        matchIndex = searchCursor.matchIndex + 1;
      } else {
        targetIndex = (selectedTargetIndex + 1) % targets.length;
      }
    }

    cancelScheduledSearchHighlight();
    const navigationToken = ++searchCycleToken;
    const nextTarget = targets[targetIndex];
    updateSearchCursor(query, nextTarget.id, matchIndex, nextTarget.occurrenceCount || 0);
    showSearchTarget(nextTarget, targetIndex, matchIndex, query, navigationToken);
  }

  function renderList() {
    const library = window.SGMLDriveLibrary;
    const docs = library ? library.getDocuments() : [];
    const query = normalizedQuery(search.value);
    const resultsReady = searchResultsQuery === query && Array.isArray(searchResults);
    const resultMap = resultsReady ? new Map(searchResults.map(item => [item.id, item])) : null;
    const filtered = docs.filter(item => {
      if (!query) return true;
      if (resultMap) return resultMap.has(item.id);
      // While the Worker is searching, show immediate title matches only.
      return item.title.toLocaleLowerCase().includes(query);
    });
    count.textContent = query
      ? (resultsReady ? `${filtered.length} of ${docs.length} documents` : 'Searching loaded contents…')
      : `${docs.length} document${docs.length === 1 ? '' : 's'}`;

    if (!docs.length) {
      const detail = library && library.getLastError();
      list.innerHTML = `<div class="list-empty">${escapeHTML(detail || 'No supported documents were found in this Drive folder.')}</div>`;
      if (detail) count.textContent = 'Folder unavailable';
      else count.textContent = 'No documents found';
      return;
    }
    if (!filtered.length) {
      list.innerHTML = resultsReady
        ? '<div class="list-empty">No documents match your search.</div>'
        : '<div class="list-empty">Searching loaded document contents…</div>';
      return;
    }

    list.innerHTML = filtered.map(item => {
      const active = item.id === selectedId;
      const titleMatches = !query || item.title.toLocaleLowerCase().includes(query);
      const match = resultMap && resultMap.get(item.id);
      const contentOnlyMatch = query && !titleMatches && match && match.occurrenceCount > 0;
      const status = contentOnlyMatch ? 'Content match' : item.error ? 'Could not load' : item.loading ? 'Loading…' : item.loaded ? 'Ready' : item.extension.toUpperCase();
      return `<button class="document-item" type="button" role="listitem" data-document-id="${escapeHTML(item.id)}" aria-current="${active ? 'page' : 'false'}">
        <span class="document-item-icon">${documentIcon()}</span>
        <span class="document-item-copy"><span class="document-item-title">${escapeHTML(item.title)}</span><span class="document-item-meta">${escapeHTML(status)}</span></span>
      </button>`;
    }).join('');
  }

  async function selectDocument(id, options = {}) {
    const library = window.SGMLDriveLibrary;
    const item = library && library.getDocumentById(id);
    if (!item) return;
    selectedId = item.id;
    currentItem = item;
    renderList();
    readerHeading.textContent = item.title;
    refreshDocumentButton.hidden = false;
    refreshDocumentButton.disabled = true;
    refreshDocumentButton.classList.add('is-loading');
    clearSearchHighlights();
    showView('loading');
    loadingDetail.textContent = `Downloading ${item.extension.toUpperCase() || 'document'} by Drive ID ${item.id}…`;
    setStatus('Loading', 'loading');
    if (!options.fromSearch) setDrawer(false);

    const token = ++lastRenderToken;
    try {
      if (options.forceRefresh) await library.refreshDocument(item.id);
      else await library.loadDocument(item);
      if (token !== lastRenderToken) return;
      if (!item.content.trim()) throw new Error('This document contains no renderable content.');
      loadingDetail.textContent = 'Rendering SGML…';
      showView('loading');
      // Let the browser paint the loading state before the upstream renderer
      // performs its synchronous DOM work.
      await waitForUiPaint();
      if (token !== lastRenderToken) return;
      showView('render');
      window.renderSGML(item.content);
      const activeQuery = normalizedQuery(search.value);
      if (activeQuery) {
        const targetsNow = await getSearchTargets(activeQuery);
        if (token !== lastRenderToken) return;
        if (activeQuery !== normalizedQuery(search.value)) {
          setStatus('Rendered', 'ready');
        } else {
          setCachedSearchResults(activeQuery, targetsNow);
          if (targetsNow.some(target => target.id === item.id)) {
            const requestedIndex = options.searchQuery === activeQuery ? (options.matchIndex || 0) : 0;
            const result = applySearchHighlights(activeQuery, requestedIndex);
            updateSearchCursor(activeQuery, item.id, result.activeIndex, result.count);
            setStatus(result.count ? `${result.activeIndex + 1} of ${result.count} matches` : 'Rendered', 'ready');
          } else {
            clearSearchHighlights();
            setStatus(targetsNow.length ? 'Search updated' : 'No matches', 'ready');
          }
        }
      } else {
        setStatus('Rendered', 'ready');
      }
      renderList();
    } catch (error) {
      if (token !== lastRenderToken) return;
      showView('error');
      errorMessage.textContent = String(error && error.message || error);
      setStatus('Load failed', 'error');
      renderList();
      setToast(`Could not load ${item.title}`, 'error', 4500);
    } finally {
      if (token === lastRenderToken) {
        refreshDocumentButton.disabled = false;
        refreshDocumentButton.classList.remove('is-loading');
      }
    }
  }

  async function refreshLibrary() {
    refreshButton.classList.add('is-loading');
    refreshButton.disabled = true;
    count.textContent = 'Reading Drive folder…';
    list.innerHTML = '<div class="list-placeholder"><span class="spinner"></span><span>Reading the folder…</span></div>';
    try {
      await window.SGMLDriveLibrary.refresh();
      renderList();
      setToast('Drive folder refreshed', 'success', 2400);
    } catch (error) {
      renderList();
      count.textContent = 'Could not connect';
      setToast(String(error && error.message || error), 'error', 7000);
    } finally {
      refreshButton.classList.remove('is-loading');
      refreshButton.disabled = false;
    }
  }

  function setSearchBehavior() {
    search.addEventListener('input', handleSearchInput);
    searchForm.addEventListener('submit', event => {
      event.preventDefault();
      // Restore focus synchronously on Go activation (not after Worker work),
      // so mobile keyboards stay available and repeated Enter presses work.
      search.focus({ preventScroll: true });
      (async () => {
        try {
          await flushPendingSearchInput();
          await advanceSearch();
        } catch (error) {
          console.error('[SGML Search] Could not advance to the next match:', error);
          setStatus('Search navigation failed', 'error');
        } finally {
          requestAnimationFrame(() => search.focus({ preventScroll: true }));
        }
      })();
    });
    document.addEventListener('keydown', event => {
      const tag = event.target && event.target.tagName;
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        event.preventDefault();
        search.focus();
      }
      if (event.key === 'Escape' && app.classList.contains('drawer-open')) setDrawer(false);
    });
    list.addEventListener('click', event => {
      const button = event.target.closest('[data-document-id]');
      if (button) selectDocument(button.dataset.documentId);
    });
  }

  function setUpstreamFailure(error) {
    const message = String(error && error.message || error);
    showView('error');
    errorMessage.textContent = 'The upstream SGML resources could not be loaded. Check the GitHub repository visibility and your internet connection. ' + message;
    readerHeading.textContent = 'SGML resources unavailable';
    setStatus('Offline', 'error');
    count.textContent = 'Renderer unavailable';
    list.innerHTML = '<div class="list-empty">The SGML renderer could not be initialized.</div>';
  }

  async function start() {
    openLibraryButton.addEventListener('click', () => setDrawer(true));
    closeLibraryButton.addEventListener('click', () => setDrawer(false));
    backdrop.addEventListener('click', () => setDrawer(false));
    welcomeButton.addEventListener('click', () => setDrawer(true));
    refreshButton.addEventListener('click', refreshLibrary);
    refreshDocumentButton.addEventListener('click', () => {
      if (currentItem) selectDocument(currentItem.id, { forceRefresh: true });
    });
    retryButton.addEventListener('click', () => currentItem && selectDocument(currentItem.id));
    const dismissToastButton = document.getElementById('sgml-toast-dismiss');
    if (dismissToastButton) dismissToastButton.addEventListener('click', hideToast);
    refreshDocumentButton.hidden = true;
    setSearchBehavior();
    document.addEventListener('sgml-library:loaded', () => {
      const library = window.SGMLDriveLibrary;
      const docs = library ? library.getDocuments() : [];
      const query = normalizedQuery(search.value);
      setCachedSearchResults(query, query ? null : []);
      renderList();
      if (query) {
        const cycleToken = ++searchCycleToken;
        searchProcessingPromise = processSearchInput(cycleToken);
      }

      // Automatically open the first sorted document after the folder loads.
      // Keep the current selection on refresh unless that file was removed.
      if (docs.length && (!selectedId || !library.getDocumentById(selectedId))) {
        selectDocument(docs[0].id);
      }
    });
    document.addEventListener('sgml-library:item-updated', renderList);

    try {
      setStatus('Connecting', 'loading');
      await window.SGMLRuntime.ready;
      setStatus('Connected', 'ready');
      await refreshLibrary();
    } catch (error) {
      console.error('SGML viewer startup failed:', error);
      setUpstreamFailure(error);
    }
  }

  document.addEventListener('DOMContentLoaded', start, { once: true });
})();
