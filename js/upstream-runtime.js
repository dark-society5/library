/*
 * Runtime guard for the static upstream imports in index.html.
 * The renderer and converter are imported by ordinary <script src="..."> tags;
 * this file only verifies the globals and exposes their exact source URLs.
 */
(() => {
  'use strict';

  const REPOSITORY = 'cardhollow/sgml';
  const BRANCH = 'main';
  const BASE = `https://cdn.jsdelivr.net/gh/${REPOSITORY}@${BRANCH}`;
  const expectedScripts = [
    'tex-chtml.js',
    'marked.js',
    'js/editor-language.js',
    'js/app-state.js',
    'js/sgml-renderer.js',
    'js/file-converter.js'
  ];

  function getResourceElement(path) {
    return document.querySelector(`[data-sgml-upstream="${path}"]`);
  }

  function resourceURL(path) {
    const element = getResourceElement(path);
    if (!element) return `${BASE}/${path}`;
    return element.href || element.src || `${BASE}/${path}`;
  }

  const stylesheet = resourceURL('style.css');
  const scripts = expectedScripts.map(resourceURL);
  const resources = {
    repository: REPOSITORY,
    branch: BRANCH,
    delivery: 'static script src imports from jsDelivr GitHub mirror',
    stylesheet,
    scripts,
    renderer: resourceURL('js/sgml-renderer.js'),
    converter: resourceURL('js/file-converter.js'),
    markdown: resourceURL('marked.js'),
    mathJax: resourceURL('tex-chtml.js')
  };

  const ready = Promise.resolve().then(() => {
    const missing = [];
    if (typeof window.renderSGML !== 'function') missing.push('renderSGML()');
    if (!window.SGMLFileConverter || typeof window.SGMLFileConverter.convertResponse !== 'function') {
      missing.push('SGMLFileConverter.convertResponse()');
    }
    if (!window.marked || typeof window.marked.parse !== 'function') missing.push('marked.parse()');
    if (!window.MathJax) missing.push('MathJax');

    if (missing.length) {
      throw new Error(
        `The upstream SGML scripts did not initialize: ${missing.join(', ')}. ` +
        'Check the network tab for failed GitHub mirror script requests.'
      );
    }

    console.info('[SGML Library] Static upstream imports ready:', resources);
    return resources;
  });

  // Attach a handler immediately to avoid an unhandled-rejection warning before
  // app.js awaits the same promise during DOMContentLoaded.
  ready.catch(() => {});

  window.SGMLRuntime = {
    repository: REPOSITORY,
    branch: BRANCH,
    base: BASE,
    ready,
    resources,
    getLoadedResources() {
      return [stylesheet, ...scripts];
    }
  };
})();
