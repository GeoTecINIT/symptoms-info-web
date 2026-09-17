/*
 * blog.js -- renders /geotecblog from the Realtime Database into the index
 * grid, its pager, the sticky post rail and the article. One copy for both
 * locales; the page passes every user-visible string to initBlog().
 *
 * Requires sanitize-html.js to be loaded first.
 */
(function (global) {
  'use strict';

  var Sanitize = global.SymptomsSanitize;

  var WORDS_PER_MINUTE = 200; // the conventional figure for these estimates

  // Fewer than this and the outline just repeats the post.
  var MIN_HEADINGS_FOR_OUTLINE = 2;

  var POSTS_PER_PAGE = 3; // one full row from 981px up

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== '') node.textContent = text;
    return node;
  }

  function formatDate(value, lang) {
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      return d.toDateString();
    }
  }

  function tagNames(post) {
    var embedded = post._embedded || {};
    var terms = embedded['wp:term'] || [];
    // terms[1] is tags, but the feed does not always carry both lists
    var list = terms[1] || [];
    return list
      .map(function (t) { return Sanitize.toText(t && t.name); })
      .filter(Boolean);
  }

  function featuredImage(post) {
    var embedded = post._embedded || {};
    var media = embedded['wp:featuredmedia'] || [];
    var first = media[0] || {};
    return {
      // the re-hosted copy; source_url is http:// and would be blocked
      url: post.imgurl || null,
      alt: first.title ? Sanitize.toText(first.title.rendered) : '',
    };
  }

  /**
   * Newest first. scheduledSaveBlogPosts appends new *and modified* posts as
   * it meets them, so the feed's own order is not chronological. Unparseable
   * dates sort last rather than poisoning the comparison with NaN.
   */
  function sortByDateDesc(posts) {
    return posts
      .map(function (post, index) {
        var t = Date.parse(post.date);
        return { post: post, index: index, time: isNaN(t) ? -Infinity : t };
      })
      .sort(function (a, b) {
        return b.time - a.time || a.index - b.index;
      })
      .map(function (entry) {
        return entry.post;
      });
  }

  /**
   * One card per post id -- the live feed carries post 6263 twice, with
   * different bodies. The later copy wins, being the more recent write.
   */
  function dedupe(posts) {
    var lastIndexFor = {};
    posts.forEach(function (post, index) {
      lastIndexFor[post.id] = index;
    });
    return posts.filter(function (post, index) {
      return lastIndexFor[post.id] === index;
    });
  }

  /** Whole minutes at WORDS_PER_MINUTE, never zero. */
  function readingMinutes(node) {
    var words = String(node.textContent || '').split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  }

  /**
   * Give every heading in a post body an id and report them. Keyed on the
   * post id because every article is in the DOM at once, so WordPress's own
   * ids could collide -- and the sanitiser drops them anyway.
   */
  function outline(body, postId) {
    var headings = body.querySelectorAll('h2, h3');
    var items = [];
    for (var i = 0; i < headings.length; i++) {
      var heading = headings[i];
      var text = String(heading.textContent || '').trim();
      if (!text) continue;
      heading.id = 'post-' + postId + '-h' + (i + 1);
      items.push({ id: heading.id, text: text, level: heading.tagName.toLowerCase() });
    }
    return items;
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

  global.initBlog = function initBlog(options) {
    var postEl = document.getElementById(options.postId || 'last_post');
    var indexEl = document.getElementById(options.indexId || 'more_posts');
    var railEl = document.getElementById(options.railId || 'post-rail');
    var pagerEl = document.getElementById(options.pagerId || 'post-pager');
    if (!postEl) return;

    var strings = options.strings || {};
    var lang = options.lang || 'en';
    var articles = {};   // post id -> the full <article> node
    var railLinks = {};  // post id -> its link in the rail
    var cardsFor = {};   // post id -> its column in the index grid
    var cards = [];      // every column, in the order the grid shows them
    var pageButtons = [];
    var currentPage = 0;

    function hashFor(id) {
      return '#post-' + id;
    }

    /**
     * Only a bare `#post-<id>` is a post; the outline's `#post-<id>-h<n>`
     * links must fall through to the browser's own anchor handling.
     */
    function idFromHash() {
      var match = /^#post-(\d+)$/.exec(global.location.hash || '');
      return match ? match[1] : null;
    }

    // `scroll` is false on first render: the reader has not asked for a post yet.
    function showPost(id, scroll) {
      id = String(id);
      if (!articles[id]) return false;

      Object.keys(articles).forEach(function (key) {
        articles[key].hidden = key !== id;
      });
      Object.keys(railLinks).forEach(function (key) {
        var current = key === id;
        railLinks[key].className = current ? 'post-rail-link is-current' : 'post-rail-link';
        if (current) railLinks[key].setAttribute('aria-current', 'true');
        else railLinks[key].removeAttribute('aria-current');
      });
      // the card is marked too: on a phone the rail is hidden, so it is the
      // only thing that says which post the article below belongs to
      Object.keys(cardsFor).forEach(function (key) {
        var current = key === id;
        var section = cardsFor[key].firstChild;
        section.className = current
          ? 'box feature has-link post-card is-current'
          : 'box feature has-link post-card';
        if (current) section.setAttribute('aria-current', 'true');
        else section.removeAttribute('aria-current');
      });

      if (scroll && postEl.scrollIntoView) postEl.scrollIntoView({ block: 'start' });
      return true;
    }

    /**
     * The address bar follows, so a post can be linked and Back returns to the
     * previous one. pushState fires no hashchange, so this cannot re-enter.
     */
    function selectPost(id) {
      if (!showPost(id, true)) return;
      if (global.history && global.history.pushState) {
        global.history.pushState(null, '', hashFor(id));
      } else {
        global.location.hash = hashFor(id);
      }
    }

    function openPostOnClick(anchor, id) {
      anchor.href = hashFor(id);
      anchor.addEventListener('click', function (e) {
        // a modified click opens the post in its own tab; the href is real
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        selectPost(id);
      });
    }

    function featuredImageNode(post) {
      var image = featuredImage(post);
      if (!image.url) return null;
      var span = el('span', 'image featured');
      var img = document.createElement('img');
      img.src = image.url;
      img.alt = image.alt;
      img.loading = 'lazy';
      img.decoding = 'async';
      span.appendChild(img);
      return span;
    }

    /** One card in the index grid: date, title, three clamped lines, a cue. */
    function card(post) {
      var col = el('div', 'col-4 col-6-medium col-12-small');
      // has-link + card-link: the title's click target covers the whole card
      var section = el('section', 'box feature has-link post-card');

      // No featured image: three of the nine live posts have none, and a row
      // where one card has a photo and the next has white space reads as
      // broken. It still opens the article.
      section.appendChild(el('p', 'post-card-date', formatDate(post.date, lang)));

      var h3 = document.createElement('h3');
      var titleLink = el('a', 'card-link', Sanitize.toText(post.title && post.title.rendered));
      openPostOnClick(titleLink, post.id);
      h3.appendChild(titleLink);
      section.appendChild(h3);

      // toText: the excerpt is one <p> of prose, clamped to three lines by CSS
      section.appendChild(
        el('p', 'post-card-excerpt', Sanitize.toText(post.excerpt && post.excerpt.rendered))
      );

      // a cue, not a link: the card is already one link, named by its title
      var cue = el('span', 'post-card-cue', strings.readMore || '');
      cue.setAttribute('aria-hidden', 'true');
      section.appendChild(cue);

      col.appendChild(section);
      return col;
    }

    /* Card nodes are built once and moved in and out of the grid, so their
       listeners and the `is-current` mark survive every page change. */

    function pageCount() {
      return Math.ceil(cards.length / POSTS_PER_PAGE);
    }

    function pageOfPost(id) {
      var index = -1;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i] === cardsFor[String(id)]) { index = i; break; }
      }
      return index < 0 ? 0 : Math.floor(index / POSTS_PER_PAGE);
    }

    function showPage(page) {
      var last = pageCount() - 1;
      currentPage = Math.max(0, Math.min(page, last));

      indexEl.textContent = '';
      var frag = document.createDocumentFragment();
      var start = currentPage * POSTS_PER_PAGE;
      for (var i = start; i < start + POSTS_PER_PAGE && i < cards.length; i++) {
        frag.appendChild(cards[i]);
      }
      indexEl.appendChild(frag);

      pageButtons.forEach(function (button) {
        if (button.dataset.role === 'step') {
          // disabled, not hidden: a vanishing control makes the row jump
          button.disabled =
            button.dataset.dir === 'prev' ? currentPage === 0 : currentPage >= last;
          return;
        }
        var current = Number(button.dataset.page) === currentPage;
        button.className = current ? 'post-pager-page is-current' : 'post-pager-page';
        // the standard pagination announcement, so no live region is needed
        if (current) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    }

    function buildPager(pagerEl) {
      var total = pageCount();
      // One page of three or fewer is not a pager, it is three cards.
      if (total < 2) return;

      var nav = el('nav', 'post-pager');
      nav.setAttribute('aria-label', strings.pagerLabel || '');

      function step(dir, label) {
        var button = el('button', 'post-pager-step', label);
        button.type = 'button';
        button.dataset.role = 'step';
        button.dataset.dir = dir;
        button.addEventListener('click', function () {
          showPage(currentPage + (dir === 'prev' ? -1 : 1));
        });
        pageButtons.push(button);
        return button;
      }

      nav.appendChild(step('prev', strings.pagerPrev || ''));

      var list = el('ul', 'post-pager-list');
      for (var i = 0; i < total; i++) {
        (function (page) {
          var item = document.createElement('li');
          var button = el('button', 'post-pager-page', String(page + 1));
          button.type = 'button';
          button.dataset.role = 'page';
          button.dataset.page = String(page);
          // the visible label is a bare numeral; the name says what it means
          button.setAttribute('aria-label', String(strings.pagerPage || '').replace('{n}', page + 1));
          button.addEventListener('click', function () {
            showPage(page);
          });
          pageButtons.push(button);
          item.appendChild(button);
          list.appendChild(item);
        })(i);
      }
      nav.appendChild(list);

      nav.appendChild(step('next', strings.pagerNext || ''));
      pagerEl.appendChild(nav);
    }

    /** The rail: every post, one line each, the open one marked. */
    function buildRail(posts) {
      var nav = el('nav', 'post-rail');
      var title = el('h2', 'post-rail-title', strings.allPosts || '');
      title.id = 'post-rail-title';
      nav.setAttribute('aria-labelledby', title.id);
      nav.appendChild(title);

      var list = el('ul', 'post-rail-list');
      posts.forEach(function (post) {
        var item = document.createElement('li');
        var link = el('a', 'post-rail-link');
        link.appendChild(
          el('span', 'post-rail-link-title', Sanitize.toText(post.title && post.title.rendered))
        );
        link.appendChild(el('span', 'post-rail-link-date', formatDate(post.date, lang)));
        openPostOnClick(link, post.id);
        railLinks[String(post.id)] = link;
        item.appendChild(link);
        list.appendChild(item);
      });

      nav.appendChild(list);
      return nav;
    }

    function buildToc(items, postId) {
      var nav = el('nav', 'post-toc');
      var title = el('h3', 'post-toc-title', strings.inThisPost || '');
      title.id = 'post-' + postId + '-toc';
      nav.setAttribute('aria-labelledby', title.id);
      nav.appendChild(title);

      var list = el('ul', 'post-toc-list');
      items.forEach(function (item) {
        var li = el('li', 'post-toc-item post-toc-' + item.level);
        var link = el('a', null, item.text);
        link.href = '#' + item.id;
        li.appendChild(link);
        list.appendChild(li);
      });

      nav.appendChild(list);
      return nav;
    }

    function fullPost(post) {
      var article = el('article', 'post');
      article.hidden = true;

      // body first: its length is the reading time, its headings the outline
      var body = el('section', 'post-body');
      var image = featuredImageNode(post);
      if (image) body.appendChild(image);
      body.appendChild(Sanitize.toFragment(post.content && post.content.rendered));

      var minutes = readingMinutes(body);
      var headings = outline(body, post.id);

      var header = el('header', 'post-header');
      header.appendChild(el('h2', null, Sanitize.toText(post.title && post.title.rendered)));

      var meta = el('ul', 'meta');
      meta.appendChild(el('li', 'icon fa-clock', formatDate(post.date, lang)));
      // `solid`: fa-book-open exists only in Font Awesome's Solid face, and
      // .icon:before asks for Regular, where it would draw nothing
      meta.appendChild(
        el('li', 'icon solid fa-book-open', String(strings.readingTime || '').replace('{n}', minutes))
      );

      var tags = tagNames(post);
      if (tags.length) meta.appendChild(el('li', 'icon fa-comments', tags.join('; ')));

      var link = Sanitize.safeUrl(post.link);
      if (link) {
        var li = el('li', 'icon solid fa-link'); // Solid-only glyph, as above
        var a = el('a', null, strings.seeOriginal || '');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
        meta.appendChild(li);
      }
      header.appendChild(meta);
      article.appendChild(header);

      if (headings.length >= MIN_HEADINGS_FOR_OUTLINE) {
        article.appendChild(buildToc(headings, post.id));
      }
      article.appendChild(body);

      // the way back out; on a phone the only one, since the rail is hidden
      if (indexEl) {
        var footer = el('footer', 'post-footer');
        var back = el('a', 'post-back', strings.backToPosts || '');
        back.href = '#' + indexEl.id;
        back.addEventListener('click', function (e) {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          if (indexEl.scrollIntoView) indexEl.scrollIntoView({ block: 'start' });
        });
        footer.appendChild(back);
        article.appendChild(footer);
      }

      return article;
    }

    notice(postEl, strings.loading || '');
    if (indexEl) indexEl.textContent = '';
    if (railEl) railEl.textContent = '';
    if (pagerEl) pagerEl.textContent = '';

    fetch(options.endpoint)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        // RTDB returns an object keyed by index if the list is ever sparse
        var list = Array.isArray(data)
          ? data
          : data && typeof data === 'object'
          ? Object.values(data)
          : null;
        if (!list) throw new Error('unexpected payload shape');

        // an empty feed and an unusable one are different problems: saying
        // "no posts yet" for the second would hide a broken pipeline
        var posts = dedupe(sortByDateDesc(list.filter(function (p) {
          return p && typeof p === 'object' && p.id != null;
        })));
        if (!list.length) {
          notice(postEl, strings.empty || '');
          return;
        }
        if (!posts.length) throw new Error('no usable posts in payload');

        var postsFrag = document.createDocumentFragment();

        posts.forEach(function (post) {
          var article = fullPost(post);
          articles[String(post.id)] = article;
          postsFrag.appendChild(article);
          var col = card(post);
          cardsFor[String(post.id)] = col;
          cards.push(col);
        });

        postEl.textContent = '';
        postEl.appendChild(postsFrag);
        if (railEl) railEl.appendChild(buildRail(posts));

        // no pager element: show everything rather than hide posts behind a
        // control that does not exist
        if (indexEl && pagerEl) buildPager(pagerEl);
        else if (indexEl) cards.forEach(function (col) { indexEl.appendChild(col); });

        // a #post-<id> in the bar wins over "the newest one"; an id no longer
        // in the feed falls back rather than showing nothing
        var wanted = idFromHash();
        var opened = wanted && articles[wanted] ? wanted : String(posts[0].id);

        // open on the page holding what is being read; after that the pager
        // belongs to the reader and picking a post never moves it
        if (indexEl && pagerEl) showPage(pageOfPost(opened));
        showPost(opened, opened === wanted);

        // Back and forward between posts, and a hash pasted into the bar.
        global.addEventListener('hashchange', function () {
          var id = idFromHash();
          if (id) showPost(id, true);
        });
      })
      .catch(function (error) {
        console.error('blog: could not load posts', error);
        notice(postEl, strings.error || '', strings.errorLinkText, options.fallbackUrl);
      });
  };
})(window);
