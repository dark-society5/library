/* Background content indexing and document matching for the SGML library. */
'use strict';

const indexedDocuments = new Map();

function decodeEntities(text) {
  const named = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™'
  };
  return String(text).replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] && entity[1].toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : match; }
      catch (_) { return '\uFFFD'; }
    }
    return Object.prototype.hasOwnProperty.call(named, entity.toLowerCase())
      ? named[entity.toLowerCase()] : match;
  });
}

function toSearchText(html) {
  let text = String(html || '');
  text = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|button|textarea|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article|tr|blockquote|pre|ul|ol|table)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text).replace(/[\u00a0\s]+/g, ' ').trim().toLocaleLowerCase();
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

function searchDocuments(query, documents) {
  const needle = String(query || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!needle) return [];
  const matches = [];
  for (const document of Array.isArray(documents) ? documents : []) {
    const id = String(document && document.id || '');
    const titleMatches = String(document && document.title || '').toLocaleLowerCase().includes(needle);
    const occurrenceCount = countOccurrences(indexedDocuments.get(id) || '', needle);
    if (occurrenceCount || titleMatches) {
      matches.push({ id, occurrenceCount, titleOnly: occurrenceCount === 0 });
    }
  }
  return matches;
}

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'index') {
    const searchText = toSearchText(data.html);
    indexedDocuments.set(String(data.documentId || ''), searchText);
    // Do not ship the full normalized body back to the UI thread. Keep it in
    // this Worker so large files do not incur a second large structured clone.
    self.postMessage({ id: data.id, indexed: true });
    return;
  }
  if (data.type === 'search') {
    self.postMessage({ id: data.id, results: searchDocuments(data.query, data.documents) });
  }
});
