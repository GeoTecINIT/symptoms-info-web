/*
 * sanitize-html.js -- allowlist sanitiser for the WordPress content rendered
 * on blog.html, which used to go straight into innerHTML.
 *
 *   toText(html)      decodes entities and drops all markup -- titles, tag
 *                     names, BibTeX fields. Use with textContent.
 *   toFragment(html)  keeps allowlisted elements and attributes -- post
 *                     bodies and excerpts, which genuinely are HTML.
 *
 * No dependencies, per the standing rule for this repo; DOMPurify would be
 * the obvious choice if this ever had to handle hostile rather than careless
 * input. DOMParser builds an inert document, so parsing is safe either way.
 */
(function (global) {
  'use strict';

  // What GEOTEC's posts actually use, plus the obvious relatives. Anything
  // not listed is unwrapped rather than deleted, so an unexpected wrapper
  // cannot silently swallow a paragraph of text.
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
   * Decode entities and drop all markup. DROP_ENTIRELY goes first for
   * correctness, not safety: textContent returns the *contents* of a <script>
   * or <style>, which would render as visible source.
   */
  function toText(html) {
    var body = parse(html).body;
    var junk = body.querySelectorAll(Object.keys(DROP_ENTIRELY).join(','));
    for (var i = 0; i < junk.length; i++) junk[i].parentNode.removeChild(junk[i]);
    return body.textContent.trim();
  }

  /**
   * Safe if it resolves to http(s). The URL constructor normalises the
   * obfuscated spellings of javascript:, data: and vbscript: too.
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
