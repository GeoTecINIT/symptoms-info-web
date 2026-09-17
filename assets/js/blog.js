/*
 * blog.js -- renders /geotecblog from the Realtime Database.
 *
 * Extracted from ~190 lines of inline script duplicated byte-for-byte between
 * blog.html and es/blog.html. Call initBlog() from the page;
 * every user-visible string is passed in.
 *
 * What changed on extraction:
 *  - One copy instead of two. The old copies being identical meant the
 *    Spanish page rendered "See original post" and "Read more" in English;
 *    those are now locale strings.
 *  - `last_displayed_post` was declared at outer scope AND again inside
 *    getText, shadowing it. displayPost() read the outer one while being
 *    called with the inner -- it only worked because hidePost() guarded
 *    against 0. There is one `showPost(id)` and one `articles` map now.
 *  - No try/catch, no response.ok, no empty state. A failed fetch left
 *    three blank containers. Now the page always ends in list, empty
 *    notice, or error notice with a link to the GEOTEC blog.
 *  - Post titles, tag names and dates were concatenated into HTML strings
 *    from the WordPress API. Titles and tags are set with textContent
 *    (via sanitize-html's toText, which decodes &#8217; and friends);
 *    bodies and excerpts, which really are HTML, go through an allowlist
 *    sanitiser. The old markup also built `onclick="displayPost(<id>)"`
 *    attributes out of feed data -- those are event listeners now, so
 *    nothing from the feed is ever parsed as code.
 *
 * 2026-09-16, first pass: the card grid moved to the top of the page, and
 * posts are sorted newest first and deduplicated by id (sortByDateDesc,
 * dedupe) rather than trusting the feed's order.
 *
 * 2026-09-16, second pass -- the page is an index and a reader, not three
 * lists of the same nine posts:
 *  - The "Recent Posts" sidebar is gone. It showed four of the nine posts,
 *    with the same excerpt as the card above it, and it wrapped a whole
 *    <article> in an <a>, which nests a link inside the excerpt's own links.
 *    In its place buildRail() renders every post as one compact link, title
 *    and date, marking the one on screen. It is the only way to move between
 *    posts without leaving the one you are reading.
 *  - The cards lost their "Read more" button (a second link to the same
 *    place as the card, which the site's own rule forbids) and their excerpt
 *    is plain text clamped by CSS, so nine of them are a grid you can scan
 *    rather than a wall you scroll.
 *  - An article now says how long it is (readingMinutes) and, when it has
 *    the structure for it, carries its own outline (outline(), buildToc()).
 *    The newest post is 1,806 words in five sections; that is the one this
 *    is for.
 *  - A post is addressable: `#post-<id>` opens it, Back returns to the
 *    previous one. Until now no post on this site could be linked to at all.
 *
 * 2026-09-17: the index is paged, three cards at a time (POSTS_PER_PAGE).
 * Nine cards filled the screen and pushed the article the reader had just
 * picked below the fold. The card nodes are built once and moved between
 * pages, never rebuilt, so their listeners and their `is-current` mark
 * survive; the index opens on the page holding whatever is being read, and
 * after that the pager belongs to the reader.
 *
 * Requires sanitize-html.js to be loaded first.
 */
