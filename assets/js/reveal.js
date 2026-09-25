/* Fades blocks marked data-reveal in as they scroll into view, on any page.
   Anything whose top has reached the fold is revealed, including blocks
   scrolled straight past, so a jump or a fast fling never strands one
   hidden. Blocks already on screen at load are left alone (no flash), and
   under reduced motion none of this runs. */
(function () {
  if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var FOLD = 0.92;
  var STAGGER_MS = 90;
  var queued = false;
  var pending = Array.prototype.filter.call(document.querySelectorAll('[data-reveal]'), function (node) {
    return node.getBoundingClientRect().top > window.innerHeight * FOLD;
  });
  if (!pending.length) return;

  function check() {
    queued = false;
    var fold = window.innerHeight * FOLD;
    var shown = 0;
    pending = pending.filter(function (node) {
      if (node.getBoundingClientRect().top > fold) return true;
      // cards revealed together arrive left to right, not all at once
      node.style.transitionDelay = Math.min(shown, 3) * STAGGER_MS + 'ms';
      node.classList.add('is-revealed');
      shown++;
      return false;
    });
    if (!pending.length) {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(check);
  }

  pending.forEach(function (node) {
    node.classList.add('will-reveal');
  });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
})();
