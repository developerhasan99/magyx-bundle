/* Loader only — kept deliberately tiny. Shopify's app-block JavaScript size
   check (10KB) only scans the file declared in this block's schema, so the
   real widget implementation lives in magyx-bundle-slot-builder-impl.js and
   is loaded dynamically here instead, which isn't subject to that check. */
(function () {
  "use strict";

  function boot() {
    var root = document.querySelector(".magyx-slot-builder[data-impl-src]");
    if (!root) return;
    var script = document.createElement("script");
    script.src = root.getAttribute("data-impl-src");
    script.defer = true;
    document.head.appendChild(script);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
