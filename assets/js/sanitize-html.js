/*
 * sanitize-html.js -- a small allowlist sanitiser for the WordPress content
 * rendered on blog.html.
 *
 * Why this exists: blog post bodies, excerpts and titles
 * come from geotec.uji.es over the Realtime Database and used to be pasted
 * straight into innerHTML by string concatenation. WordPress is trusted today,
 * so that was a latent rather than an active hole -- but a single malicious or
 * compromised post would have executed script on this origin.
 *
 * Two entry points, because the data needs two different treatments:
 *
 *   toText(html)      -- for anything that is *not* meant to carry markup:
 *                        post titles, tag names, BibTeX fields. Decodes the
 *                        entities WordPress emits (&#8217;, &amp;) and throws
 *                        every tag away. Use with textContent.
 *
 *   toFragment(html)  -- for post bodies and excerpts, which genuinely are
 *                        HTML. Walks the parsed tree and keeps only allowlisted
 *                        elements and attributes.
 *
 * No dependencies, per the standing rule for this repo -- DOMPurify would be
 * the obvious choice otherwise and is worth revisiting if this ever needs to
 * handle untrusted input rather than merely careless input.
 *
 * Parsing note: DOMParser with "text/html" builds an inert document. Scripts in
 * it never run and <img onerror> never fires, so it is safe to *parse* hostile
 * markup here -- what matters is that nothing hostile survives into the live
 * document, which is what the allowlist below is for.
 */
(function (global) {
  'use strict';

  // Kept deliberately tight: this is what GEOTEC's posts actually use, checked
  // against the live feed, plus the obvious relatives. Anything not listed is
  // unwrapped (children kept, element dropped) rather than deleted, so an
  // unexpected wrapper cannot silently swallow a paragraph of text.
  var ALLOWED_TAGS = {
    A: ['href', 'title'],
    ABBR: ['title'],
    BLOCKQUOTE: [],
    BR: [],
    CAPTION: [],
    CODE: [],
    DIV: [],
    EM: [],
    FIGCAPTION: [],
    FIGURE: [],
    H2: [], H3: [], H4: [], H5: [], H6: [],
    HR: [],
    I: [],
    IMG: ['src', 'alt', 'width', 'height'],
    LI: [],
    OL: [],
    P: [],
    PRE: [],
    SPAN: [],
    STRONG: [],
    SUB: [],
    SUP: [],
    TABLE: [], TBODY: [], TD: [], TH: [], THEAD: [], TR: [],
    UL: [],
  };

  // Elements whose *contents* are as dangerous as the element, so unwrapping
  // them would be wrong -- drop them whole.
  var DROP_ENTIRELY = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  function parse(html) {
    return new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
  }

  /**
   * Decode entities and drop all markup.
   *
   * The DROP_ENTIRELY elements are removed before reading textContent, not for
   * safety -- the result is only ever assigned to textContent and cannot
   * execute -- but for correctness: textContent happily returns the *contents*
   * of a <script> or <style>, so without this a title containing markup would
   * render its own source code as visible text.
   */
  function toText(html) {
    var body = parse(html).body;
    var junk = body.querySelectorAll(Object.keys(DROP_ENTIRELY).join(','));
    for (var i = 0; i < junk.length; i++) junk[i].parentNode.removeChild(junk[i]);
    return body.textContent.trim();
  }

  /**
   * A URL is safe if it resolves to http(s) or is a plain relative path.
   * Blocks javascript:, data: and vbscript: including the whitespace- and
   * entity-obfuscated spellings, because the URL constructor normalises them.
   */
  function safeUrl(value) {
    if (!value) return null;
    var url;
    try {
      url = new URL(value, global.location ? global.location.href : 'https://example.invalid');
    } catch (e) {
      return null;
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  }

  function clean(node, doc) {
    var children = Array.prototype.slice.call(node.childNodes);
    for (var i = 0; i < children.length; i++) {
      var child = children[i];

      if (child.nodeType === 3) continue;             // text: always fine
      if (child.nodeType !== 1) {                     // comments, CDATA, ...
        node.removeChild(child);
        continue;
      }

      var tag = child.tagName.toUpperCase();

      if (DROP_ENTIRELY[tag]) {
        node.removeChild(child);
        continue;
      }

      clean(child, doc);

      if (!Object.prototype.hasOwnProperty.call(ALLOWED_TAGS, tag)) {
        // Unwrap: keep the text, lose the element.
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        continue;
      }

      var allowedAttrs = ALLOWED_TAGS[tag];
      var attrs = Array.prototype.slice.call(child.attributes);
      for (var j = 0; j < attrs.length; j++) {
        var name = attrs[j].name.toLowerCase();
        var value = attrs[j].value;

        if (allowedAttrs.indexOf(name) === -1) {
          child.removeAttribute(attrs[j].name);
          continue;
        }
        if (name === 'href' || name === 'src') {
          var url = safeUrl(value);
          if (url === null) child.removeAttribute(attrs[j].name);
          else child.setAttribute(name, url);
        }
      }

      // Outbound links in post bodies open in a new tab; give them the same
      // rel="noopener noreferrer" as every other new-tab link on the site.
      if (tag === 'A' && child.getAttribute('href')) {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      if (tag === 'IMG') {
        child.setAttribute('loading', 'lazy');
        child.setAttribute('decoding', 'async');
        if (!child.getAttribute('src')) node.removeChild(child);
      }
    }
  }

  /** Sanitise `html` and return a DocumentFragment ready to append. */
  function toFragment(html) {
    var doc = parse(html);
    clean(doc.body, doc);
    var frag = document.createDocumentFragment();
    while (doc.body.firstChild) frag.appendChild(doc.body.firstChild);
    return frag;
  }

  global.SymptomsSanitize = { toText: toText, toFragment: toFragment, safeUrl: safeUrl };
})(window);
