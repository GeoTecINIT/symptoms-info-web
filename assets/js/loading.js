/* Marks images in #main that are still loading, so custom.css can show a
   placeholder behind them. The mark comes off on load or error, so a
   transparent image never keeps the tint. Also watches #main for images
   added later: blog.js builds its posts after its fetch. */
(function () {
  var main = document.getElementById('main');
  if (!main) return;

  function done(e) {
    var img = e.target;
    img.classList.remove('is-loading');
    img.removeEventListener('load', done);
    img.removeEventListener('error', done);
  }

  function track(img) {
    // complete is also true for a failed image; leave that one unmarked
    if (img.complete) return;
    img.classList.add('is-loading');
    img.addEventListener('load', done);
    img.addEventListener('error', done);
  }

  Array.prototype.forEach.call(main.querySelectorAll('img'), track);

  if (!window.MutationObserver) return;
  new MutationObserver(function (records) {
    records.forEach(function (record) {
      Array.prototype.forEach.call(record.addedNodes, function (node) {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'IMG') track(node);
        else Array.prototype.forEach.call(node.querySelectorAll('img'), track);
      });
    });
  }).observe(main, { childList: true, subtree: true });
})();