(function (global) {
  'use strict';

  var Sanitize = global.SymptomsSanitize;

  // Adult silent reading of prose sits around 220-260 wpm; 200 is the
  // conventional figure for these estimates and errs towards over-stating the
  // time, which is the kinder direction to be wrong in.
  var WORDS_PER_MINUTE = 200;

  // Below this, an outline is noise: it would repeat most of the post.
  var MIN_HEADINGS_FOR_OUTLINE = 2;

  // Nine cards filled the screen and pushed the article the reader had just
  // chosen below the fold (owner, 2026-09-17). Three is one full row from
  // 981px up, and the number the owner asked for.
  var POSTS_PER_PAGE = 3;

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
    // terms[0] is categories, terms[1] is tags -- but the feed is not
    // guaranteed to carry both, and the old code indexed [1] unguarded.
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
      // imgurl is the re-hosted copy written by the Cloud Functions; the
      // original source_url is http:// and would be blocked as mixed content.
      url: post.imgurl || null,
      alt: first.title ? Sanitize.toText(first.title.rendered) : '',
    };
  }

  /**
   * Newest first. The feed happens to arrive in that order today, but nothing
   * in the pipeline guarantees it: scheduledSaveBlogPosts appends new and
   * modified posts to /geotecblog as it meets them, so a post edited in
   * WordPress lands after posts published later than it. The cards are the
   * first thing on the page, so their order is the page's order.
   *
   * A post with an unparseable date sorts last rather than poisoning the
   * comparison with NaN, which would leave the order dependent on the sort's
   * pivot choices.
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
   * One card per post id. The live feed carries post 6263 twice, with
   * different bodies -- the same post saved once and then again after it was
   * edited -- which rendered two identical-looking cards whose `articles[id]`
   * entries collided, so the first card opened the second card's article.
   * The later copy wins: the function appends as it re-fetches, so the one
   * further down the list is the one written most recently.
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
   * Give every heading in a post body an id and report them, so the article
   * can carry its own outline.
   *
   * The ids are assigned here rather than kept from WordPress because the
   * sanitiser drops `id` (it is not in the allowlist) -- which is what we
   * want: every article is in the DOM at once, only one of them visible, so
   * two posts sharing a WordPress slug would otherwise collide. Keying on the
   * post id cannot.
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
     * Only a bare `#post-<id>` is a post. The outline's links are
     * `#post-<id>-h<n>` and must fall through to the browser's own anchor
     * handling, which is why this anchors both ends of the pattern.
     */
    function idFromHash() {
      var match = /^#post-(\d+)$/.exec(global.location.hash || '');
      return match ? match[1] : null;
    }

    // `scroll` is false for the initial render of a plain visit: bringing the
    // article into view is right when the reader picks a post, and wrong when
    // the page has just loaded and they have not asked for anything yet.
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
      // The card is marked too, not just the rail: the rail is hidden below
      // 981px, so on a phone the card is the only thing that can say which
      // post the article underneath belongs to.
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
     * Picking a post from the grid or the rail. The address bar follows, so
     * the post can be linked and shared and Back returns to the previous one.
     * pushState fires neither `hashchange` nor `popstate`, so this cannot
     * re-enter through the listener below.
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
        // Let a modified click open the post in its own tab: the href is a
        // real address now, so that works.
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

    /** One card in the index grid: image, date, title, three lines, a cue. */
    function card(post) {
      // Three per row from 981px up, two on a tablet, one on a phone: with
      // the button and the full excerpt gone a card is short enough to fit.
      var col = el('div', 'col-4 col-6-medium col-12-small');
      // has-link + card-link: the title's click target is stretched over the
      // whole card, with hover and press feedback (custom.css sections 11, 16)
      var section = el('section', 'box feature has-link post-card');

      // No featured image here, deliberately: three of the nine live posts
      // have none -- including the two most recent -- and a row of cards where
      // one has a photo and its neighbour has 250px of white reads as broken
      // rather than as varied. The image still opens the article, which is
      // where it earns its download. If every post gets a featured image in
      // WordPress, this is four lines to put back.
      section.appendChild(el('p', 'post-card-date', formatDate(post.date, lang)));

      var h3 = document.createElement('h3');
      var titleLink = el('a', 'card-link', Sanitize.toText(post.title && post.title.rendered));
      openPostOnClick(titleLink, post.id);
      h3.appendChild(titleLink);
      section.appendChild(h3);

      // toText, not toFragment: a WordPress excerpt is one <p> of prose that
      // the card clamps to three lines, so there is no markup worth keeping,
      // and the trailing "[...]" it ends with is the truncation mark.
      section.appendChild(
        el('p', 'post-card-excerpt', Sanitize.toText(post.excerpt && post.excerpt.rendered))
      );

      // A cue, not a second link: the whole card already goes there, and the
      // title is the link's accessible name. aria-hidden keeps a screen
      // reader from announcing a "Read more" that is not operable.
      var cue = el('span', 'post-card-cue', strings.readMore || '');
      cue.setAttribute('aria-hidden', 'true');
      section.appendChild(cue);

      col.appendChild(section);
      return col;
    }

    /* --- paging the index ---------------------------------------------------
       The card nodes are built once and moved in and out of the grid, so a
       card's listeners, and the `is-current` mark showPost() puts on it,
       survive every page change. Rebuilding them per page would rewire nine
       listeners for every click and drop the mark on the way. */

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
          // Disabled rather than hidden: a control that vanishes at the ends
          // makes the row jump and moves the other buttons under the cursor.
          button.disabled =
            button.dataset.dir === 'prev' ? currentPage === 0 : currentPage >= last;
          return;
        }
        var current = Number(button.dataset.page) === currentPage;
        button.className = current ? 'post-pager-page is-current' : 'post-pager-page';
        // aria-current="page" is what a screen reader reads back as "current
        // page" in a pagination list; it is the whole announcement, so the
        // control needs no live region.
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
          // The visible label is a bare numeral; the accessible name says
          // what the numeral means.
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

      // The body is built first: its length is the reading time and its
      // headings are the outline, and both belong above it in the article.
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
      meta.appendChild(
        el('li', 'icon fa-book-open', String(strings.readingTime || '').replace('{n}', minutes))
      );

      var tags = tagNames(post);
      if (tags.length) meta.appendChild(el('li', 'icon fa-comments', tags.join('; ')));

      var link = Sanitize.safeUrl(post.link);
      if (link) {
        var li = el('li', 'icon fa-link');
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

      // The way back out of a long post. On a phone this is the only one:
      // the rail is a desktop affordance and the grid is a long way up.
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
        // RTDB returns an array here, but returns an object keyed by index if
        // the list is ever sparse -- normalise so neither shape breaks.
        var list = Array.isArray(data)
          ? data
          : data && typeof data === 'object'
          ? Object.values(data)
          : null;
        if (!list) throw new Error('unexpected payload shape');

        // A genuinely empty feed and a feed full of junk are different
        // problems, and saying "no posts yet" for the second one would hide a
        // broken pipeline behind a reassuring message.
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

        // Without a pager element there is nothing to page with, so the grid
        // shows everything rather than silently hiding six posts behind a
        // control that does not exist.
        if (indexEl && pagerEl) buildPager(pagerEl);
        else if (indexEl) cards.forEach(function (col) { indexEl.appendChild(col); });

        // A `#post-<id>` in the address bar wins over "the newest one", so a
        // shared link opens what it says and scrolls to it. An id that is no
        // longer in the feed falls back rather than showing nothing.
        var wanted = idFromHash();
        var opened = wanted && articles[wanted] ? wanted : String(posts[0].id);

        // The index opens on the page holding whatever is being read, so a
        // deep link does not land with three unrelated cards above it. After
        // that the pager is the reader's: picking a post never moves it,
        // because a grid that jumped under the cursor on every rail click
        // would be worse than one that stays put.
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
