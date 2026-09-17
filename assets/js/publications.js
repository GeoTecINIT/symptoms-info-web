/*
 * publications.js -- renders /publications from the Realtime Database and
 * drives the entry-type filter, which is chips on a desktop and a <select>
 * on a phone. One copy for both locales; the page passes in every string.
 */
(function (global) {
  'use strict';

  var toText = function (v) {
    // sanitize-html is not loaded here; BibTeX carries entities but no markup
    var el = document.createElement('textarea');
    el.innerHTML = String(v == null ? '' : v);
    return el.value.trim();
  };

  /**
   * `doi` arrives as a bare `10.xxxx/yyy` or as a full URL. Anything else,
   * or nothing at all, yields null and the title is simply not linked.
   */
  function doiHref(raw) {
    var doi = toText(raw);
    if (!doi) return null;
    if (/^https?:\/\//i.test(doi)) {
      try {
        var u = new URL(doi);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
      } catch (e) {
        return null;
      }
    }
    if (/^10\.\d{4,9}\/\S+$/.test(doi)) return 'https://doi.org/' + doi;
    return null;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== '') node.textContent = text;
    return node;
  }

  /** "journal, pp. 1-2, vol. 3 (4), 2024" -- built from whatever is present. */
  function citationLine(F) {
    var bits = [];
    if (F.journal) {
      bits.push(toText(F.journal));
      if (F.pages) bits.push('pp. ' + toText(F.pages));
      if (F.volume) bits.push('vol. ' + toText(F.volume));
      if (F.number) bits.push('(' + toText(F.number) + ')');
      if (F.year) bits.push(toText(F.year));
    } else if (F.booktitle) {
      bits.push(toText(F.booktitle));
      if (F.pages) bits.push('pp. ' + toText(F.pages));
      if (F.publisher) bits.push(toText(F.publisher));
      if (F.year) bits.push(toText(F.year));
    } else if (F.year) {
      bits.push(toText(F.year));
    }
    if (F.issn) bits.push('ISSN: ' + toText(F.issn));
    else if (F.isbn) bits.push('ISBN: ' + toText(F.isbn));
    return bits.join(', ');
  }

  function buildEntry(pub, strings) {
    var F = pub.Fields || {};
    var type = toText(pub.EntryType) || 'other';

    var card = el('div', 'publication ' + type);
    card.dataset.entryType = type;

    var label = strings.types && strings.types[type] ? strings.types[type] : type;
    card.appendChild(el('p', 'publication-type', label));

    var author = toText(F.author);
    if (author) card.appendChild(el('p', 'publication-authors', author));

    var title = toText(F.title);
    var href = doiHref(F.doi);
    var titleEl = el('h3', 'publication-title');
    if (href) {
      var a = el('a', null, title);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      titleEl.appendChild(a);
    } else {
      titleEl.textContent = title;
    }
    card.appendChild(titleEl);

    var cite = citationLine(F);
    if (cite) card.appendChild(el('p', 'publication-cite', cite));

    // A native <details>, so the list scans as titles and citations and the
    // toggle is keyboard-operable with no JS. Expanded, the abstracts made
    // the page ~20,000px tall on a phone.
    var abstract = toText(F.abstract);
    if (abstract) {
      var details = el('details', 'publication-abstract');
      details.appendChild(el('summary', null, strings.abstract || ''));
      details.appendChild(el('p', null, abstract));
      card.appendChild(details);
    }

    return card;
  }

  function notice(container, message, linkText, linkHref) {
    container.textContent = '';
    var box = el('p', 'data-notice', message);
    if (linkText && linkHref) {
      box.appendChild(document.createTextNode(' '));
      var a = el('a', null, linkText);
      a.href = linkHref;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      box.appendChild(a);
    }
    container.appendChild(box);
  }

  global.initPublications = function initPublications(options) {
    var container = document.getElementById(options.containerId || 'symptoms_publications');
    var btnContainer = document.getElementById(options.buttonsId || 'myBtnContainer');
    if (!container) return;

    var strings = options.strings || {};
    var entries = [];

    function applyFilter(type) {
      for (var i = 0; i < entries.length; i++) {
        // one property; no class juggling, no source-order dependency
        entries[i].hidden = !(type === 'all' || entries[i].dataset.entryType === type);
      }
    }

    if (btnContainer) {
      var buttons = btnContainer.querySelectorAll('.btn');

      // Built from the buttons rather than written into both page sources,
      // so the two controls cannot drift. custom.css section 9 shows exactly
      // one of them at any width.
      var select = document.createElement('select');
      select.className = 'pubs-filter-select';
      select.setAttribute('aria-label', strings.filterLabel || '');
      Array.prototype.forEach.call(buttons, function (btn) {
        var option = document.createElement('option');
        option.value = btn.dataset.filter || 'all';
        option.textContent = btn.textContent.trim();
        option.selected = btn.classList.contains('active');
        select.appendChild(option);
      });

      function setFilter(type) {
        Array.prototype.forEach.call(buttons, function (b) {
          var on = (b.dataset.filter || 'all') === type;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        select.value = type;
        applyFilter(type);
      }

      Array.prototype.forEach.call(buttons, function (btn) {
        btn.addEventListener('click', function () {
          setFilter(btn.dataset.filter || 'all');
        });
        btn.setAttribute('aria-pressed', btn.classList.contains('active') ? 'true' : 'false');
      });

      select.addEventListener('change', function () {
        setFilter(select.value);
      });

      btnContainer.parentNode.insertBefore(select, btnContainer);
    }

    notice(container, strings.loading || '');

    fetch(options.endpoint)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        var raw = data && data.entries;
        var list = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object'
          ? Object.values(raw)
          : null;
        if (!list) throw new Error('unexpected payload shape');

        // as in blog.js: an empty feed and an unusable one are different
        var usable = list.filter(function (p) {
          return p && typeof p === 'object' && p.Fields;
        });
        if (!list.length) {
          notice(container, strings.empty || '');
          return;
        }
        if (!usable.length) throw new Error('no usable entries in payload');

        var frag = document.createDocumentFragment();
        entries = [];
        usable.forEach(function (pub) {
          var card = buildEntry(pub, strings);
          entries.push(card);
          frag.appendChild(card);
        });
        container.textContent = '';
        container.appendChild(frag);

        var active = btnContainer && btnContainer.querySelector('.btn.active');
        applyFilter((active && active.dataset.filter) || 'all');
      })
      .catch(function (error) {
        console.error('publications: could not load', error);
        notice(container, strings.error || '', strings.errorLinkText, options.fallbackUrl);
      });
  };
})(window);
