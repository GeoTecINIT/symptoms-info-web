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

  // Title bar. Logo and language switcher are copied from the desktop markup,
  // so their hrefs and the current-language class come from the build.
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

  // Panel. Two groups, so the languages can sit at the foot of it. Main links
  // first, in #nav's document order, which the class re-application relies on.
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

  // navList() drops every class, so re-apply the two that matter. It emits
  // one link per #nav anchor in document order, so the lists line up by index.
  var $navLinks = $nav.find('a'),
    $panelLinks = $navPanel.find('a.link');

  $navLinks.each(function(i) {
    var $item = $(this).closest('li'),
      $target = $panelLinks.eq(i);

    if (!$target.length) return;
    if ($item.hasClass('current')) $target.addClass('current');
    if ($item.hasClass('lang-disabled')) $target.addClass('lang-current');
  });

  // Panel width: CSS can size the panel to its content but cannot then slide
  // the page by that same amount, so it is measured here and handed over as
  // --nav-panel-width. Re-measured after the webfonts load and on resize,
  // where the panel is display:none above 980px and measures 0.
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

  // iOS Safari does not apply :active -- the only press feedback a phone gets
  // -- unless a touchstart listener exists. An empty passive one is enough.
  document.addEventListener('touchstart', function() {}, { passive: true });
})(jQuery);
