/* Magyx Bundle fixed bundle: stamp "Item N" properties onto the bundle's own
   cart line, and — for a bundle with more than one package — switch the
   active package tab/panel and the variant submitted by the theme's native
   product form. */
(function () {
  "use strict";

  function readData(root) {
    var script = root.querySelector("[data-magyx-bundle-data]");
    if (!script) return null;
    try {
      return JSON.parse(script.textContent);
    } catch (e) {
      return null;
    }
  }

  // The cart-add form's hidden "id" field and Liquid's `variant.id` are plain
  // numeric ids; the metafield carries GraphQL GIDs. Stripping non-digits
  // normalizes both to the same comparable value.
  function numericId(id) {
    return String(id || "").replace(/\D/g, "");
  }

  function buildProperties(items) {
    return items.map(function (item, index) {
      var value = item.quantity > 1 ? item.quantity + " × " + item.title : item.title;
      if (item.isGift) value += " (Free gift)";
      return { key: "Item " + (index + 1), value: value };
    });
  }

  function injectProperties(form, properties) {
    form.querySelectorAll("[data-magyx-bundle-property]").forEach(function (el) {
      el.remove();
    });
    properties.forEach(function (property) {
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = "properties[" + property.key + "]";
      input.value = property.value;
      input.setAttribute("data-magyx-bundle-property", "");
      form.appendChild(input);
    });
  }

  function selectPackage(root, packages, index) {
    root.querySelectorAll("[data-magyx-pack-tab]").forEach(function (tab) {
      var active = tab.getAttribute("data-magyx-pack-tab") === String(index);
      tab.classList.toggle("magyx-bundle-contents__pack-tab--active", active);
      tab.setAttribute("aria-pressed", active ? "true" : "false");
    });
    root.querySelectorAll("[data-magyx-pack-panel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-magyx-pack-panel") !== String(index);
    });

    var pkg = packages[index];
    if (!pkg) return;
    var form = document.querySelector('form[action*="/cart/add"]');
    if (!form) return;
    var idField = form.elements["id"];
    if (idField && pkg.variantId) {
      idField.value = numericId(pkg.variantId);
      idField.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function init(root) {
    var data = readData(root);
    if (!data || !Array.isArray(data.packages) || data.packages.length === 0) return;

    var packages = data.packages;
    var variantIds = packages.map(function (pkg) {
      return numericId(pkg.variantId);
    });
    var propertiesByVariantId = {};
    packages.forEach(function (pkg) {
      propertiesByVariantId[numericId(pkg.variantId)] = buildProperties(pkg.items || []);
    });

    document.addEventListener(
      "submit",
      function (event) {
        var form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (!/\/cart\/add/.test(form.action)) return;
        var idField = form.elements["id"];
        var variantId = idField ? numericId(idField.value) : null;
        if (!variantId || variantIds.indexOf(variantId) === -1) return;
        injectProperties(form, propertiesByVariantId[variantId] || []);
      },
      true,
    );

    root.querySelectorAll("[data-magyx-pack-tab]").forEach(function (tab) {
      tab.addEventListener("click", function () {
        var index = parseInt(tab.getAttribute("data-magyx-pack-tab"), 10);
        selectPackage(root, packages, index);
      });
    });
  }

  function boot() {
    document.querySelectorAll(".magyx-bundle-contents").forEach(init);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
