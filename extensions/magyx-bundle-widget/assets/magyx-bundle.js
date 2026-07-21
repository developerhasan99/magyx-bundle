/* Magyx Bundle mix & match widget */
(function () {
  "use strict";

  function formatMoney(amount, format) {
    var value = (Math.round(amount * 100) / 100).toFixed(2);
    if (!format) return "$" + value;
    return format
      .replace(/\{\{\s*amount\s*\}\}/, value)
      .replace(/\{\{\s*amount_no_decimals\s*\}\}/, String(Math.round(amount)))
      .replace(/\{\{\s*amount_with_comma_separator\s*\}\}/, value.replace(".", ","));
  }

  function bestTier(tiers, quantity) {
    var best = null;
    for (var i = 0; i < tiers.length; i++) {
      if (quantity >= tiers[i].quantity) {
        if (!best || tiers[i].quantity > best.quantity) best = tiers[i];
      }
    }
    return best;
  }

  function nextTier(tiers, quantity) {
    var next = null;
    for (var i = 0; i < tiers.length; i++) {
      if (quantity < tiers[i].quantity) {
        if (!next || tiers[i].quantity < next.quantity) next = tiers[i];
      }
    }
    return next;
  }

  function initWidget(root) {
    var bundleId = root.dataset.bundleId;
    if (!bundleId) return;

    var moneyFormat = root.dataset.moneyFormat;
    var buttonLabel = root.dataset.buttonLabel || "Add bundle to cart";
    var stateEl = root.querySelector(".magyx-bundle__state");

    fetch("/apps/magyx-bundle/bundle/" + encodeURIComponent(bundleId))
      .then(function (response) {
        if (!response.ok) throw new Error("Bundle unavailable");
        return response.json();
      })
      .then(function (bundle) {
        render(bundle);
      })
      .catch(function () {
        stateEl.innerHTML =
          '<p class="magyx-bundle__error">This bundle is currently unavailable.</p>';
      });

    function render(bundle) {
      var quantities = {}; // variantId -> qty

      var html = "";
      html += '<div class="magyx-bundle__header">';
      html += '<h2 class="magyx-bundle__title">' + escapeHtml(bundle.title) + "</h2>";
      if (bundle.description) {
        html +=
          '<p class="magyx-bundle__description">' +
          escapeHtml(bundle.description) +
          "</p>";
      }
      html += "</div>";
      html += '<div class="magyx-bundle__progress">';
      html += '<div class="magyx-bundle__progress-label">';
      html += '<span data-bc="progress-text"></span>';
      html += '<span class="magyx-bundle__progress-save" data-bc="progress-save"></span>';
      html += "</div>";
      html += '<div class="magyx-bundle__bar"><div class="magyx-bundle__bar-fill" data-bc="bar"></div></div>';
      html += "</div>";
      html += '<div class="magyx-bundle__grid" data-bc="grid"></div>';
      html += '<div class="magyx-bundle__footer">';
      html += '<div class="magyx-bundle__totals">';
      html += '<span class="magyx-bundle__total" data-bc="total"></span>';
      html += '<span class="magyx-bundle__compare" data-bc="compare"></span>';
      html += '<span class="magyx-bundle__savings" data-bc="savings"></span>';
      html += "</div>";
      html +=
        '<button type="button" class="magyx-bundle__cta" data-bc="cta" disabled>' +
        escapeHtml(buttonLabel) +
        "</button>";
      html += "</div>";
      stateEl.innerHTML = html;

      var grid = stateEl.querySelector('[data-bc="grid"]');
      bundle.items.forEach(function (item) {
        var card = document.createElement("div");
        card.className = "magyx-bundle__card";
        card.innerHTML =
          (item.image
            ? '<img class="magyx-bundle__card-image" loading="lazy" src="' +
              item.image +
              '" alt="' +
              escapeHtml(item.title) +
              '">'
            : '<div class="magyx-bundle__card-image"></div>') +
          '<p class="magyx-bundle__card-title">' + escapeHtml(item.title) + "</p>" +
          '<p class="magyx-bundle__card-price">' + formatMoney(item.price, moneyFormat) + "</p>" +
          '<div class="magyx-bundle__stepper">' +
          '<button type="button" data-action="decrement" aria-label="Remove one">−</button>' +
          '<span class="magyx-bundle__qty">0</span>' +
          '<button type="button" data-action="increment" aria-label="Add one"' +
          (item.available ? "" : " disabled") +
          ">+</button>" +
          "</div>";

        var qtyEl = card.querySelector(".magyx-bundle__qty");
        card.querySelector('[data-action="increment"]').addEventListener("click", function () {
          var total = totalQuantity();
          if (bundle.maxItems && total >= bundle.maxItems) return;
          quantities[item.variantId] = (quantities[item.variantId] || 0) + 1;
          qtyEl.textContent = quantities[item.variantId];
          card.classList.add("magyx-bundle__card--selected");
          update();
        });
        card.querySelector('[data-action="decrement"]').addEventListener("click", function () {
          if (!quantities[item.variantId]) return;
          quantities[item.variantId] -= 1;
          if (!quantities[item.variantId]) {
            delete quantities[item.variantId];
            card.classList.remove("magyx-bundle__card--selected");
          }
          qtyEl.textContent = quantities[item.variantId] || 0;
          update();
        });

        grid.appendChild(card);
      });

      var cta = stateEl.querySelector('[data-bc="cta"]');
      cta.addEventListener("click", addToCart);

      function totalQuantity() {
        return Object.keys(quantities).reduce(function (sum, key) {
          return sum + quantities[key];
        }, 0);
      }

      function subtotal() {
        return bundle.items.reduce(function (sum, item) {
          return sum + (quantities[item.variantId] || 0) * item.price;
        }, 0);
      }

      function update() {
        var total = totalQuantity();
        var tier = bestTier(bundle.tiers, total);
        var next = nextTier(bundle.tiers, total);
        var goal = bundle.maxItems || (next ? next.quantity : bundle.minItems);
        var percent = Math.min(100, goal ? (total / goal) * 100 : 100);

        var progressText = stateEl.querySelector('[data-bc="progress-text"]');
        var progressSave = stateEl.querySelector('[data-bc="progress-save"]');
        var bar = stateEl.querySelector('[data-bc="bar"]');

        if (total < bundle.minItems) {
          progressText.textContent =
            "Pick " + (bundle.minItems - total) + " more to unlock your bundle";
        } else {
          progressText.textContent = total + " item" + (total === 1 ? "" : "s") + " selected";
        }
        if (tier) {
          progressSave.textContent = "Saving " + tier.discount + "%";
        } else if (next) {
          progressSave.textContent =
            "Add " + (next.quantity - total) + " more to save " + next.discount + "%";
        } else {
          progressSave.textContent = "";
        }
        bar.style.display = "block";
        bar.style.width = percent + "%";

        var gross = subtotal();
        var discount = tier ? tier.discount : 0;
        var net = gross * (1 - discount / 100);
        stateEl.querySelector('[data-bc="total"]').textContent = formatMoney(net, moneyFormat);
        stateEl.querySelector('[data-bc="compare"]').textContent =
          discount > 0 ? formatMoney(gross, moneyFormat) : "";
        stateEl.querySelector('[data-bc="savings"]').textContent =
          discount > 0 ? "You save " + formatMoney(gross - net, moneyFormat) : "";

        cta.disabled = total < bundle.minItems;
      }

      function addToCart() {
        cta.disabled = true;
        cta.textContent = "Adding…";
        var items = Object.keys(quantities).map(function (variantId) {
          return {
            id: parseInt(variantId, 10),
            quantity: quantities[variantId],
            properties: { _magyx_bundle_id: bundle.id },
          };
        });
        fetch("/cart/add.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: items }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error("add failed");
            window.location.href = "/cart";
          })
          .catch(function () {
            cta.disabled = false;
            cta.textContent = buttonLabel;
            alert("Sorry, we couldn't add the bundle to your cart. Please try again.");
          });
      }

      update();
    }
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  function init() {
    document.querySelectorAll(".magyx-bundle").forEach(initWidget);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
