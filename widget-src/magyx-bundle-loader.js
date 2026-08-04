/* The only JavaScript declared by the product-page block's schema, and so the
   only file Shopify's 10KB app-block size check scans. Its whole job is to
   pull in the implementation for whichever widget the block's Liquid actually
   rendered — Build a Box, Fixed Bundle, or Quantity Breaks — none of which
   fit under that limit, and only one of which is ever on the page.

   Each implementation self-boots and guards on document.readyState, so it
   doesn't matter that these scripts arrive after DOM ready. */
(function () {
  "use strict";

  var requested = {};

  function load(src) {
    // Deduped by URL: a merchant who adds the block twice to one template
    // would otherwise run an implementation's boot twice over the same DOM.
    if (!src || requested[src]) return;
    requested[src] = true;
    var script = document.createElement("script");
    script.src = src;
    script.defer = true;
    document.head.appendChild(script);
  }

  function boot() {
    document.querySelectorAll("[data-magyx-impl-src]").forEach(function (root) {
      load(root.getAttribute("data-magyx-impl-src"));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
