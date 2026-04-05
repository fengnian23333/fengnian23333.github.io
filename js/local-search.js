/* global CONFIG */

(function() {
  var CONFIG_RETRY_MAX = 20;
  var CONFIG_RETRY_DELAY = 80;

  function getConfig() {
    return window.CONFIG || null;
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
      return;
    }
    fn();
  }

  function escapeHTML(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripTags(html) {
    var container = document.createElement('div');
    container.innerHTML = String(html || '');
    return (container.textContent || container.innerText || '').trim();
  }

  function debounce(fn, wait) {
    var timer = null;
    return function() {
      var context = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function() {
        fn.apply(context, args);
      }, wait);
    };
  }

  function getSearchPath() {
    var cfg = getConfig();
    var path = (cfg && cfg.localsearch && cfg.localsearch.path) || (cfg && cfg.path) || 'search.xml';
    if (/^(https?:)?\/\//i.test(path) || path.charAt(0) === '/') return path;
    var root = (cfg && cfg.root) || '/';
    return root.replace(/\/?$/, '/') + path.replace(/^\//, '');
  }

  function countHits(text, keyword) {
    var hits = 0;
    var start = 0;
    var pos = -1;
    while ((pos = text.indexOf(keyword, start)) !== -1) {
      hits++;
      start = pos + keyword.length;
    }
    return hits;
  }

  function firstIndex(text, keyword) {
    var pos = text.indexOf(keyword);
    return pos >= 0 ? pos : Number.POSITIVE_INFINITY;
  }

  function normalizeUrl(url) {
    var value = String(url || '').trim();
    try {
      value = decodeURIComponent(value);
    } catch (error) {}
    if (!value) return '#';
    if (/^(https?:)?\/\//i.test(value) || value.charAt(0) === '/') return value;
    var cfg = getConfig();
    var root = (cfg && cfg.root) || '/';
    return root.replace(/\/?$/, '/') + value.replace(/^\//, '');
  }

  function withHighlight(url, query) {
    try {
      var parsed = new URL(url, window.location.origin);
      parsed.searchParams.set('highlight', query);
      return parsed.pathname + parsed.search + parsed.hash;
    } catch (error) {
      return url;
    }
  }

  function buildSnippet(content, keywords) {
    var full = String(content || '').trim();
    if (!full) return '';

    var lower = full.toLowerCase();
    var best = Number.POSITIVE_INFINITY;
    keywords.forEach(function(keyword) {
      best = Math.min(best, firstIndex(lower, keyword));
    });

    if (!Number.isFinite(best)) {
      return full.slice(0, 120) + (full.length > 120 ? '...' : '');
    }

    var start = Math.max(0, best - 32);
    var end = Math.min(full.length, best + 96);
    var prefix = start > 0 ? '...' : '';
    var suffix = end < full.length ? '...' : '';
    return prefix + full.slice(start, end) + suffix;
  }

  function highlight(text, keywords) {
    var html = escapeHTML(text);
    keywords.forEach(function(keyword) {
      var safe = escapeRegExp(escapeHTML(keyword));
      if (!safe) return;
      html = html.replace(new RegExp(safe, 'gi'), function(match) {
        return '<mark class="search-keyword">' + match + '</mark>';
      });
    });
    return html;
  }

  function parseSearchData(raw, isXml) {
    var entries;
    if (isXml) {
      var xml = new window.DOMParser().parseFromString(raw, 'text/xml');
      if (xml.querySelector('parsererror')) {
        throw new Error('Search index XML parse error');
      }
      entries = Array.prototype.slice.call(xml.querySelectorAll('entry')).map(function(entry) {
        var titleNode = entry.querySelector('title');
        var contentNode = entry.querySelector('content');
        var urlNode = entry.querySelector('url');
        return {
          title: titleNode ? titleNode.textContent.trim() : '',
          content: contentNode ? stripTags(contentNode.textContent) : '',
          url: urlNode ? normalizeUrl(urlNode.textContent) : '#'
        };
      });
    } else {
      entries = JSON.parse(raw).map(function(entry) {
        return {
          title: String(entry.title || '').trim(),
          content: stripTags(entry.content || ''),
          url: normalizeUrl(entry.url || '')
        };
      });
    }
    return entries.filter(function(entry) {
      return entry.title;
    });
  }

  var cachedEntriesPromise = null;

  function fetchEntries() {
    if (cachedEntriesPromise) return cachedEntriesPromise;
    var path = getSearchPath();
    var isXml = !/\.json(\?|$)/i.test(path);
    cachedEntriesPromise = fetch(path)
      .then(function(response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        return response.text();
      })
      .then(function(raw) {
        return parseSearchData(raw, isXml);
      })
      .catch(function(error) {
        // Allow retry after a failed request instead of caching the rejection forever.
        cachedEntriesPromise = null;
        throw error;
      });
    return cachedEntriesPromise;
  }

  function searchEntries(entries, query, topN) {
    var keywords = query
      .trim()
      .toLowerCase()
      .split(/[\s\-]+/)
      .filter(function(item, index, arr) {
        return item && arr.indexOf(item) === index;
      });

    if (!keywords.length) {
      return { keywords: keywords, items: [] };
    }

    var items = [];
    entries.forEach(function(entry) {
      var title = entry.title || '';
      var content = entry.content || '';
      var titleLower = title.toLowerCase();
      var contentLower = content.toLowerCase();

      var titleHits = 0;
      var contentHits = 0;
      keywords.forEach(function(keyword) {
        titleHits += countHits(titleLower, keyword);
        contentHits += countHits(contentLower, keyword);
      });

      var totalHits = titleHits + contentHits;
      if (!totalHits) return;

      var score = titleHits * 20 + contentHits * 5;
      var snippet = buildSnippet(content, keywords);
      items.push({
        title: title,
        snippet: snippet,
        href: withHighlight(entry.url, keywords.join(' ')),
        score: score
      });
    });

    items.sort(function(left, right) {
      return right.score - left.score;
    });

    var upperBound = Number.parseInt(topN, 10);
    if (Number.isFinite(upperBound) && upperBound >= 0) {
      items = items.slice(0, upperBound || 30);
    }

    return { keywords: keywords, items: items };
  }

  function renderMessage(resultEl, controlsEl, message) {
    if (controlsEl) controlsEl.innerHTML = '';
    resultEl.innerHTML = '<div class="search-empty">' + escapeHTML(message) + '</div>';
  }

  function renderResults(resultEl, controlsEl, query, payload) {
    var keywords = payload.keywords;
    var items = payload.items;
    if (!items.length) {
      if (controlsEl) controlsEl.innerHTML = '';
      resultEl.innerHTML = '<div id="no-result">没有找到与 <strong>' + escapeHTML(query) + '</strong> 相关的内容</div>';
      return;
    }

    if (controlsEl) {
      controlsEl.innerHTML = '共找到 <strong>' + items.length + '</strong> 条结果';
    }

    var list = items.map(function(item) {
      var title = highlight(item.title, keywords);
      var snippet = item.snippet ? '<a href="' + item.href + '"><p class="search-result">' + highlight(item.snippet, keywords) + '</p></a>' : '';
      return '<li><a href="' + item.href + '" class="search-result-title">' + title + '</a>' + snippet + '</li>';
    }).join('');

    resultEl.innerHTML = '<ul class="search-result-list">' + list + '</ul>';
  }

  function bindSearch(inputEl, resultEl, controlsEl, options) {
    if (!inputEl || !resultEl) return;

    var trigger = options.trigger || 'auto';
    var syncQuery = !!options.syncQuery;

    function syncPageQuery(query) {
      if (!syncQuery) return;
      var url = new URL(window.location.href);
      if (query) {
        url.searchParams.set('q', query);
      } else {
        url.searchParams.delete('q');
      }
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }

    function runSearch() {
      var query = inputEl.value.trim();
      syncPageQuery(query);
      if (!query) {
        renderMessage(resultEl, controlsEl, '输入关键词开始搜索');
        return;
      }

      if (controlsEl) controlsEl.innerHTML = '正在搜索...';
      fetchEntries()
        .then(function(entries) {
          var payload = searchEntries(entries, query, 30);
          renderResults(resultEl, controlsEl, query, payload);
        })
        .catch(function(error) {
          var details = (error && error.message) ? '（' + error.message + '）' : '';
          renderMessage(resultEl, controlsEl, '搜索索引加载失败' + details);
        });
    }

    var onInput = debounce(runSearch, 140);
    if (trigger === 'manual') {
      inputEl.addEventListener('keydown', function(event) {
        if (event.key === 'Enter') runSearch();
      });
    } else {
      inputEl.addEventListener('input', onInput);
    }

    inputEl.addEventListener('focus', function() {
      fetchEntries().catch(function() {});
    }, { once: true });

    if (options.initialQuery) {
      inputEl.value = options.initialQuery;
      runSearch();
    }
  }

  function setupPopupSearch(triggerMode) {
    var overlay = document.querySelector('.search-pop-overlay');
    if (!overlay) return;
    if (overlay.dataset.localSearchBound === '1') return;

    var input = overlay.querySelector('.search-input');
    var result = overlay.querySelector('#search-result');
    var controls = overlay.querySelector('#search-controls');
    if (!input || !result) return;

    bindSearch(input, result, controls, { trigger: triggerMode });

    function onPopupClose() {
      document.body.style.overflow = '';
      overlay.classList.remove('search-active');
    }

    document.querySelectorAll('.popup-trigger').forEach(function(element) {
      element.addEventListener('click', function() {
        document.body.style.overflow = 'hidden';
        overlay.classList.add('search-active');
        input.focus();
      });
    });

    overlay.addEventListener('click', function(event) {
      if (event.target === overlay) onPopupClose();
    });

    var closeButton = overlay.querySelector('.popup-btn-close');
    if (closeButton) {
      closeButton.addEventListener('click', onPopupClose);
    }

    window.addEventListener('pjax:success', onPopupClose);
    window.addEventListener('keyup', function(event) {
      if (event.key === 'Escape') onPopupClose();
    });

    overlay.dataset.localSearchBound = '1';
  }

  function setupSearchPage(triggerMode) {
    var input = document.getElementById('search-page-input');
    var result = document.getElementById('search-page-result');
    if (!input || !result) return;
    if (input.dataset.localSearchBound === '1') return;

    var controls = document.getElementById('search-page-controls');
    var initialQuery = new URL(window.location.href).searchParams.get('q') || '';

    bindSearch(input, result, controls, {
      trigger: triggerMode,
      syncQuery: true,
      initialQuery: initialQuery
    });

    input.dataset.localSearchBound = '1';
  }

  function initSearch() {
    var cfg = getConfig();
    if (!cfg || !cfg.localsearch || !cfg.localsearch.enable) return;
    var triggerMode = cfg.localsearch.trigger || 'auto';
    setupPopupSearch(triggerMode);
    setupSearchPage(triggerMode);
  }

  function initSearchWithRetry(attempt) {
    var cfg = getConfig();
    if (!cfg) {
      if (attempt < CONFIG_RETRY_MAX) {
        window.setTimeout(function() {
          initSearchWithRetry(attempt + 1);
        }, CONFIG_RETRY_DELAY);
      }
      return;
    }
    initSearch();
  }

  onReady(function() {
    initSearchWithRetry(0);
  });
  window.addEventListener('pjax:success', function() {
    initSearchWithRetry(0);
  });
})();
