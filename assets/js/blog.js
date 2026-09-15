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
 *    against 0. There is now one `currentPostId`, in one scope.
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
 * Requires sanitize-html.js to be loaded first.
 */
(function (global) {
  'use strict';

  var Sanitize = global.SymptomsSanitize;

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
    var summaryEl = document.getElementById(options.summaryId || 'posts-summary');
    var postEl = document.getElementById(options.postId || 'last_post');
    var moreEl = document.getElementById(options.moreId || 'more_posts');
    if (!postEl) return;

    var strings = options.strings || {};
    var lang = options.lang || 'en';
    var articles = {};        // post id -> the full <article> node
    var currentPostId = null; // one variable, one scope

    // `scroll` is false for the initial render: bringing the post into view is
    // right when the reader picks one, and wrong when the page has just loaded.
    function showPost(id, scroll) {
      Object.keys(articles).forEach(function (key) {
        articles[key].hidden = String(key) !== String(id);
      });
      currentPostId = id;
      if (scroll && postEl.scrollIntoView) postEl.scrollIntoView({ block: 'nearest' });
    }

    function summaryItem(post) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#';
      a.addEventListener('click', function (e) {
        e.preventDefault();
        showPost(post.id, true);
      });

      var article = el('article', 'box post-summary');
      article.appendChild(el('h3', null, Sanitize.toText(post.title && post.title.rendered)));

      var excerpt = el('div', 'text-small');
      excerpt.appendChild(Sanitize.toFragment(post.excerpt && post.excerpt.rendered));
      article.appendChild(excerpt);

      var meta = el('ul', 'meta');
      meta.appendChild(el('li', 'icon fa-clock', formatDate(post.date, lang)));
      article.appendChild(meta);

      a.appendChild(article);
      li.appendChild(a);
      return li;
    }

    function fullPost(post) {
      var article = el('article', 'post');
      article.hidden = true;

      var header = document.createElement('header');
      header.appendChild(el('h2', null, Sanitize.toText(post.title && post.title.rendered)));

      var meta = el('ul', 'meta');
      meta.appendChild(el('li', 'icon fa-clock', formatDate(post.date, lang)));

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

      var section = document.createElement('section');
      var image = featuredImage(post);
      if (image.url) {
        var span = el('span', 'image featured');
        var img = document.createElement('img');
        img.src = image.url;
        img.alt = image.alt;
        img.loading = 'lazy';
        img.decoding = 'async';
        span.appendChild(img);
        section.appendChild(span);
      }
      section.appendChild(Sanitize.toFragment(post.content && post.content.rendered));
      article.appendChild(section);

      return article;
    }

    function card(post) {
      // Two per row from tablet width up, one on a phone.
      var col = el('div', 'col-6 col-6-medium col-12-small');
      // has-link + card-link: the title's click target is stretched over the
      // whole card, with hover and press feedback (custom.css sections 11, 16)
      var section = el('section', 'box feature has-link');

      var image = featuredImage(post);
      if (image.url) {
        var span = el('span', 'image featured');
        var img = document.createElement('img');
        img.src = image.url;
        img.alt = image.alt;
        img.loading = 'lazy';
        img.decoding = 'async';
        span.appendChild(img);
        section.appendChild(span);
      }

      var h3 = document.createElement('h3');
      var titleLink = el('a', 'card-link', Sanitize.toText(post.title && post.title.rendered));
      titleLink.href = '#';
      titleLink.addEventListener('click', function (e) {
        e.preventDefault();
        showPost(post.id, true);
      });
      h3.appendChild(titleLink);
      section.appendChild(h3);

      var excerpt = document.createElement('div');
      excerpt.appendChild(Sanitize.toFragment(post.excerpt && post.excerpt.rendered));
      section.appendChild(excerpt);

      var actions = el('ul', 'actions');
      var actionLi = document.createElement('li');
      var button = el('a', 'button large', strings.readMore || '');
      button.href = '#';
      button.addEventListener('click', function (e) {
        e.preventDefault();
        showPost(post.id, true);
      });
      actionLi.appendChild(button);
      actions.appendChild(actionLi);
      // Inside the card, like the Tools cards: the card is a flex column and
      // the list's auto top margin drops the button to the card's foot, so
      // every button in a row lines up whatever the excerpt's length.
      section.appendChild(actions);

      col.appendChild(section);
      return col;
    }

    notice(postEl, strings.loading || '');
    if (summaryEl) summaryEl.textContent = '';
    if (moreEl) moreEl.textContent = '';

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
        var posts = list.filter(function (p) {
          return p && typeof p === 'object' && p.id != null;
        });
        if (!list.length) {
          notice(postEl, strings.empty || '');
          return;
        }
        if (!posts.length) throw new Error('no usable posts in payload');

        var summaryFrag = document.createDocumentFragment();
        var postsFrag = document.createDocumentFragment();
        var moreFrag = document.createDocumentFragment();

        posts.forEach(function (post, index) {
          if (index < 4) summaryFrag.appendChild(summaryItem(post));
          var article = fullPost(post);
          articles[post.id] = article;
          postsFrag.appendChild(article);
          moreFrag.appendChild(card(post));
        });

        if (summaryEl) summaryEl.appendChild(summaryFrag);
        postEl.textContent = '';
        postEl.appendChild(postsFrag);
        if (moreEl) moreEl.appendChild(moreFrag);

        showPost(posts[0].id, false);
      })
      .catch(function (error) {
        console.error('blog: could not load posts', error);
        notice(postEl, strings.error || '', strings.errorLinkText, options.fallbackUrl);
      });
  };
})(window);
