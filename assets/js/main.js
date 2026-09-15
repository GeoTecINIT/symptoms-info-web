/*
	TXT by HTML5 UP
	html5up.net | @ajlkn
	Free for personal and commercial use under the CCA 3.0 license (html5up.net/license)
*/

(function($) {
  var $window = $(window),
    $body = $('body'),
    $nav = $('#nav');

  // Breakpoints.
  breakpoints({
    xlarge: ['1281px', '1680px'],
    large: ['981px', '1280px'],
    medium: ['737px', '980px'],
    small: ['361px', '736px'],
    xsmall: [null, '360px']
  });

  // Play initial animations on page load.
  $window.on('load', function() {
    window.setTimeout(function() {
      $body.removeClass('is-preload');
    }, 100);
  });

  // Dropdowns.
  $('#nav > ul').dropotron({
    mode: 'fade',
    noOpenerFade: true,
    speed: 300,
    alignment: 'center'
  });

  // Scrolly
  $('.scrolly').scrolly({
    speed: 1000,
    offset: function() {
      return $nav.height() - 5;
    }
  });

  // Nav.

  //Title Bar.
  // The logo is a link home here too (it used to be a bare copy of the image,
  // so tapping it did nothing), and the language switcher is copied into the
  // right-hand corner so it is reachable without opening the panel. Both are
  // built from the desktop markup, so the hrefs and the current-language
  // class come from the build as everywhere else.
  var $logo = $('#logo');

  $(
    '<div id="titleBar">' +
      '<a href="#navPanel" class="toggle"></a>' +
      '<span class="title">' +
      '<a href="' + $logo.attr('href') + '">' + $logo.find('img').prop('outerHTML') + '</a>' +
      '</span>' +
      '<ul class="title-lang">' +
      $nav.find('.menu-lang').html() +
      '</ul>' +
      '</div>'
  ).appendTo($body);

  // Panel.
  // The pages and the language switcher are built into two groups, so the
  // languages can sit apart at the foot of the panel (custom.css section 6).
  // Main links first, then languages: the same document order as #nav, which
  // the class re-application below relies on.
  var $navPanel = $(
    '<div id="navPanel">' +
      '<nav>' +
      '<div class="panel-main">' + $nav.find('.menu-main').navList() + '</div>' +
      '<div class="panel-lang">' + $nav.find('.menu-lang').navList() + '</div>' +
      '</nav>' +
      '</div>'
  )
    .appendTo($body)
    .panel({
      delay: 500,
      hideOnClick: true,
      hideOnSwipe: true,
      resetScroll: true,
      resetForms: true,
      side: 'left',
      target: $body,
      visibleClass: 'navPanel-visible'
    });

  // navList() rebuilds the panel from the anchors' text alone and drops
  // every class, so on a phone neither the current page nor the active
  // language was distinguishable. Re-apply both: navList() emits one link
  // per #nav anchor in document order, so the lists line up by index.
  var $navLinks = $nav.find('a'),
    $panelLinks = $navPanel.find('a.link');

  $navLinks.each(function(i) {
    var $item = $(this).closest('li'),
      $target = $panelLinks.eq(i);

    if (!$target.length) return;
    if ($item.hasClass('current')) $target.addClass('current');
    if ($item.hasClass('lang-disabled')) $target.addClass('lang-current');
  });

  // Panel width: as wide as the longest label plus its padding, not the
  // template's fixed 275px (custom.css section 6). CSS cannot size the panel to
  // its content AND slide the page by that same amount, so it is measured here
  // and handed to the stylesheet as --nav-panel-width. Measured again once the
  // webfonts have loaded (the condensed face is much narrower than the
  // fallback), and on resize, because the panel is display:none above 980px and
  // measures 0 there.
  function sizeNavPanel() {
    var panel = $navPanel[0];
    panel.style.width = 'max-content';
    var width = Math.ceil(panel.getBoundingClientRect().width);
    panel.style.width = '';
    if (width > 0) document.documentElement.style.setProperty('--nav-panel-width', width + 'px');
  }

  sizeNavPanel();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizeNavPanel);
  $window.on('resize', sizeNavPanel);

  // Press feedback on touch screens. Cards and buttons show a brief press-in
  // through CSS :active (custom.css section 16), which is the only feedback a
  // phone gets -- it has no hover. iOS Safari does not apply :active at all
  // unless a touchstart listener exists; an empty passive one is enough and
  // costs nothing, since it never blocks scrolling.
  document.addEventListener('touchstart', function() {}, { passive: true });
})(jQuery);
