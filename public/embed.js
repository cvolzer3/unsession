/**
 * Unsession embed loader — the one-line "styled HTML" embed format.
 *
 *   <script src="https://unsession.dev/embed.js"
 *           data-unsession="https://unsession.dev/<event>/embed/sessions?eid=..."
 *           data-height="800"></script>
 *
 * Replaces itself with an iframe of the widget URL in data-unsession. Classic
 * script (not a module) so document.currentScript works and the snippet stays
 * a single line on any host page.
 */
(function () {
  var s = document.currentScript;
  if (!s) return;
  var src = s.getAttribute('data-unsession');
  if (!src) return;
  var f = document.createElement('iframe');
  f.src = src;
  f.title = s.getAttribute('data-title') || 'Event widget';
  f.loading = 'lazy';
  f.style.cssText =
    'width:100%;border:0;display:block;height:' + (parseInt(s.getAttribute('data-height'), 10) || 800) + 'px;';
  s.parentNode.insertBefore(f, s);
})();
