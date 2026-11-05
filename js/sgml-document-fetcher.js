/*
 * Google Drive importer adapter. Document bytes are passed directly to the
 * live upstream SGMLFileConverter; its returned content is not rewritten.
 */
(() => {
  'use strict';

  const DRIVE_DOWNLOAD_BASE = 'https://proxy.cors.dev/https://drive.google.com/uc?export=download&id=';

  function getGoogleDriveFileId(input) {
    const value = String(input || '').trim();
    if (!value) return '';
    const patterns = [
      /\/(?:file|document|spreadsheets|presentation|forms)\/d\/([a-zA-Z0-9_-]+)/i,
      /\/d\/([a-zA-Z0-9_-]+)/i,
      /[?&]id=([a-zA-Z0-9_-]+)/i
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match && match[1]) return match[1];
    }
    return /^[a-zA-Z0-9_-]{10,}$/.test(value) ? value : '';
  }

  async function fetchAndConvertById(fileId, fileName, resourceKey = '') {
    const id = getGoogleDriveFileId(fileId);
    if (!id) throw new Error('The selected Google Drive item does not contain a valid file ID.');

    if (!window.SGMLFileConverter || typeof window.SGMLFileConverter.convertResponse !== 'function') {
      throw new Error('The live GitHub SGML converter is unavailable. Wait for the upstream runtime to finish loading.');
    }

    let sourceUrl = DRIVE_DOWNLOAD_BASE + encodeURIComponent(id);
    if (resourceKey) sourceUrl += '&resourcekey=' + encodeURIComponent(resourceKey);

    const response = await fetch(sourceUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error('SGML Drive fetch failed (HTTP ' + response.status + ').');

    // Match the upstream site's processURLCommands() route: same proxy URL,
    // same Response-based converter, and the original converted HTML is kept.
    const converted = await window.SGMLFileConverter.convertResponse(
      response,
      String(fileName || 'Imported document')
    );

    if (!String(converted.content || '').trim()) {
      throw new Error('The upstream SGML converter returned no renderable content.');
    }

    return {
      content: converted.content,
      kind: converted.kind || 'text',
      fileName: converted.fileName || fileName || 'Imported document',
      warnings: converted.warnings || [],
      sourceUrl
    };
  }

  window.SGMLDocumentFetcher = { getGoogleDriveFileId, fetchAndConvertById };
})();
