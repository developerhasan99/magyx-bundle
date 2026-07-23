/* Magyx Bundle fixed bundle: stamp "Item N" properties onto the bundle's own cart line */
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

  function buildProperties(data) {
    return data.items.map(function (item, index) {
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

  function init(root) {
    var data = readData(root);
    if (!data || !Array.isArray(data.items) || data.items.length === 0) return;
    if (!Array.isArray(data.variantIds) || data.variantIds.length === 0) return;

    var variantIds = data.variantIds.map(String);
    var properties = buildProperties(data);

    document.addEventListener(
      "submit",
      function (event) {
        var form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (!/\/cart\/add/.test(form.action)) return;
        var idField = form.elements["id"];
        var variantId = idField ? String(idField.value) : null;
        if (!variantId || variantIds.indexOf(variantId) === -1) return;
        injectProperties(form, properties);
      },
      true,
    );
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
