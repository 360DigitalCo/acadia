(() => {
  'use strict';

  const API = {
    openAlex: 'https://api.openalex.org',
    crossref: 'https://api.crossref.org',
    semantic: 'https://api.semanticscholar.org/graph/v1'
  };
  const STORAGE = {
    library: 'acadia.library.v2',
    history: 'acadia.history.v2',
    alerts: 'acadia.alerts.v2',
    settings: 'acadia.settings.v2'
  };
  const $ = (id) => document.getElementById(id);
  const state = {
    view: 'articles', query: '', page: 1, searchToken: 0, busy: false,
    results: [], allCount: null, canNext: false, activeAdvanced: false,
    advanced: { phrase: '', author: '', publication: '', exclude: '', field: 'all', type: '' },
    filters: { from: '', to: '', sort: 'relevance', type: '', minCitations: 0, openAccess: false, withAbstract: false },
    library: readStore(STORAGE.library, []), history: readStore(STORAGE.history, []),
    alerts: readStore(STORAGE.alerts, []), settings: readStore(STORAGE.settings, {}),
    selected: new Set(), works: new Map(), entities: new Map(), citationWorks: [], previousFocus: null
  };

  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const value = JSON.parse(raw);
      return value == null ? fallback : value;
    } catch (_) { return fallback; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { toast('Browser storage is unavailable. Changes may not persist.'); return false; }
  }
  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function plainText(value) {
    return String(value == null ? '' : value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
  }
  function normalizeDOI(value) {
    return String(value || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
  }
  function normalizeTitle(value) { return plainText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
  function containsAllWords(haystack, needle) {
    const source = normalizeTitle(haystack), terms = normalizeTitle(needle).split(' ').filter(Boolean);
    return !!source && terms.length > 0 && terms.every((term) => source.includes(term));
  }
  function shortId(value) {
    if (!value) return '';
    // OpenAlex endpoints and filters require the entity prefix (W, A, S, I).
    return String(value).split('/').pop();
  }
  function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '—';
    return new Intl.NumberFormat('en-US', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
  }
  function formatYear(value) {
    const year = Number(value);
    return Number.isFinite(year) && year > 1000 ? String(year) : 'Year unknown';
  }
  function safeUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value));
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_) { return ''; }
  }
  function openExternal(value) {
    const url = safeUrl(value);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  function toast(message) {
    const node = document.createElement('div');
    node.className = 'toast'; node.textContent = String(message || 'Done');
    $('toast-region').appendChild(node);
    window.setTimeout(() => node.remove(), 3200);
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(String(text));
      } else {
        const area = document.createElement('textarea');
        area.value = String(text); area.style.position = 'fixed'; area.style.opacity = '0';
        document.body.appendChild(area); area.select();
        const ok = document.execCommand('copy'); area.remove();
        if (!ok) throw new Error('Clipboard unavailable');
      }
      toast('Copied to clipboard.');
    } catch (_) { toast('Could not copy automatically. Select the text and copy it.'); }
  }
  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function setBusy(busy) {
    state.busy = busy;
    const button = document.querySelector('.search-submit');
    if (button) { button.disabled = busy; button.textContent = busy ? 'Searching…' : 'Search'; }
  }
  function setStatus(text) { $('status-line').textContent = text || ''; }
  function setActiveNav() {
    document.querySelectorAll('[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === state.view);
      if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('library-count').textContent = String(state.library.length);
  }
  function syncSearchURL() {
    try {
      const url = new URL(window.location.href);
      if (state.query) url.searchParams.set('q', state.query); else url.searchParams.delete('q');
      if (state.view !== 'articles') url.searchParams.set('view', state.view); else url.searchParams.delete('view');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch (_) { /* embedded contexts may prohibit history changes */ }
  }
  function rememberSearch(query, view) {
    const q = String(query || '').trim();
    if (!q) return;
    const key = `${view || 'articles'}:${q.toLocaleLowerCase()}`;
    state.history = [{ key, query: q, view: view || 'articles', at: Date.now() }, ...state.history.filter((item) => item && item.key !== key)].slice(0, 30);
    writeStore(STORAGE.history, state.history);
    populateRecentSearches();
  }
  function populateRecentSearches() {
    const list = $('recent-searches');
    list.replaceChildren();
    state.history.slice(0, 12).forEach((item) => {
      const option = document.createElement('option'); option.value = item.query; list.appendChild(option);
    });
  }
  function updateIntro() {
    const descriptions = {
      articles: ['Find the work behind the idea.', 'Search across scholarly indexes, inspect citation trails, and keep the papers that matter.'],
      authors: ['Find researchers and follow their work.', 'Explore author output, citation counts, h-index metadata, and institutional affiliations.'],
      journals: ['Explore journals and research sources.', 'Compare indexed publication volume, citations, and source-level metrics.'],
      institutions: ['Discover research institutions.', 'Explore indexed output, citation counts, locations, and institutional records.'],
      library: ['Your research library.', 'Papers you save stay in this browser. Export citations whenever you need them.'],
      alerts: ['Keep track of a research topic.', 'Save queries and run them again when you return. Local alerts do not send email.'],
      history: ['Return to a previous search.', 'Your recent searches are stored locally in this browser.'],
      metrics: ['Your research workspace.', 'A quick view of saved papers, citation counts, and open-access availability.'],
      patents: ['Patent research.', 'Search patent records in established patent indexes alongside scholarly literature.'],
      cases: ['Case-law research.', 'Search legal opinions using public legal indexes and court-specific collections.']
    };
    const pair = descriptions[state.view] || descriptions.articles;
    $('page-title').textContent = pair[0]; $('page-description').textContent = pair[1];
    const noFilters = ['authors', 'journals', 'institutions', 'library', 'alerts', 'history', 'metrics', 'patents', 'cases'].includes(state.view);
    $('filter-panel').hidden = noFilters;
    $('content-column').style.gridColumn = noFilters ? '1 / -1' : 'auto';
    $('advanced-toggle').hidden = state.view !== 'articles';
    $('create-alert').hidden = !['articles', 'authors'].includes(state.view) || !state.query;
    setActiveNav();
  }
  function showLoading(label) {
    $('results-toolbar').hidden = true; $('pagination').hidden = true;
    $('results').innerHTML = `<div class="loading-row"><span class="spinner" aria-hidden="true"></span><span>${escapeHTML(label || 'Searching scholarly indexes…')}</span></div>`;
  }
  function emptyState() {
    $('results-toolbar').hidden = true; $('pagination').hidden = true;
    $('results').innerHTML = `<section class="empty-panel"><div class="eyebrow">ACADIA RESEARCH</div><h2>Research starts with a good question.</h2><p>Search article titles, topics, DOIs, or author names. Results combine several scholarly metadata indexes; full text depends on the publisher or repository.</p><div class="quick-searches"><button type="button" data-quick-query="retrieval augmented generation">Retrieval augmented generation</button><button type="button" data-quick-query="climate adaptation urban heat">Urban heat adaptation</button><button type="button" data-quick-query="CRISPR gene editing review">CRISPR gene editing</button><button type="button" data-quick-query="transformer language models">Transformer language models</button></div></section>`;
  }
  function apiNotice(message, fallbackQuery) {
    const q = encodeURIComponent(fallbackQuery || state.query || '');
    $('results').innerHTML = `<section class="no-results"><h2>Could not load these results</h2><p>${escapeHTML(message || 'The scholarly APIs did not respond.')} Try again, or open a source index directly.</p><div class="external-links"><a href="https://openalex.org/works?search=${q}" target="_blank" rel="noopener noreferrer">Search OpenAlex ↗</a><a href="https://search.crossref.org/?q=${q}" target="_blank" rel="noopener noreferrer">Search Crossref ↗</a><a href="https://www.semanticscholar.org/search?q=${q}" target="_blank" rel="noopener noreferrer">Search Semantic Scholar ↗</a></div><button class="plain-button" data-action="retry-search" type="button">Retry search</button></section>`;
  }
  async function fetchJSON(url, timeoutMs = 14000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { window.clearTimeout(timer); }
  }
  async function resolveOpenAlexAuthor(name) {
    if (!name) return '';
    const url = new URL(`${API.openAlex}/authors`);
    url.searchParams.set('search', name); url.searchParams.set('per_page', '4'); url.searchParams.set('select', 'id,display_name,works_count,cited_by_count');
    const data = await fetchJSON(url.href, 9000);
    const matches = data.results || [];
    const target = normalizeTitle(name);
    const best = matches.find((item) => normalizeTitle(item.display_name) === target) || matches[0];
    return best && best.id ? shortId(best.id, 'A') : '';
  }
  async function resolveOpenAlexSource(name) {
    if (!name) return '';
    const url = new URL(`${API.openAlex}/sources`);
    url.searchParams.set('search', name); url.searchParams.set('per_page', '4'); url.searchParams.set('select', 'id,display_name,works_count,cited_by_count');
    const data = await fetchJSON(url.href, 9000);
    const matches = data.results || [];
    const target = normalizeTitle(name);
    const best = matches.find((item) => normalizeTitle(item.display_name) === target) || matches[0];
    return best && best.id ? shortId(best.id, 'S') : '';
  }
  function getFiltersForOpenAlex(q, authorId, sourceId) {
    const values = [];
    const from = Number(state.filters.from || 0), to = Number(state.filters.to || 0);
    if (from > 1000 && from <= 2100) values.push(`from_publication_date:${from}-01-01`);
    if (to > 1000 && to <= 2100) values.push(`until_publication_date:${to}-12-31`);
    const type = state.advanced.type || state.filters.type;
    if (type) values.push(`type:${type}`);
    if (state.filters.openAccess) values.push('is_oa:true');
    if (authorId) values.push(`authorships.author.id:${authorId}`);
    if (sourceId) values.push(`primary_location.source.id:${sourceId}`);
    if (state.advanced.field === 'title' && q && !/^10\.\d{4,9}\//i.test(q)) values.push(`title.search:${q}`);
    return values;
  }
  function buildSearchQuery() {
    const base = state.query.trim();
    const phrase = state.advanced.phrase.trim();
    return [base, phrase && !base.toLowerCase().includes(phrase.toLowerCase()) ? `"${phrase}"` : ''].filter(Boolean).join(' ').trim();
  }
  function openAlexSelect() {
    return 'id,doi,title,display_name,publication_year,publication_date,type,cited_by_count,authorships,primary_location,open_access,biblio,abstract_inverted_index,referenced_works,related_works,locations,ids,language,keywords,topics';
  }
  async function searchOpenAlex(page) {
    const q = buildSearchQuery();
    let authorId = '', sourceId = '';
    if (state.advanced.author) {
      try { authorId = await resolveOpenAlexAuthor(state.advanced.author); } catch (_) { authorId = ''; }
    }
    if (state.advanced.publication) {
      try { sourceId = await resolveOpenAlexSource(state.advanced.publication); } catch (_) { sourceId = ''; }
    }
    const url = new URL(`${API.openAlex}/works`);
    if (q && state.advanced.field !== 'title') url.searchParams.set('search', q);
    url.searchParams.set('per_page', '25'); url.searchParams.set('page', String(page)); url.searchParams.set('select', openAlexSelect());
    const sort = state.filters.sort === 'recent' ? 'publication_date:desc' : state.filters.sort === 'cited' ? 'cited_by_count:desc' : 'relevance_score:desc';
    url.searchParams.set('sort', sort);
    const filters = getFiltersForOpenAlex(q, authorId, sourceId);
    if (filters.length) url.searchParams.set('filter', filters.join(','));
    return fetchJSON(url.href);
  }
  async function searchCrossref(page) {
    const url = new URL(`${API.crossref}/works`);
    url.searchParams.set('query.bibliographic', buildSearchQuery() || state.query);
    if (state.advanced.author) url.searchParams.set('query.author', state.advanced.author);
    if (state.advanced.publication) url.searchParams.set('query.container-title', state.advanced.publication);
    const from = Number(state.filters.from || 0), to = Number(state.filters.to || 0);
    const filters = [];
    if (from > 1000 && from <= 2100) filters.push(`from-pub-date:${from}-01-01`);
    if (to > 1000 && to <= 2100) filters.push(`until-pub-date:${to}-12-31`);
    if (filters.length) url.searchParams.set('filter', filters.join(','));
    url.searchParams.set('rows', '15'); url.searchParams.set('offset', String((page - 1) * 15));
    url.searchParams.set('select', 'DOI,title,author,published,published-print,published-online,container-title,publisher,volume,issue,page,type,URL,is-referenced-by-count,abstract,link,license,issued,created');
    return fetchJSON(url.href);
  }
  async function searchSemanticScholar(page) {
    const url = new URL(`${API.semantic}/paper/search`);
    url.searchParams.set('query', buildSearchQuery() || state.query);
    url.searchParams.set('limit', '12'); url.searchParams.set('offset', String((page - 1) * 12));
    url.searchParams.set('fields', 'title,authors,year,venue,citationCount,abstract,externalIds,openAccessPdf,url,isOpenAccess,publicationDate,publicationTypes,journal');
    return fetchJSON(url.href, 11000);
  }
  function abstractFromInvertedIndex(index) {
    if (!index || typeof index !== 'object') return '';
    const words = [];
    Object.entries(index).forEach(([word, positions]) => {
      if (Array.isArray(positions)) positions.forEach((position) => {
        if (Number.isInteger(position) && position >= 0) words.push([position, word]);
      });
    });
    words.sort((a, b) => a[0] - b[0]);
    const unique = [];
    let previous = -1;
    words.forEach(([position, word]) => {
      if (position !== previous) unique[position] = word;
      previous = position;
    });
    return unique.filter(Boolean).join(' ').replace(/\s+([,.!?;:])/g, '$1');
  }
  function firstValue(value) { return Array.isArray(value) ? value[0] : value; }
  function normalizeOpenAlex(item, index) {
    const location = item.primary_location || {};
    const source = location.source || {};
    const authors = (item.authorships || []).map((entry) => ({
      name: entry && entry.author && entry.author.display_name || '',
      id: entry && entry.author && entry.author.id || '',
      orcid: entry && entry.author && entry.author.orcid || ''
    })).filter((author) => author.name);
    const locations = (item.locations || []).map((entry) => ({
      label: entry && entry.source && entry.source.display_name || 'Repository copy',
      url: safeUrl(entry && entry.landing_page_url),
      pdf: safeUrl(entry && entry.pdf_url),
      sourceType: entry && entry.source && entry.source.type || ''
    })).filter((entry) => entry.url || entry.pdf);
    const oaLoc = item.open_access || {};
    const doi = normalizeDOI(item.doi || item.ids && item.ids.doi);
    const openAccessLocation = locations.find((entry) => entry.pdf) || locations.find((entry) => entry.url);
    const title = plainText(item.title || item.display_name || 'Untitled work');
    return {
      key: '', id: item.id || '', openAlexId: item.id ? shortId(item.id, 'W') : '', doi, title,
      year: Number(item.publication_year) || null, date: item.publication_date || '', type: canonicalType(item.type || 'work'),
      authors, authorNames: authors.map((author) => author.name), source: source.display_name || '',
      sourceType: source.type || '', publisher: source.host_organization_name || '',
      sourceUrl: safeUrl(source.host_organization_lineage && source.host_organization_lineage[0]),
      url: safeUrl(location.landing_page_url) || (doi ? `https://doi.org/${doi}` : ''),
      oaUrl: safeUrl(oaLoc.oa_url) || (openAccessLocation && openAccessLocation.url) || '',
      pdfUrl: safeUrl(oaLoc.best_oa_location && oaLoc.best_oa_location.pdf_url) || (openAccessLocation && openAccessLocation.pdf) || '',
      openAccess: !!oaLoc.is_oa, abstract: abstractFromInvertedIndex(item.abstract_inverted_index),
      citations: Number(item.cited_by_count) || 0, references: Array.isArray(item.referenced_works) ? item.referenced_works : [],
      related: Array.isArray(item.related_works) ? item.related_works : [], locations, biblio: item.biblio || {},
      language: item.language || '', sourceApis: ['OpenAlex'], rank: index, raw: item
    };
  }
  function crossrefDate(item) {
    const candidates = [item.published, item['published-print'], item['published-online'], item.issued, item.created];
    for (const candidate of candidates) {
      const parts = candidate && candidate['date-parts'] && candidate['date-parts'][0];
      if (parts && parts.length) return { year: Number(parts[0]) || null, date: parts.map((n) => String(n).padStart(2, '0')).join('-') };
    }
    return { year: null, date: '' };
  }
  function normalizeCrossref(item, index) {
    const date = crossrefDate(item);
    const authors = (item.author || []).map((author) => ({ name: [author.given, author.family].filter(Boolean).join(' ').trim(), id: '', orcid: author.ORCID || '' })).filter((author) => author.name);
    const doi = normalizeDOI(item.DOI);
    const title = plainText(firstValue(item.title) || 'Untitled work');
    const abstract = plainText(item.abstract || '');
    const links = item.link || [];
    const pdf = links.find((link) => /pdf/i.test(link['content-type'] || '') || /pdf/i.test(link.URL || ''));
    return {
      key: '', id: doi ? `https://doi.org/${doi}` : '', openAlexId: '', doi, title, year: date.year, date: date.date,
      type: canonicalType(item.type || 'work'), authors, authorNames: authors.map((author) => author.name),
      source: plainText(firstValue(item['container-title']) || ''), sourceType: 'crossref metadata', publisher: item.publisher || '',
      url: safeUrl(item.URL) || (doi ? `https://doi.org/${doi}` : ''), oaUrl: '', pdfUrl: safeUrl(pdf && pdf.URL),
      openAccess: !!(item.license && item.license.some((license) => /creativecommons\.org\/licenses|open-access/i.test(`${license.URL || ''} ${license['content-version'] || ''}`))), abstract, citations: Number(item['is-referenced-by-count']) || 0,
      references: [], related: [], locations: [], biblio: { volume: item.volume || '', issue: item.issue || '', first_page: item.page || '' },
      language: '', sourceApis: ['Crossref'], rank: 100 + index, raw: item
    };
  }
  function normalizeSemantic(item, index) {
    const external = item.externalIds || {};
    const doi = normalizeDOI(external.DOI);
    const authors = (item.authors || []).map((author) => ({ name: author.name || '', id: '', semanticId: author.authorId || '' })).filter((author) => author.name);
    const oaPdf = item.openAccessPdf && item.openAccessPdf.url || '';
    const title = plainText(item.title || 'Untitled work');
    return {
      key: '', id: item.paperId ? `https://www.semanticscholar.org/paper/${item.paperId}` : '', openAlexId: '', semanticId: item.paperId || '',
      doi, title, year: Number(item.year) || (item.publicationDate ? Number(String(item.publicationDate).slice(0, 4)) : null), date: item.publicationDate || '',
      type: canonicalType(item.publicationTypes && item.publicationTypes[0] || 'work'), authors,
      authorNames: authors.map((author) => author.name), source: plainText(item.venue || item.journal && item.journal.name || ''),
      sourceType: 'semantic scholar metadata', publisher: '', url: safeUrl(item.url) || safeUrl(item.journal && item.journal.url) || (doi ? `https://doi.org/${doi}` : ''),
      oaUrl: safeUrl(oaPdf), pdfUrl: safeUrl(oaPdf), openAccess: !!(item.isOpenAccess || oaPdf), abstract: plainText(item.abstract || ''),
      citations: Number(item.citationCount) || 0, references: [], related: [], locations: oaPdf ? [{ label: 'Open-access PDF', url: safeUrl(oaPdf), pdf: safeUrl(oaPdf), sourceType: 'repository' }] : [],
      biblio: {}, language: '', sourceApis: ['Semantic Scholar'], rank: 50 + index, raw: item
    };
  }
  function mergeWorks(groups) {
    const merged = [], doiIndex = new Map(), titleIndex = new Map();
    groups.forEach((work) => {
      if (!work || !work.title) return;
      const doi = normalizeDOI(work.doi);
      const title = normalizeTitle(work.title);
      const existingIndex = (doi && doiIndex.has(doi)) ? doiIndex.get(doi) : (title && titleIndex.has(title) ? titleIndex.get(title) : undefined);
      if (existingIndex !== undefined) {
        const existing = merged[existingIndex];
        existing.rank = Math.min(existing.rank, work.rank);
        existing.sourceApis = [...new Set([...(existing.sourceApis || []), ...(work.sourceApis || [])])];
        if (!existing.doi && doi) { existing.doi = doi; existing.url = existing.url || `https://doi.org/${doi}`; }
        if ((!existing.abstract || existing.abstract.length < 90) && work.abstract) existing.abstract = work.abstract;
        if (!existing.source && work.source) existing.source = work.source;
        if (!existing.publisher && work.publisher) existing.publisher = work.publisher;
        if (!existing.url && work.url) existing.url = work.url;
        if (!existing.pdfUrl && work.pdfUrl) existing.pdfUrl = work.pdfUrl;
        if (!existing.oaUrl && work.oaUrl) existing.oaUrl = work.oaUrl;
        existing.openAccess = existing.openAccess || work.openAccess;
        if (!existing.citations || existing.citations < work.citations) existing.citations = work.citations;
        if ((!existing.year || existing.year < 1000) && work.year) existing.year = work.year;
        if ((!existing.authorNames || !existing.authorNames.length) && work.authorNames) { existing.authorNames = work.authorNames; existing.authors = work.authors; }
        if (!existing.authors || !existing.authors.some((author) => author.id) && work.authors && work.authors.some((author) => author.id)) existing.authors = work.authors;
        if (!existing.openAlexId && work.openAlexId) { existing.openAlexId = work.openAlexId; existing.id = work.id; existing.references = work.references || []; existing.related = work.related || []; existing.locations = work.locations || []; existing.biblio = work.biblio || {}; existing.sourceType = work.sourceType || existing.sourceType; }
        if (doi) doiIndex.set(doi, existingIndex);
        if (title) titleIndex.set(title, existingIndex);
      } else {
        const pos = merged.length;
        work.key = doi ? `doi:${doi}` : work.openAlexId ? `oa:${work.openAlexId}` : work.semanticId ? `s2:${work.semanticId}` : `title:${title}`;
        merged.push(work);
        if (doi) doiIndex.set(doi, pos);
        if (title) titleIndex.set(title, pos);
      }
    });
    merged.forEach((work) => {
      if (!work.key) work.key = work.doi ? `doi:${work.doi}` : work.openAlexId ? `oa:${work.openAlexId}` : `title:${normalizeTitle(work.title)}`;
      state.works.set(work.key, work);
    });
    return merged;
  }
  function sourceContext(work) {
    const host = (() => { try { return new URL(work.url || work.oaUrl || work.pdfUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; } })();
    const sourceType = String(work.sourceType || '').toLowerCase();
    const title = String(work.source || '').toLowerCase();
    const url = String(work.url || work.oaUrl || '').toLowerCase();
    const isPreprint = /preprint/.test(work.type) || /arxiv\.org|biorxiv\.org|medrxiv\.org|ssrn\.com|osf\.io|preprints\./.test(host) || /preprint/.test(title);
    if (isPreprint) return { score: 73, label: 'Preprint / working paper', kind: 'preprint' };
    if (/repository/.test(sourceType) || /arxiv\.org|zenodo\.org|europepmc\.org|pubmedcentral\.nih\.gov|core\.ac\.uk|institutional-repository/.test(host)) return { score: 82, label: 'Research repository', kind: 'repository' };
    const established = /nature\.com|science\.org|sciencedirect\.com|springer\.com|link\.springer\.com|wiley\.com|tandfonline\.com|academic\.oup\.com|cambridge\.org|journals\.plos\.org|ieeexplore\.ieee\.org|acm\.org|aps\.org|cell\.com|frontiersin\.org|journals\.sagepub\.com|jamanetwork\.com|nejm\.org|bmj\.com|thelancet\.com|annualreviews\.org|oup\.com/.test(host) || /journal/.test(sourceType);
    if (established) return { score: 91, label: 'Journal / publisher metadata', kind: 'journal' };
    if (/\.edu$|\.ac\.[a-z]{2,}$|\.gov$|\.gov\.[a-z]{2,}$/.test(host)) return { score: 84, label: 'Academic / public institution', kind: 'institution' };
    if (/conference/.test(work.type) || /conference/.test(title)) return { score: 76, label: 'Conference publication', kind: 'conference' };
    if (host || work.source) return { score: 64, label: 'Indexed source', kind: 'other' };
    return { score: 52, label: 'Source details limited', kind: 'unknown' };
  }
  function canonicalType(value) {
    const type = String(value || 'work').toLowerCase().replace(/[_\s]+/g, '-');
    if (/^(journal-article|article)$/.test(type)) return 'article';
    if (/review/.test(type)) return 'review';
    if (/posted-content|preprint|working-paper/.test(type)) return 'preprint';
    if (/proceedings-article|conference-paper/.test(type)) return 'conference-paper';
    if (/book-chapter/.test(type)) return 'book-chapter';
    if (/^(book|monograph|edited-book)$/.test(type)) return 'book';
    if (/dissertation|thesis/.test(type)) return 'dissertation';
    if (/dataset/.test(type)) return 'dataset';
    return type;
  }
  function prettyType(type) {
    const value = canonicalType(type).replace(/-/g, ' ').replace(/_/g, ' ');
    return value.replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  function authorButtons(work) {
    const authors = (work.authors || []).filter((author) => author && author.name).slice(0, 8);
    if (!authors.length) return '<span>Author details unavailable</span>';
    return authors.map((author) => {
      const id = author.id && /^https:\/\/openalex\.org\/A\w+$/i.test(author.id) ? author.id : '';
      return id ? `<button type="button" data-action="author-profile" data-id="${escapeHTML(id)}">${escapeHTML(author.name)}</button>` : escapeHTML(author.name);
    }).join(', ') + ((work.authors || []).length > 8 ? ', et al.' : '');
  }
  function renderWork(work, options = {}) {
    const signal = sourceContext(work);
    const host = (() => { try { return new URL(work.url || work.oaUrl || work.pdfUrl).hostname.replace(/^www\./, ''); } catch (_) { return work.source || ''; } })();
    const link = safeUrl(work.url) || (work.doi ? `https://doi.org/${work.doi}` : '');
    const saved = state.library.some((item) => item.key === work.key);
    const checked = state.selected.has(work.key);
    const abstract = work.abstract || '';
    const abstractId = `abstract-${simpleHash(work.key)}`;
    const meta = [work.source || work.publisher || host, formatYear(work.year), prettyType(work.type)].filter(Boolean).join(' · ');
    const badges = [
      work.openAccess ? '<span class="result-badge oa">Open access</span>' : '',
      /preprint/i.test(work.type) ? '<span class="result-badge preprint">Preprint</span>' : '',
      work.doi ? `<span class="result-badge">DOI: ${escapeHTML(work.doi)}</span>` : '',
      work.sourceApis && work.sourceApis.length > 1 ? `<span class="result-badge">Combined metadata · ${escapeHTML(work.sourceApis.join(' + '))}</span>` : ''
    ].filter(Boolean).join('');
    const snippet = abstract ? escapeHTML(abstract.length > 460 ? `${abstract.slice(0, 457).trim()}…` : abstract) : `${work.source ? `Published in ${escapeHTML(work.source)}. ` : ''}${work.citations ? `Cited by ${formatNumber(work.citations)} works. ` : ''}Abstract not available in the indexed metadata.`;
    return `<article class="article-result" data-result-key="${escapeHTML(work.key)}">
      <div class="result-topline"><span class="result-meta">${escapeHTML(meta)}</span><span class="source-signal" title="Estimated from source type and domain; not a paper-level fact check"><span class="signal-bar"><span style="width:${signal.score}%"></span></span>${signal.score}/100 · ${escapeHTML(signal.label)}</span></div>
      <h2 class="result-title"><input class="result-select" type="checkbox" aria-label="Select ${escapeHTML(work.title)} for export" data-select-work="${escapeHTML(work.key)}" ${checked ? 'checked' : ''}><a href="${escapeHTML(link || '#')}" ${link ? 'target="_blank" rel="noopener noreferrer"' : 'data-action="work-details" data-work="' + escapeHTML(work.key) + '"'}>${escapeHTML(work.title)}</a></h2>
      <p class="result-authors">${authorButtons(work)}</p>
      <p class="result-snippet" id="${abstractId}">${snippet}</p>
      ${badges ? `<div class="result-badges">${badges}</div>` : ''}
      <div class="result-actions">
        <button type="button" class="result-action primary" data-action="work-details" data-work="${escapeHTML(work.key)}">Details</button>
        <button type="button" class="result-action ${saved ? 'saved' : ''}" data-action="save-work" data-work="${escapeHTML(work.key)}">${saved ? '✓ Saved' : 'Save'}</button>
        <button type="button" class="result-action" data-action="cite-work" data-work="${escapeHTML(work.key)}">Cite</button>
        <button type="button" class="result-action result-abstract-toggle" data-action="toggle-abstract" data-work="${escapeHTML(work.key)}" data-target="${abstractId}" aria-expanded="false">${abstract ? 'Show abstract' : 'Metadata'}</button>
        ${work.openAlexId ? `<button type="button" class="result-action" data-action="cited-by" data-work="${escapeHTML(work.key)}">Cited by ${formatNumber(work.citations)}</button>` : work.citations ? `<span class="result-action">Cited by ${formatNumber(work.citations)}</span>` : ''}
        ${work.openAlexId && work.related && work.related.length ? `<button type="button" class="result-action" data-action="related" data-work="${escapeHTML(work.key)}">Related articles</button>` : ''}
        ${work.locations && work.locations.length > 1 ? `<button type="button" class="result-action" data-action="versions" data-work="${escapeHTML(work.key)}">All versions (${work.locations.length})</button>` : ''}
        ${work.pdfUrl ? `<a class="result-action" href="${escapeHTML(work.pdfUrl)}" target="_blank" rel="noopener noreferrer">PDF ↗</a>` : work.oaUrl ? `<a class="result-action" href="${escapeHTML(work.oaUrl)}" target="_blank" rel="noopener noreferrer">Open access ↗</a>` : ''}
      </div>
    </article>`;
  }
  function simpleHash(text) {
    let hash = 0; for (let i = 0; i < String(text).length; i++) hash = ((hash << 5) - hash + String(text).charCodeAt(i)) | 0;
    return `x${Math.abs(hash)}`;
  }
  function filterLocalWorks(works) {
    const from = Number(state.filters.from || 0), to = Number(state.filters.to || 0);
    const type = state.advanced.type || state.filters.type;
    const exclude = state.advanced.exclude.split(',').map((term) => term.trim().toLowerCase()).filter(Boolean);
    return works.filter((work) => {
      if (from && (!work.year || work.year < from)) return false;
      if (to && (!work.year || work.year > to)) return false;
      if (type && String(work.type).toLowerCase() !== type.toLowerCase()) return false;
      if (Number(work.citations || 0) < Number(state.filters.minCitations || 0)) return false;
      if (state.filters.openAccess && !work.openAccess && !work.oaUrl && !work.pdfUrl) return false;
      if (state.filters.withAbstract && !work.abstract) return false;
      const corpus = `${work.title} ${work.abstract} ${work.source} ${work.authorNames.join(' ')}`.toLowerCase();
      if (exclude.some((term) => corpus.includes(term))) return false;
      if (state.advanced.field === 'title' && state.query) {
        const title = normalizeTitle(work.title);
        const query = normalizeTitle(state.query);
        if (query && !title.includes(query) && !query.split(' ').every((word) => title.includes(word))) return false;
      }
      if (state.advanced.phrase) {
        const phrase = state.advanced.phrase.toLowerCase();
        if (!`${work.title} ${work.abstract}`.toLowerCase().includes(phrase)) return false;
      }
      if (state.advanced.author && !work.authorNames.some((name) => containsAllWords(name, state.advanced.author))) return false;
      if (state.advanced.publication && !containsAllWords(work.source, state.advanced.publication)) return false;
      return true;
    });
  }
  function sortWorks(works) {
    const sorted = [...works];
    if (state.filters.sort === 'recent') sorted.sort((a, b) => (b.year || 0) - (a.year || 0) || a.rank - b.rank);
    else if (state.filters.sort === 'cited') sorted.sort((a, b) => (b.citations || 0) - (a.citations || 0) || a.rank - b.rank);
    else sorted.sort((a, b) => a.rank - b.rank);
    return sorted;
  }
  function registerWorks(works) {
    works.forEach((work) => {
      if (!work.key) work.key = work.doi ? `doi:${work.doi}` : work.openAlexId ? `oa:${work.openAlexId}` : work.semanticId ? `s2:${work.semanticId}` : `title:${normalizeTitle(work.title)}`;
      if (!work.authorNames) work.authorNames = (work.authors || []).map((author) => author.name).filter(Boolean);
      state.works.set(work.key, work);
    });
  }
  function showResultsToolbar(title, subheading) {
    $('results-toolbar').hidden = false; $('results-heading').textContent = title;
    $('results-subheading').textContent = subheading || '';
    $('export-selected').disabled = state.selected.size === 0;
    $('selected-count').textContent = String(state.selected.size);
    $('create-alert').hidden = !state.query || !['articles', 'authors'].includes(state.view);
  }
  function renderWorks(works, { title = 'Search results', subheading = '', pagination = false } = {}) {
    state.results = works; registerWorks(works); state.selected = new Set([...state.selected].filter((key) => works.some((work) => work.key === key)));
    showResultsToolbar(title, subheading);
    if (!works.length) {
      $('results').innerHTML = `<div class="no-results"><h2>No matching results</h2><p>No records matched this search and its current filters. Try removing a filter, broadening the query, or searching by DOI.</p><button class="plain-button" type="button" data-action="clear-filters">Clear filters</button></div>`;
    } else {
      $('results').innerHTML = works.map((work) => renderWork(work)).join('');
    }
    $('pagination').hidden = !pagination;
    $('previous-page').disabled = state.page <= 1;
    $('next-page').disabled = !state.canNext;
    $('page-indicator').textContent = `Page ${state.page}`;
    $('selected-count').textContent = String(state.selected.size);
    $('export-selected').disabled = state.selected.size === 0;
  }
  async function runArticleSearch(page = 1) {
    const q = state.query.trim();
    if (!q) { emptyState(); setStatus(''); return; }
    const token = ++state.searchToken;
    state.page = page; state.selected.clear(); setBusy(true); setStatus('Searching OpenAlex, Crossref, and Semantic Scholar…'); showLoading('Searching scholarly indexes…');
    syncSearchURL();
    const results = await Promise.allSettled([searchOpenAlex(page), searchCrossref(page), searchSemanticScholar(page)]);
    if (token !== state.searchToken) return;
    setBusy(false);
    const [oaResult, crossrefResult, semanticResult] = results;
    const raw = []; let apiCount = 0; let openAlexCount = 0; let okApis = 0; let lastError = '';
    if (oaResult.status === 'fulfilled') {
      const data = oaResult.value; okApis++; openAlexCount = Number(data.meta && data.meta.count) || 0;
      (data.results || []).forEach((item, i) => raw.push(normalizeOpenAlex(item, i)));
    } else lastError = oaResult.reason && oaResult.reason.message || 'OpenAlex unavailable';
    if (semanticResult.status === 'fulfilled') {
      okApis++;
      (semanticResult.value.data || []).forEach((item, i) => raw.push(normalizeSemantic(item, i)));
    }
    if (crossrefResult.status === 'fulfilled') {
      okApis++;
      (((crossrefResult.value || {}).message || {}).items || []).forEach((item, i) => raw.push(normalizeCrossref(item, i)));
    }
    if (!okApis) {
      setStatus(''); apiNotice(`The three public metadata indexes could not be reached (${lastError}). Check your connection and retry.`, q); return;
    }
    const merged = mergeWorks(raw);
    let filtered = sortWorks(filterLocalWorks(merged));
    // Source-specific author/publication fields are applied in OpenAlex and Crossref queries.
    const sourceNames = [oaResult, semanticResult, crossrefResult].filter((item) => item.status === 'fulfilled').length;
    state.allCount = openAlexCount;
    state.canNext = page < 20 && (openAlexCount > page * 25 || raw.length >= 25 || (crossrefResult.status === 'fulfilled' && (((crossrefResult.value || {}).message || {}).items || []).length >= 15));
    rememberSearch(q, 'articles');
    const countText = openAlexCount ? `OpenAlex indexes about ${formatNumber(openAlexCount)} matching works` : `${filtered.length} records on this page`;
    setStatus('');
    renderWorks(filtered, { title: `Results for “${q}”`, subheading: `${filtered.length} unique records shown · ${sourceNames} of 3 indexes responded · ${countText}`, pagination: true });
    $('create-alert').hidden = false;
  }
  function openExternalSearchView(kind) {
    const q = encodeURIComponent(state.query || '');
    $('results-toolbar').hidden = true; $('pagination').hidden = true; $('filter-panel').hidden = true;
    const patents = kind === 'patents';
    $('results').innerHTML = patents ? `
      <section class="external-search-panel"><div class="eyebrow">PATENT INDEXES</div><h2>Search patent records</h2><p>Patent metadata has different coverage and licensing from scholarly article indexes. These links run your query against established patent indexes directly, rather than presenting external records as Acadia-hosted results.</p><div class="external-links"><a href="https://patents.google.com/?q=${q}" target="_blank" rel="noopener noreferrer">Google Patents ↗</a><a href="https://ppubs.uspto.gov/pubwebapp/" target="_blank" rel="noopener noreferrer">USPTO Patent Public Search ↗</a><a href="https://worldwide.espacenet.com/" target="_blank" rel="noopener noreferrer">Espacenet ↗</a></div><p class="helper-text">Search term: ${escapeHTML(state.query || 'Enter a query in the search box above')}</p></section>` : `
      <section class="external-search-panel"><div class="eyebrow">CASE LAW & COURT OPINIONS</div><h2>Search case law</h2><p>Use legal indexes to search court opinions by case name, citation, topic, or full text. Legal holdings are jurisdiction-specific; confirm the court and date before relying on a case.</p><div class="external-links"><a href="https://www.courtlistener.com/?q=${q}&type=o" target="_blank" rel="noopener noreferrer">CourtListener opinions ↗</a><a href="https://scholar.google.com/scholar?hl=en&as_sdt=4,60&q=${q}" target="_blank" rel="noopener noreferrer">Google Scholar ↗</a></div><p class="helper-text">Search term: ${escapeHTML(state.query || 'Enter a query in the search box above')}</p></section>`;
    setStatus('');
  }
  function getCurrentFilters() {
    state.filters.from = $('year-from').value.trim(); state.filters.to = $('year-to').value.trim();
    state.filters.sort = $('sort-mode').value; state.filters.type = $('type-filter').value;
    state.filters.minCitations = Number($('min-citations').value || 0); state.filters.openAccess = $('open-access').checked;
    state.filters.withAbstract = $('with-abstract').checked;
    state.advanced.type = $('advanced-type').value || '';
  }
  function loadFilters() {
    $('year-from').value = state.filters.from; $('year-to').value = state.filters.to;
    $('sort-mode').value = state.filters.sort; $('type-filter').value = state.filters.type;
    $('min-citations').value = String(state.filters.minCitations || 0); $('open-access').checked = state.filters.openAccess;
    $('with-abstract').checked = state.filters.withAbstract; $('advanced-type').value = state.advanced.type || '';
  }
  async function runCurrentSearch(page = 1) {
    if (state.view === 'articles') return runArticleSearch(page);
    if (state.view === 'authors') return runAuthorSearch(page);
    if (state.view === 'journals') return runEntitySearch('sources', page);
    if (state.view === 'institutions') return runEntitySearch('institutions', page);
    if (state.view === 'patents' || state.view === 'cases') return openExternalSearchView(state.view);
    if (state.view === 'library') return renderLibrary();
    if (state.view === 'history') return renderHistory();
    if (state.view === 'alerts') return renderAlerts();
    if (state.view === 'metrics') return renderMetrics();
    return emptyState();
  }
  async function runAuthorSearch(page = state.page) {
    state.page = page;
    const q = state.query.trim();
    if (!q) { emptyState(); setStatus(''); return; }
    const token = ++state.searchToken; setBusy(true); setStatus('Searching author records…'); showLoading('Searching author metadata…'); syncSearchURL();
    try {
      const url = new URL(`${API.openAlex}/authors`); url.searchParams.set('search', q); url.searchParams.set('per_page', '25');
      url.searchParams.set('sort', 'cited_by_count:desc'); url.searchParams.set('select', 'id,display_name,orcid,works_count,cited_by_count,summary_stats,last_known_institutions,affiliations,x_concepts');
      const data = await fetchJSON(url.href);
      if (token !== state.searchToken) return;
      const items = data.results || []; state.results = items; state.canNext = Number(data.meta && data.meta.count || 0) > page * 25; state.entities.clear(); items.forEach((item) => state.entities.set(item.id, { ...item, kind: 'author' }));
      rememberSearch(q, 'authors'); setBusy(false); setStatus('');
      $('results-toolbar').hidden = false; $('results-heading').textContent = `Authors matching “${q}”`;
      $('results-subheading').textContent = `${formatNumber(data.meta && data.meta.count || items.length)} indexed author records`;
      $('results').innerHTML = items.length ? items.map(renderAuthor).join('') : '<div class="no-results"><h2>No authors found</h2><p>Try a surname, ORCID, or a distinctive part of the researcher’s name.</p></div>';
      $('pagination').hidden = Number(data.meta && data.meta.count || 0) <= 25; $('previous-page').disabled = page <= 1; $('next-page').disabled = !state.canNext; $('page-indicator').textContent = `Page ${page}`;
    } catch (error) {
      if (token !== state.searchToken) return; setBusy(false); setStatus(''); apiNotice('The author index did not respond. Try again in a moment.', q);
    }
  }
  function renderAuthor(author) {
    const id = author.id || '';
    const affiliation = (author.last_known_institutions || []).map((item) => item.display_name).filter(Boolean).join(', ');
    const stats = author.summary_stats || {};
    return `<article class="author-result"><h2 class="author-name"><button type="button" class="history-query" data-action="author-profile" data-id="${escapeHTML(id)}">${escapeHTML(author.display_name || 'Unknown author')}</button></h2>
      <p class="author-subline">${escapeHTML(affiliation || 'Affiliation not listed')}${author.orcid ? ` · ORCID: ${escapeHTML(author.orcid.replace('https://orcid.org/', ''))}` : ''}</p>
      <div class="metric-row"><span><strong>${formatNumber(author.works_count)}</strong> works</span><span><strong>${formatNumber(author.cited_by_count)}</strong> citations</span><span><strong>${formatNumber(stats.h_index)}</strong> h-index</span><span><strong>${formatNumber(stats.i10_index)}</strong> i10-index</span></div>
      <div class="author-actions"><button type="button" class="result-action" data-action="author-profile" data-id="${escapeHTML(id)}">Open profile</button><button type="button" class="result-action" data-action="search-author" data-id="${escapeHTML(id)}">Search this author's papers</button></div></article>`;
  }
  async function runEntitySearch(kind, page = state.page) {
    state.page = page;
    const q = state.query.trim();
    if (!q) { emptyState(); setStatus(''); return; }
    const token = ++state.searchToken; setBusy(true); setStatus(`Searching ${kind === 'sources' ? 'journal and source' : 'institution'} records…`); showLoading('Searching institutional metadata…'); syncSearchURL();
    try {
      const url = new URL(`${API.openAlex}/${kind}`); url.searchParams.set('search', q); url.searchParams.set('per_page', '25'); url.searchParams.set('page', String(page));
      url.searchParams.set('sort', kind === 'sources' ? 'cited_by_count:desc' : 'works_count:desc');
      url.searchParams.set('select', kind === 'sources' ? 'id,display_name,type,issn_l,works_count,cited_by_count,summary_stats,host_organization_name,homepage_url,country_code,is_in_doaj' : 'id,display_name,type,country_code,geo,works_count,cited_by_count,homepage_url,ror,ids');
      const data = await fetchJSON(url.href);
      if (token !== state.searchToken) return;
      const items = data.results || []; state.canNext = Number(data.meta && data.meta.count || 0) > page * 25; state.entities.clear(); items.forEach((item) => state.entities.set(item.id, { ...item, kind }));
      rememberSearch(q, kind === 'sources' ? 'journals' : 'institutions'); setBusy(false); setStatus('');
      $('results-toolbar').hidden = false; $('results-heading').textContent = `${kind === 'sources' ? 'Journals and sources' : 'Institutions'} matching “${q}”`;
      $('results-subheading').textContent = `${formatNumber(data.meta && data.meta.count || items.length)} indexed records`;
      $('results').innerHTML = items.length ? items.map((item) => renderEntity(item, kind)).join('') : `<div class="no-results"><h2>No ${kind === 'sources' ? 'journals or sources' : 'institutions'} found</h2><p>Try a shorter query, acronym, or full organization name.</p></div>`;
      $('pagination').hidden = Number(data.meta && data.meta.count || 0) <= 25; $('previous-page').disabled = page <= 1; $('next-page').disabled = !state.canNext; $('page-indicator').textContent = `Page ${page}`;
    } catch (_) {
      if (token !== state.searchToken) return; setBusy(false); setStatus(''); apiNotice('The metadata index did not respond.', q);
    }
  }
  function renderEntity(item, kind) {
    const stats = item.summary_stats || {};
    const institution = (item.last_known_institutions || []).map((x) => x.display_name).join(', ');
    const loc = item.country_code || institution || item.host_organization_name || '';
    const typeLabel = kind === 'sources' ? (item.type || 'Publication source') : (item.type || 'Institution');
    return `<article class="entity-result"><h2 class="entity-name"><button type="button" class="history-query" data-action="entity-profile" data-id="${escapeHTML(item.id)}">${escapeHTML(item.display_name || 'Unknown record')}</button></h2><p class="entity-subline">${escapeHTML([typeLabel, loc, item.issn_l ? `ISSN ${item.issn_l}` : ''].filter(Boolean).join(' · '))}</p>
      <div class="metric-row"><span><strong>${formatNumber(item.works_count)}</strong> works</span><span><strong>${formatNumber(item.cited_by_count)}</strong> citations</span>${stats.h_index != null ? `<span><strong>${formatNumber(stats.h_index)}</strong> h-index</span>` : ''}${item.is_in_doaj ? '<span class="chip">Listed in DOAJ</span>' : ''}</div>
      <div class="result-actions"><button type="button" class="result-action" data-action="entity-profile" data-id="${escapeHTML(item.id)}">View profile</button><button type="button" class="result-action" data-action="search-entity-works" data-id="${escapeHTML(item.id)}" data-name="${escapeHTML(item.display_name || '')}" data-kind="${escapeHTML(kind)}">Search associated works</button>${safeUrl(item.homepage_url) ? `<a class="result-action" href="${escapeHTML(safeUrl(item.homepage_url))}" target="_blank" rel="noopener noreferrer">Website ↗</a>` : ''}</div></article>`;
  }
  function openModal(title, content, kicker = 'ACADIA') {
    state.previousFocus = document.activeElement;
    $('modal-kicker').textContent = kicker; $('modal-title').textContent = title; $('modal-content').innerHTML = content;
    $('modal-root').hidden = false;
    window.setTimeout(() => $('modal-close').focus(), 0);
  }
  function closeModal() {
    $('modal-root').hidden = true; $('modal-content').replaceChildren();
    if (state.previousFocus && typeof state.previousFocus.focus === 'function') state.previousFocus.focus();
  }
  function formatAbstract(work) {
    return work.abstract ? escapeHTML(work.abstract) : 'No abstract was included in the indexed metadata. Open the publisher or repository record to check for an abstract or full text.';
  }
  function openWorkDetails(work) {
    if (!work) return;
    const signal = sourceContext(work);
    const doiLink = work.doi ? `<a href="https://doi.org/${escapeHTML(work.doi)}" target="_blank" rel="noopener noreferrer">https://doi.org/${escapeHTML(work.doi)}</a>` : '';
    const locations = (work.locations || []).filter((location) => location.url || location.pdf).map((location) => `<li><a href="${escapeHTML(location.pdf || location.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(location.label || 'Available version')} ↗</a>${location.pdf ? ' · PDF' : ''}</li>`).join('');
    const authors = (work.authorNames || []).join(', ') || 'Author details unavailable';
    const isSaved = state.library.some((item) => item.key === work.key);
    const content = `<div class="detail-meta">${escapeHTML([work.source, formatYear(work.year), prettyType(work.type)].filter(Boolean).join(' · '))}</div>
      <p>${escapeHTML(authors)}</p><div class="metric-row"><span><strong>${formatNumber(work.citations)}</strong> citations</span><span><strong>${work.openAccess || work.oaUrl || work.pdfUrl ? 'Yes' : 'Unknown'}</strong> open access</span><span><strong>${escapeHTML(signal.score)}/100</strong> source context</span><span><strong>${escapeHTML((work.sourceApis || []).join(', '))}</strong> metadata</span></div>
      <div class="modal-actions"><button type="button" data-action="save-work" data-work="${escapeHTML(work.key)}">${isSaved ? 'Saved in library ✓' : 'Save to library'}</button><button type="button" data-action="cite-work" data-work="${escapeHTML(work.key)}">Cite / export</button>${work.openAlexId ? `<button type="button" data-action="cited-by" data-work="${escapeHTML(work.key)}">View citing works</button>` : ''}${work.openAlexId && work.references && work.references.length ? `<button type="button" data-action="references" data-work="${escapeHTML(work.key)}">References (${work.references.length})</button>` : ''}${work.openAlexId && work.related && work.related.length ? `<button type="button" data-action="related" data-work="${escapeHTML(work.key)}">Related works</button>` : ''}</div>
      <h3>Abstract</h3><p class="abstract-full">${formatAbstract(work)}</p>
      <h3>Identifiers & access</h3><p>${doiLink ? `DOI: ${doiLink}` : 'DOI not available'}${work.openAccess ? ' · Open-access metadata is available' : ''}</p>${work.pdfUrl ? `<p><a href="${escapeHTML(work.pdfUrl)}" target="_blank" rel="noopener noreferrer">Open PDF ↗</a></p>` : ''}${work.oaUrl ? `<p><a href="${escapeHTML(work.oaUrl)}" target="_blank" rel="noopener noreferrer">Open-access full text ↗</a></p>` : ''}${work.url ? `<p><a href="${escapeHTML(work.url)}" target="_blank" rel="noopener noreferrer">Open publisher / source record ↗</a></p>` : ''}
      ${locations ? `<h3>Versions and repository copies</h3><ul>${locations}</ul>` : ''}
      <p class="subtle">Source context is a heuristic based on available domain and publication-type metadata. It is not a peer-review certification, editorial-quality rating, or fact-check.</p>`;
    openModal(work.title || 'Work details', content, 'SCHOLARLY RECORD');
  }
  function citationAuthors(work, style) {
    const names = work.authorNames && work.authorNames.length ? work.authorNames : ['Unknown author'];
    if (style === 'bibtex' || style === 'ris') return names.join(' and ');
    return names.length > 7 ? `${names.slice(0, 6).join(', ')}, et al.` : names.join(', ');
  }
  function bibtexEscape(text) { return String(text || '').replace(/[{}]/g, '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/&/g, '\\&').trim(); }
  function citationKey(work) {
    const family = (work.authorNames && work.authorNames[0] || 'unknown').split(/\s+/).pop().replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'work';
    return `${family}${work.year || 'nd'}${(work.title || 'paper').split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'paper'}`;
  }
  function formatCitation(work, style) {
    const authors = work.authorNames && work.authorNames.length ? work.authorNames : ['Unknown author'];
    const authorLine = citationAuthors(work, style);
    const year = work.year || 'n.d.'; const journal = work.source || ''; const doi = work.doi ? `https://doi.org/${work.doi}` : safeUrl(work.url) || '';
    const title = work.title || 'Untitled work'; const volume = work.biblio && work.biblio.volume || ''; const issue = work.biblio && work.biblio.issue || ''; const pages = work.biblio && (work.biblio.first_page || work.biblio.pages) || '';
    if (style === 'bibtex') {
      const type = /book/.test(work.type) ? 'book' : /conference/.test(work.type) ? 'inproceedings' : 'article';
      const fields = [`  title = {${bibtexEscape(title)}}`, `  author = {${bibtexEscape(authors.join(' and '))}}`, `  year = {${year}}`];
      if (journal) fields.push(`  journal = {${bibtexEscape(journal)}}`);
      if (volume) fields.push(`  volume = {${bibtexEscape(volume)}}`); if (issue) fields.push(`  number = {${bibtexEscape(issue)}}`);
      if (pages) fields.push(`  pages = {${bibtexEscape(pages)}}`); if (work.doi) fields.push(`  doi = {${bibtexEscape(work.doi)}}`); if (doi) fields.push(`  url = {${bibtexEscape(doi)}}`);
      return `@${type}{${citationKey(work)},\n${fields.join(',\n')}\n}`;
    }
    if (style === 'ris') return ['TY  - JOUR', ...authors.map((name) => `AU  - ${name}`), `TI  - ${title}`, journal ? `JO  - ${journal}` : '', `PY  - ${year}`, work.doi ? `DO  - ${work.doi}` : '', doi ? `UR  - ${doi}` : '', volume ? `VL  - ${volume}` : '', issue ? `IS  - ${issue}` : '', pages ? `SP  - ${pages}` : '', 'ER  - '].filter(Boolean).join('\n');
    if (style === 'mla') return `${authorLine}. “${title}.”${journal ? ` ${journal},` : ''} ${year}.${work.doi ? ` https://doi.org/${work.doi}.` : doi ? ` ${doi}` : ''}`;
    if (style === 'chicago') return `${authorLine}. “${title}.”${journal ? ` ${journal}` : ''}${volume ? ` ${volume}` : ''}${issue ? `, no. ${issue}` : ''} (${year}).${work.doi ? ` https://doi.org/${work.doi}.` : doi ? ` ${doi}` : ''}`;
    if (style === 'ieee') return `${authors.map((name) => name).join(', ')}, “${title},”${journal ? ` ${journal},` : ''}${volume ? ` vol. ${volume},` : ''}${issue ? ` no. ${issue},` : ''} ${year}.${work.doi ? ` doi: ${work.doi}.` : doi ? ` ${doi}` : ''}`;
    return `${authorLine} (${year}). ${title}.${journal ? ` ${journal}.` : ''}${volume ? ` ${volume}` : ''}${issue ? `(${issue})` : ''}${pages ? `, ${pages}` : ''}.${work.doi ? ` https://doi.org/${work.doi}` : doi ? ` ${doi}` : ''}`;
  }
  function citationText(works, style) {
    if (style === 'bibtex' || style === 'ris') return works.map((work) => formatCitation(work, style)).join('\n\n');
    return works.map((work, index) => `${works.length > 1 ? `${index + 1}. ` : ''}${formatCitation(work, style)}`).join('\n\n');
  }
  function openCitationModal(works) {
    const list = (Array.isArray(works) ? works : [works]).filter(Boolean);
    if (!list.length) return;
    state.citationWorks = list;
    const initial = list.length > 1 ? 'bibtex' : 'apa';
    const content = `<p>${list.length === 1 ? 'Choose a style, then copy the formatted citation or download an export file.' : `Exporting ${list.length} selected records. Choose a reference style or a machine-readable format.`}</p><div class="citation-controls"><label for="citation-style" class="field-label" style="margin:0">Citation format</label><select id="citation-style"><option value="apa" ${initial === 'apa' ? 'selected' : ''}>APA 7</option><option value="mla">MLA</option><option value="chicago">Chicago</option><option value="ieee">IEEE</option><option value="bibtex" ${initial === 'bibtex' ? 'selected' : ''}>BibTeX</option><option value="ris">RIS / reference manager</option></select><button class="plain-button" type="button" data-action="copy-citation">Copy</button><button class="plain-button" type="button" data-action="download-citation">Download export</button></div><textarea id="citation-output" class="citation-output" aria-label="Formatted citation"></textarea><p class="helper-text">Citation formatting is generated from available metadata. Verify capitalization, author order, issue, page, and publisher details against the original record before submitting.</p>`;
    openModal(list.length === 1 ? 'Cite this work' : `Export ${list.length} works`, content, 'CITATION TOOLS');
    $('citation-output').value = citationText(list, initial);
  }
  function activeCitationStyle() { return $('citation-style') ? $('citation-style').value : 'apa'; }
  function updateCitationOutput() { if ($('citation-output')) $('citation-output').value = citationText(state.citationWorks, activeCitationStyle()); }
  async function batchOpenAlexWorks(ids) {
    const cleaned = (ids || []).map((id) => shortId(id, 'W')).filter((id) => /^W\w+$/i.test(id)).slice(0, 20);
    if (!cleaned.length) return [];
    const url = new URL(`${API.openAlex}/works`);
    url.searchParams.set('filter', `openalex_id:${cleaned.join('|')}`); url.searchParams.set('per_page', String(cleaned.length)); url.searchParams.set('select', openAlexSelect());
    try {
      const data = await fetchJSON(url.href); return (data.results || []).map((work, i) => normalizeOpenAlex(work, i));
    } catch (_) {
      const output = [];
      for (const id of cleaned.slice(0, 8)) {
        try { const item = await fetchJSON(`${API.openAlex}/works/${encodeURIComponent(id)}?select=${encodeURIComponent(openAlexSelect())}`, 8500); output.push(normalizeOpenAlex(item, output.length)); } catch (_) { /* some referenced records are no longer indexed */ }
      }
      return output;
    }
  }
  async function openWorkCollection(work, kind) {
    if (!work || !work.openAlexId) { toast('This index did not provide citation-link identifiers for this record.'); return; }
    const titles = { 'cited-by': 'Works citing this paper', references: 'References in this paper', related: 'Related works' };
    openModal(titles[kind] || 'Related works', '<div class="loading-row"><span class="spinner"></span><span>Loading linked works…</span></div>', 'CITATION GRAPH');
    try {
      let works = [];
      if (kind === 'cited-by') {
        const url = new URL(`${API.openAlex}/works`); url.searchParams.set('filter', `cites:${work.openAlexId}`); url.searchParams.set('per_page', '15'); url.searchParams.set('sort', 'cited_by_count:desc'); url.searchParams.set('select', openAlexSelect());
        const data = await fetchJSON(url.href); works = (data.results || []).map((item, i) => normalizeOpenAlex(item, i));
      } else if (kind === 'references') works = await batchOpenAlexWorks(work.references || []);
      else works = await batchOpenAlexWorks(work.related || []);
      registerWorks(works);
      $('modal-content').innerHTML = works.length ? `<p class="helper-text">${kind === 'cited-by' ? 'These records cite this work according to OpenAlex. Citation links are not complete for every source.' : kind === 'references' ? 'Reference records depend on the coverage and linked identifiers available in OpenAlex.' : 'Relatedness is computed by the index and is not a peer-review or quality assessment.'}</p><ul class="related-list">${works.map((item) => `<li><h4><button type="button" data-action="work-details" data-work="${escapeHTML(item.key)}">${escapeHTML(item.title)}</button></h4><p>${escapeHTML([item.authorNames.slice(0, 4).join(', '), item.year || 'Year unknown', item.source].filter(Boolean).join(' · '))} · ${formatNumber(item.citations)} citations</p><div class="result-actions"><button class="result-action" type="button" data-action="save-work" data-work="${escapeHTML(item.key)}">Save</button><button class="result-action" type="button" data-action="cite-work" data-work="${escapeHTML(item.key)}">Cite</button>${item.url ? `<a class="result-action" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer">Open record ↗</a>` : ''}</div></li>`).join('')}</ul>` : `<div class="no-results"><p>No linked records were returned for this work. This can mean that the index has incomplete citation data, not that the work has no references or citations.</p></div>`;
    } catch (_) {
      $('modal-content').innerHTML = `<div class="inline-error">The citation graph could not be loaded. The selected index may be rate-limited or this record may not have linked works.</div>`;
    }
  }
  async function openVersions(work) {
    if (!work) return;
    const list = work.locations || [];
    const items = list.map((item) => `<li><a href="${escapeHTML(item.pdf || item.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item.label || 'Available copy')} ↗</a><p class="subtle">${escapeHTML(item.sourceType || 'Source type not stated')}${item.pdf ? ' · PDF available' : ''}</p></li>`).join('');
    openModal('Available versions', `<p>These are repository and publisher locations reported in the indexed metadata. Copies may differ in version, access terms, or formatting.</p>${items ? `<ul class="related-list">${items}</ul>` : '<p>No version links were included in this record. Search by DOI to find publisher and repository copies.</p>'}${work.doi ? `<div class="modal-actions"><a href="https://scholar.google.com/scholar?cluster=&q=${encodeURIComponent(work.doi)}" target="_blank" rel="noopener noreferrer">Check other versions ↗</a></div>` : ''}`, 'VERSIONS');
  }
  async function openAuthorProfile(id) {
    if (!id) return;
    openModal('Loading author profile…', '<div class="loading-row"><span class="spinner"></span><span>Loading author record and recent work…</span></div>', 'AUTHOR PROFILE');
    try {
      const short = shortId(id, 'A');
      const [author, papers] = await Promise.all([
        fetchJSON(`${API.openAlex}/authors/${encodeURIComponent(short)}?select=id,display_name,orcid,works_count,cited_by_count,summary_stats,last_known_institutions,affiliations,ids,updated_date,created_date`),
        fetchJSON(`${API.openAlex}/works?filter=authorships.author.id:${encodeURIComponent(short)}&per_page=12&sort=cited_by_count:desc&select=${encodeURIComponent(openAlexSelect())}`)
      ]);
      state.entities.set(author.id, { ...author, kind: 'author' });
      const inst = (author.last_known_institutions || []).map((item) => item.display_name).filter(Boolean).join(', ');
      const stats = author.summary_stats || {};
      const works = (papers.results || []).map((item, i) => normalizeOpenAlex(item, i)); registerWorks(works);
      $('modal-title').textContent = author.display_name || 'Author profile'; $('modal-kicker').textContent = 'AUTHOR PROFILE';
      $('modal-content').innerHTML = `<p>${escapeHTML(inst || 'Institutional affiliation not listed')}${author.orcid ? ` · <a href="${escapeHTML(safeUrl(author.orcid) || '')}" target="_blank" rel="noopener noreferrer">ORCID ↗</a>` : ''}</p><div class="profile-stat-grid"><div class="profile-stat"><strong>${formatNumber(author.works_count)}</strong><span>Indexed works</span></div><div class="profile-stat"><strong>${formatNumber(author.cited_by_count)}</strong><span>Citations in OpenAlex</span></div><div class="profile-stat"><strong>${formatNumber(stats.h_index)}</strong><span>h-index</span></div><div class="profile-stat"><strong>${formatNumber(stats.i10_index)}</strong><span>i10-index</span></div></div><div class="modal-actions"><button type="button" data-action="search-author" data-id="${escapeHTML(author.id)}">Search this author's papers</button><button type="button" data-action="copy-author-citation" data-id="${escapeHTML(author.id)}">Copy profile link</button></div><h3>Most-cited indexed works</h3>${works.length ? `<ul class="related-list">${works.map((work) => `<li><h4><button type="button" data-action="work-details" data-work="${escapeHTML(work.key)}">${escapeHTML(work.title)}</button></h4><p>${escapeHTML([work.year, work.source, `${formatNumber(work.citations)} citations`].filter(Boolean).join(' · '))}</p><div class="result-actions"><button type="button" class="result-action" data-action="cite-work" data-work="${escapeHTML(work.key)}">Cite</button><button type="button" class="result-action" data-action="save-work" data-work="${escapeHTML(work.key)}">Save</button></div></li>`).join('')}</ul>` : '<p>No work records were returned for this author.</p>'}<p class="subtle">Author names are disambiguated imperfectly in bibliographic databases. Confirm ORCID and affiliation to ensure this profile refers to the right researcher. Metrics reflect OpenAlex's current data snapshot.</p>`;
    } catch (_) { $('modal-content').innerHTML = '<div class="inline-error">Could not load this author profile. The record may have moved or the API may be temporarily unavailable.</div>'; }
  }
  async function openEntityProfile(id) {
    const entity = state.entities.get(id);
    if (!entity) return;
    const isSource = entity.kind === 'sources';
    const isInstitution = entity.kind === 'institutions';
    if (entity.kind === 'author') return openAuthorProfile(id);
    const endpoint = isSource ? 'sources' : 'institutions';
    openModal(entity.display_name || 'Entity profile', '<div class="loading-row"><span class="spinner"></span><span>Loading profile…</span></div>', 'INDEXED ENTITY');
    try {
      const short = shortId(id, isSource ? 'S' : 'I');
      const item = await fetchJSON(`${API.openAlex}/${endpoint}/${encodeURIComponent(short)}`);
      const stats = item.summary_stats || {};
      const metricHtml = `<div class="profile-stat-grid"><div class="profile-stat"><strong>${formatNumber(item.works_count)}</strong><span>Indexed works</span></div><div class="profile-stat"><strong>${formatNumber(item.cited_by_count)}</strong><span>Citations</span></div>${stats.h_index != null ? `<div class="profile-stat"><strong>${formatNumber(stats.h_index)}</strong><span>h-index</span></div>` : ''}<div class="profile-stat"><strong>${escapeHTML(item.country_code || '—')}</strong><span>Country code</span></div></div>`;
      $('modal-title').textContent = item.display_name || 'Entity profile'; $('modal-kicker').textContent = isSource ? 'JOURNAL / SOURCE PROFILE' : 'INSTITUTION PROFILE';
      $('modal-content').innerHTML = `<p>${escapeHTML([item.type, item.issn_l ? `ISSN ${item.issn_l}` : '', item.host_organization_name || '', item.country_code || ''].filter(Boolean).join(' · '))}</p>${metricHtml}<div class="modal-actions"><button type="button" data-action="search-entity-works" data-id="${escapeHTML(item.id)}" data-name="${escapeHTML(item.display_name || '')}" data-kind="${escapeHTML(endpoint)}">Search associated works</button>${safeUrl(item.homepage_url) ? `<a href="${escapeHTML(safeUrl(item.homepage_url))}" target="_blank" rel="noopener noreferrer">Official website ↗</a>` : ''}</div><p class="subtle">Counts depend on OpenAlex's source matching and coverage. They are not an official ranking or a direct measure of quality.</p>`;
    } catch (_) { $('modal-content').innerHTML = '<div class="inline-error">Could not load this profile from OpenAlex right now.</div>'; }
  }
  function serializeWork(work) {
    return {
      key: work.key, id: work.id || '', openAlexId: work.openAlexId || '', semanticId: work.semanticId || '', doi: work.doi || '', title: work.title || '',
      year: work.year || null, date: work.date || '', type: work.type || 'work', authors: (work.authors || []).slice(0, 20), authorNames: (work.authorNames || []).slice(0, 20),
      source: work.source || '', sourceType: work.sourceType || '', publisher: work.publisher || '', url: work.url || '', oaUrl: work.oaUrl || '', pdfUrl: work.pdfUrl || '', openAccess: !!work.openAccess,
      abstract: (work.abstract || '').slice(0, 16000), citations: Number(work.citations || 0), references: (work.references || []).slice(0, 100), related: (work.related || []).slice(0, 100),
      locations: (work.locations || []).slice(0, 30), biblio: work.biblio || {}, language: work.language || '', sourceApis: (work.sourceApis || []).slice(0, 5), rank: Number(work.rank || 0), savedAt: Date.now()
    };
  }
  function saveWork(key) {
    const work = state.works.get(key);
    if (!work) { toast('This record is no longer in the current search.'); return; }
    const existing = state.library.findIndex((item) => item.key === key || (work.doi && item.doi === work.doi));
    if (existing >= 0) { toast('Already in your library.'); return; }
    state.library.unshift(serializeWork(work)); state.library = state.library.slice(0, 1000); writeStore(STORAGE.library, state.library);
    $('library-count').textContent = String(state.library.length); toast('Saved to your library.');
    if (state.view === 'library') renderLibrary(); else updateSaveButtons(key, true);
  }
  function updateSaveButtons(key, saved) {
    document.querySelectorAll(`[data-action="save-work"][data-work="${cssEscape(key)}"]`).forEach((button) => {
      button.textContent = saved ? '✓ Saved' : 'Save'; button.classList.toggle('saved', saved);
    });
  }
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  function removeSaved(key) {
    state.library = state.library.filter((item) => item.key !== key); writeStore(STORAGE.library, state.library);
    $('library-count').textContent = String(state.library.length); toast('Removed from your library.'); renderLibrary();
  }
  function renderLibrary() {
    updateIntro(); $('results-toolbar').hidden = false; $('results-heading').textContent = 'Saved library';
    $('results-subheading').textContent = `${state.library.length} saved ${state.library.length === 1 ? 'work' : 'works'} · stored in this browser`;
    $('pagination').hidden = true;
    if (!state.library.length) {
      $('results').innerHTML = `<div class="empty-panel"><h2>Your library is ready.</h2><p>Save records from article search. Your list stays in this browser and can be exported as BibTeX or RIS for a reference manager.</p><button class="plain-button" type="button" data-action="switch-view" data-view="articles">Find papers</button></div>`;
      return;
    }
    state.library.forEach((work) => state.works.set(work.key, work));
    $('results').innerHTML = `<div class="toolbar-actions" style="margin:12px 0 4px"><button class="plain-button compact" type="button" data-action="export-library" data-format="bibtex">Export all BibTeX</button><button class="plain-button compact" type="button" data-action="export-library" data-format="ris">Export all RIS</button></div>` + state.library.map((work) => `<article class="saved-result"><h2 class="result-title"><button class="history-query" type="button" data-action="work-details" data-work="${escapeHTML(work.key)}">${escapeHTML(work.title)}</button></h2><p class="result-authors">${escapeHTML((work.authorNames || []).join(', '))}${work.year ? ` · ${escapeHTML(work.year)}` : ''}${work.source ? ` · ${escapeHTML(work.source)}` : ''}</p><div class="metric-row"><span><strong>${formatNumber(work.citations)}</strong> citations</span><span>${work.openAccess || work.oaUrl || work.pdfUrl ? 'Open-access link recorded' : 'No open-access link recorded'}</span><span class="subtle">Saved ${new Date(work.savedAt || Date.now()).toLocaleDateString()}</span></div><div class="result-actions"><button type="button" class="result-action" data-action="work-details" data-work="${escapeHTML(work.key)}">Details</button><button type="button" class="result-action" data-action="cite-work" data-work="${escapeHTML(work.key)}">Cite / export</button><button type="button" class="result-action" data-action="remove-saved" data-work="${escapeHTML(work.key)}">Remove</button>${work.url ? `<a class="result-action" href="${escapeHTML(work.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : ''}</div></article>`).join('');
  }
  function renderHistory() {
    updateIntro(); $('results-toolbar').hidden = false; $('results-heading').textContent = 'Recent searches'; $('results-subheading').textContent = 'Stored locally on this device'; $('pagination').hidden = true;
    if (!state.history.length) { $('results').innerHTML = '<div class="empty-panel"><h2>No recent searches yet.</h2><p>Searches you run in Acadia appear here, making it easy to pick up where you left off.</p></div>'; return; }
    $('results').innerHTML = state.history.map((item) => `<article class="history-result"><button type="button" class="history-query" data-action="rerun-history" data-query="${escapeHTML(item.query)}" data-view="${escapeHTML(item.view || 'articles')}">${escapeHTML(item.query)}</button><p class="author-subline">${escapeHTML((item.view || 'articles').replace(/s$/, '').replace(/^./, (c) => c.toUpperCase()))} · ${escapeHTML(new Date(item.at || Date.now()).toLocaleString())}</p><div class="result-actions"><button type="button" class="result-action" data-action="rerun-history" data-query="${escapeHTML(item.query)}" data-view="${escapeHTML(item.view || 'articles')}">Run search</button><button type="button" class="result-action" data-action="delete-history" data-key="${escapeHTML(item.key)}">Remove</button></div></article>`).join('');
  }
  function renderAlerts() {
    updateIntro(); $('results-toolbar').hidden = false; $('results-heading').textContent = 'Research alerts'; $('results-subheading').textContent = 'Saved search queries · stored locally on this device'; $('pagination').hidden = true;
    const enableButton = `<div class="modal-actions"><button type="button" data-action="enable-notifications">Enable browser notifications</button><button type="button" data-action="new-alert">＋ New alert</button></div><p class="helper-text">Acadia currently stores alerts in this browser and runs them when you choose “Run alert.” It does not send email or check in the background while the site is closed.</p>`;
    if (!state.alerts.length) { $('results').innerHTML = `<div class="empty-panel"><h2>Follow a research topic.</h2><p>Create a saved query so you can quickly run the same search again and compare new results.</p>${enableButton}</div>`; return; }
    $('results').innerHTML = enableButton + state.alerts.map((alert) => `<article class="alert-result"><h2 class="author-name" style="font-size:17px">${escapeHTML(alert.label || alert.query)}</h2><p class="author-subline">${escapeHTML(alert.query)} · ${escapeHTML(alert.view || 'articles')} · Created ${escapeHTML(new Date(alert.createdAt || Date.now()).toLocaleDateString())}</p><p class="helper-text">Last run: ${alert.lastCheckedAt ? escapeHTML(new Date(alert.lastCheckedAt).toLocaleString()) : 'Not checked yet'}${alert.lastCount != null ? ` · ${escapeHTML(String(alert.lastCount))} results returned last time` : ''}</p><div class="result-actions"><button type="button" class="result-action" data-action="run-alert" data-id="${escapeHTML(alert.id)}">Run alert</button><button type="button" class="result-action" data-action="delete-alert" data-id="${escapeHTML(alert.id)}">Delete</button></div></article>`).join('');
  }
  function renderMetrics() {
    updateIntro(); $('results-toolbar').hidden = false; $('results-heading').textContent = 'My research summary'; $('results-subheading').textContent = 'A local summary of the records saved to your library'; $('pagination').hidden = true;
    const works = state.library; const cites = works.reduce((sum, item) => sum + Number(item.citations || 0), 0);
    const openAccess = works.filter((item) => item.openAccess || item.oaUrl || item.pdfUrl).length;
    const byYear = new Map(); works.forEach((item) => { if (item.year) byYear.set(item.year, (byYear.get(item.year) || 0) + 1); });
    const years = [...byYear.entries()].sort((a, b) => b[0] - a[0]).slice(0, 8);
    $('results').innerHTML = `<div class="profile-stat-grid"><div class="profile-stat"><strong>${formatNumber(works.length)}</strong><span>Saved works</span></div><div class="profile-stat"><strong>${formatNumber(cites)}</strong><span>Combined citations of saved works</span></div><div class="profile-stat"><strong>${works.length ? Math.round(openAccess / works.length * 100) : 0}%</strong><span>With an open-access link</span></div><div class="profile-stat"><strong>${formatNumber(works.filter((item) => item.doi).length)}</strong><span>With DOI metadata</span></div></div><h3>Saved works by publication year</h3>${years.length ? `<table class="data-table"><thead><tr><th>Year</th><th>Saved works</th></tr></thead><tbody>${years.map(([year, count]) => `<tr><td>${year}</td><td>${count}</td></tr>`).join('')}</tbody></table>` : '<p class="subtle">Save a few papers to see a year-by-year breakdown here.</p>'}<div class="warning-note">Citation counts are the indexed counts on each saved record, not citations to your own work. This page is a library summary, not a personal author-impact profile.</div><div class="modal-actions"><button type="button" data-action="switch-view" data-view="library">Open library</button><button type="button" data-action="export-library" data-format="bibtex">Export library BibTeX</button><button type="button" data-action="export-library" data-format="ris">Export library RIS</button></div>`;
  }
  function openCreateAlertModal(existingQuery) {
    const q = existingQuery || state.query || '';
    const content = `<form id="alert-form"><label class="field-label" for="alert-label">Alert name</label><input class="modal-input" id="alert-label" maxlength="120" value="${escapeHTML(q.slice(0, 100))}" placeholder="My research topic"><label class="field-label" for="alert-query">Search query</label><input class="modal-input" id="alert-query" maxlength="400" value="${escapeHTML(q)}" required><label class="field-label" for="alert-view">Search in</label><select class="modal-input" id="alert-view"><option value="articles" ${state.view === 'articles' ? 'selected' : ''}>Articles and papers</option><option value="authors" ${state.view === 'authors' ? 'selected' : ''}>Authors</option></select><div class="warning-note">This saves a repeatable query in this browser. Alerts do not send emails and do not run while Acadia is closed. Browser notifications can be enabled from the Alerts page.</div><div class="modal-actions"><button type="submit">Save alert</button><button type="button" data-modal-close>Cancel</button></div></form>`;
    openModal('Create research alert', content, 'SAVED SEARCH');
    $('alert-label').focus();
    $('alert-form').addEventListener('submit', (event) => {
      event.preventDefault(); const query = $('alert-query').value.trim(); if (!query) { $('alert-query').focus(); return; }
      const alert = { id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, label: $('alert-label').value.trim() || query, query, view: $('alert-view').value, createdAt: Date.now(), lastCheckedAt: null, lastCount: null };
      state.alerts.unshift(alert); state.alerts = state.alerts.slice(0, 100); writeStore(STORAGE.alerts, state.alerts); closeModal(); toast('Research alert saved in this browser.');
      if (state.view === 'alerts') renderAlerts();
    });
  }
  async function runAlert(id) {
    const alert = state.alerts.find((item) => item.id === id); if (!alert) return;
    state.query = alert.query; $('query').value = alert.query; state.view = alert.view || 'articles';
    closeModal(); updateIntro(); await runCurrentSearch(1);
    alert.lastCheckedAt = Date.now(); alert.lastCount = state.results.length; writeStore(STORAGE.alerts, state.alerts);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(`Acadia alert: ${alert.label}`, { body: `${state.results.length} results returned for “${alert.query}”.` }); } catch (_) { /* notifications can be disabled by policy */ }
    }
  }
  async function enableNotifications() {
    if (!('Notification' in window)) { toast('Browser notifications are not supported in this browser.'); return; }
    try { const permission = await Notification.requestPermission(); toast(permission === 'granted' ? 'Browser notifications enabled.' : 'Notification permission was not granted.'); }
    catch (_) { toast('Could not request notification permission.'); }
  }
  function showAboutData() {
    openModal('Sources, coverage, and metrics', `<p>Acadia combines publicly accessible bibliographic metadata from three sources:</p><ul class="about-sources-list"><li><strong>OpenAlex</strong> supplies work, author, journal, institution, citation, and open-access metadata.</li><li><strong>Crossref</strong> supplements DOI registration records, publisher metadata, and reference counts.</li><li><strong>Semantic Scholar</strong> contributes scholarly graph search, citation counts, abstracts, and open-access PDF links where available.</li></ul><p>The APIs are queried from the browser. Public services can rate-limit requests, change their schemas, or be unavailable; Acadia continues with whichever indexes respond. Duplicate works are merged using DOI and normalized title. Citation totals may differ across sources because their corpora and matching rules differ.</p><p>Source-context scores are explanatory heuristics based on known domains and the metadata's declared source type. They are not a quality score for the paper, a guarantee of peer review, or a claim that a result is factually correct. A repository copy may be a preprint or accepted manuscript.</p><p>Saved papers, search history, and alerts use this browser's local storage. They are not synced to an account or uploaded to Acadia's servers. Clearing browser data removes them.</p><p>Patent and case-law searches currently open specialist indexes directly because no public, unrestricted, browser-ready API covers those collections comprehensively.</p>`, 'ABOUT THE INDEX');
  }
  function getSelectedWorks() { return [...state.selected].map((key) => state.works.get(key)).filter(Boolean); }
  function exportLibrary(format) {
    if (!state.library.length) { toast('Your library is empty.'); return; }
    const style = format === 'ris' ? 'ris' : 'bibtex';
    downloadText(`acadia-library.${style === 'ris' ? 'ris' : 'bib'}`, citationText(state.library, style), style === 'ris' ? 'application/x-research-info-systems;charset=utf-8' : 'application/x-bibtex;charset=utf-8');
  }
  function applyAdvancedFields() {
    state.advanced.phrase = $('advanced-phrase').value.trim(); state.advanced.author = $('advanced-author').value.trim();
    state.advanced.publication = $('advanced-publication').value.trim(); state.advanced.exclude = $('advanced-exclude').value.trim();
    state.advanced.field = $('advanced-field').value; state.advanced.type = $('advanced-type').value;
    getCurrentFilters(); state.page = 1; runCurrentSearch(1);
  }
  function resetFilters() {
    state.filters = { from: '', to: '', sort: 'relevance', type: '', minCitations: 0, openAccess: false, withAbstract: false };
    state.advanced.type = '';
    $('advanced-type').value = ''; loadFilters();
    if (state.query) runCurrentSearch(1); else toast('Filters cleared.');
  }
  function setView(view) {
    if (!['articles', 'authors', 'journals', 'institutions', 'library', 'alerts', 'history', 'metrics', 'patents', 'cases'].includes(view)) view = 'articles';
    state.searchToken++; setBusy(false);
    state.view = view; state.page = 1; state.selected.clear(); updateIntro(); syncSearchURL();
    if (['library', 'alerts', 'history', 'metrics'].includes(view)) runCurrentSearch(1);
    else if (['patents', 'cases'].includes(view)) openExternalSearchView(view);
    else if (state.query) runCurrentSearch(1);
    else emptyState();
  }
  function runHistorySearch(query, view) {
    state.searchToken++; setBusy(false);
    state.query = query || ''; $('query').value = state.query;
    state.view = view || 'articles'; state.page = 1; updateIntro(); runCurrentSearch(1);
  }
  function handleAction(button) {
    const action = button.dataset.action;
    const key = button.dataset.work;
    const work = key ? state.works.get(key) : null;
    if (action === 'work-details') openWorkDetails(work);
    else if (action === 'save-work') saveWork(key);
    else if (action === 'remove-saved') removeSaved(key);
    else if (action === 'cite-work') openCitationModal(work);
    else if (action === 'cited-by') openWorkCollection(work, 'cited-by');
    else if (action === 'references') openWorkCollection(work, 'references');
    else if (action === 'related') openWorkCollection(work, 'related');
    else if (action === 'versions') openVersions(work);
    else if (action === 'toggle-abstract') {
      const target = $(button.dataset.target); if (!target || !work) return;
      const expanded = button.getAttribute('aria-expanded') === 'true';
      target.textContent = expanded ? (work.abstract ? (work.abstract.length > 460 ? `${work.abstract.slice(0, 457).trim()}…` : work.abstract) : 'Abstract not available in the indexed metadata.') : (work.abstract || 'No abstract is available for this record.');
      target.classList.toggle('muted', expanded && !work.abstract); button.setAttribute('aria-expanded', expanded ? 'false' : 'true'); button.textContent = expanded ? (work.abstract ? 'Show abstract' : 'Metadata') : 'Hide abstract';
    } else if (action === 'author-profile') openAuthorProfile(button.dataset.id);
    else if (action === 'entity-profile') openEntityProfile(button.dataset.id);
    else if (action === 'search-author') {
      const id = button.dataset.id; const entity = state.entities.get(id);
      const name = entity && entity.display_name || button.closest('.author-result')?.querySelector('.author-name')?.textContent || '';
      state.advanced.author = name; $('advanced-author').value = name; state.view = 'articles'; updateIntro(); state.query = $('query').value.trim() || name; $('query').value = state.query; runCurrentSearch(1); closeModal();
    } else if (action === 'search-entity-works') {
      const name = button.dataset.name || ''; const kind = button.dataset.kind;
      state.view = 'articles'; state.query = name; $('query').value = name; state.advanced.publication = kind === 'sources' ? name : ''; state.advanced.author = ''; $('advanced-publication').value = state.advanced.publication; $('advanced-author').value = '';
      updateIntro(); runCurrentSearch(1); closeModal();
    } else if (action === 'switch-view') setView(button.dataset.view);
    else if (action === 'retry-search') runCurrentSearch(1);
    else if (action === 'clear-filters') { resetFilters(); }
    else if (action === 'copy-citation') copyText($('citation-output') ? $('citation-output').value : '');
    else if (action === 'download-citation') {
      const style = activeCitationStyle(); const ext = style === 'bibtex' ? 'bib' : style === 'ris' ? 'ris' : 'txt';
      const mime = style === 'bibtex' ? 'application/x-bibtex;charset=utf-8' : style === 'ris' ? 'application/x-research-info-systems;charset=utf-8' : 'text/plain;charset=utf-8';
      downloadText(`acadia-citation.${ext}`, citationText(state.citationWorks, style), mime);
    } else if (action === 'copy-author-citation') copyText(`https://openalex.org/${shortId(button.dataset.id, 'A')}`);
    else if (action === 'export-library') exportLibrary(button.dataset.format);
    else if (action === 'rerun-history') runHistorySearch(button.dataset.query, button.dataset.view);
    else if (action === 'delete-history') {
      state.history = state.history.filter((item) => item.key !== button.dataset.key); writeStore(STORAGE.history, state.history); populateRecentSearches(); renderHistory();
    } else if (action === 'new-alert') openCreateAlertModal();
    else if (action === 'run-alert') runAlert(button.dataset.id);
    else if (action === 'delete-alert') { state.alerts = state.alerts.filter((item) => item.id !== button.dataset.id); writeStore(STORAGE.alerts, state.alerts); renderAlerts(); toast('Alert deleted.'); }
    else if (action === 'enable-notifications') enableNotifications();
  }

  // Main UI events.
  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault(); state.query = $('query').value.trim(); state.page = 1; getCurrentFilters(); runCurrentSearch(1);
  });
  $('clear-query').addEventListener('click', () => { $('query').value = ''; state.query = ''; $('query').focus(); $('clear-query').classList.remove('visible'); });
  $('query').addEventListener('input', () => $('clear-query').classList.toggle('visible', !!$('query').value));
  $('view-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]'); if (!button) return;
    setView(button.dataset.view);
  });
  $('alerts-shortcut').addEventListener('click', () => setView('alerts'));
  $('advanced-toggle').addEventListener('click', () => {
    state.activeAdvanced = !state.activeAdvanced; $('advanced-panel').hidden = !state.activeAdvanced;
    $('advanced-toggle').setAttribute('aria-expanded', String(state.activeAdvanced));
  });
  $('advanced-apply').addEventListener('click', applyAdvancedFields);
  $('apply-filters').addEventListener('click', () => { getCurrentFilters(); runCurrentSearch(1); });
  $('reset-filters').addEventListener('click', resetFilters);
  $('create-alert').addEventListener('click', () => openCreateAlertModal());
  $('export-selected').addEventListener('click', () => openCitationModal(getSelectedWorks()));
  $('previous-page').addEventListener('click', () => { if (state.page > 1) runCurrentSearch(state.page - 1); });
  $('next-page').addEventListener('click', () => { if (state.canNext) runCurrentSearch(state.page + 1); });
  $('about-data').addEventListener('click', showAboutData);
  $('modal-close').addEventListener('click', closeModal);
  $('modal-root').addEventListener('click', (event) => { if (event.target.matches('[data-modal-close]')) closeModal(); });
  $('modal-content').addEventListener('change', (event) => { if (event.target.id === 'citation-style') updateCitationOutput(); });
  $('modal-content').addEventListener('click', (event) => {
    const form = event.target.closest('#alert-form');
    const button = event.target.closest('[data-action]'); if (!button) return;
    if (button.tagName === 'A') event.preventDefault();
    if (button.dataset.action === 'enable-notifications') enableNotifications();
    else if (button.dataset.action === 'new-alert') openCreateAlertModal();
    else handleAction(button);
  });
  $('results').addEventListener('click', (event) => {
    const quick = event.target.closest('[data-quick-query]');
    if (quick) { state.query = quick.dataset.quickQuery; $('query').value = state.query; state.view = 'articles'; updateIntro(); runCurrentSearch(1); return; }
    const button = event.target.closest('[data-action]'); if (button) { if (button.tagName === 'A') event.preventDefault(); handleAction(button); }
  });
  $('results').addEventListener('change', (event) => {
    const input = event.target.closest('[data-select-work]'); if (!input) return;
    const key = input.dataset.selectWork;
    if (input.checked) state.selected.add(key); else state.selected.delete(key);
    $('selected-count').textContent = String(state.selected.size); $('export-selected').disabled = !state.selected.size;
  });
  $('results').addEventListener('click', (event) => {
    const historyButton = event.target.closest('[data-action="history-query"]'); if (historyButton) runHistorySearch(historyButton.dataset.query, historyButton.dataset.view);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('modal-root').hidden) closeModal();
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && $('modal-root').hidden) { event.preventDefault(); $('query').focus(); }
  });
  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search); const q = params.get('q') || '';
    const view = params.get('view') || 'articles';
    if (q !== state.query || view !== state.view) { state.query = q; $('query').value = q; state.view = view; updateIntro(); runCurrentSearch(1); }
  });

  // Restore supported UI state from URL/local storage; do not make background requests.
  populateRecentSearches();
  $('library-count').textContent = String(state.library.length);
  const initialParams = new URLSearchParams(window.location.search);
  state.query = initialParams.get('q') || '';
  $('query').value = state.query; $('clear-query').classList.toggle('visible', !!state.query);
  const initialView = initialParams.get('view'); if (initialView && ['articles', 'authors', 'journals', 'institutions', 'library', 'alerts', 'history', 'metrics', 'patents', 'cases'].includes(initialView)) state.view = initialView;
  state.advanced = { ...state.advanced, ...(state.settings.advanced || {}) };
  state.filters = { ...state.filters, ...(state.settings.filters || {}) };
  $('advanced-phrase').value = state.advanced.phrase; $('advanced-author').value = state.advanced.author; $('advanced-publication').value = state.advanced.publication;
  $('advanced-exclude').value = state.advanced.exclude; $('advanced-field').value = state.advanced.field || 'all';
  loadFilters(); updateIntro();
  if (state.view === 'articles' && !state.query) emptyState(); else runCurrentSearch(1);
  window.addEventListener('beforeunload', () => {
    state.settings = { advanced: state.advanced, filters: state.filters };
    try { localStorage.setItem(STORAGE.settings, JSON.stringify(state.settings)); } catch (_) { /* storage can be disabled */ }
  });
})();
