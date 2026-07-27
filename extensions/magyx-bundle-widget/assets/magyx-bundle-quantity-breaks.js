/* Magyx Bundle quantity breaks widget: pack-size picker + (when the product
   has more than one variant) its own variant option buttons, resolved by
   product id via the app proxy. Price math here is cosmetic preview only —
   the Cart Transform function is what actually reprices the cart line. */
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

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  // Mirrors the Cart Transform function's tierUnitPrice formula so the
  // preview shown here matches what checkout will actually charge.
  function tierUnitPrice(original, tier) {
    if (tier.pricingType === "FIXED_PRICE") {
      return Math.round(tier.pricingValue * 100) / 100;
    }
    if (tier.pricingType === "AMOUNT_OFF") {
      return Math.max(0, Math.round((original - tier.pricingValue) * 100) / 100);
    }
    return Math.round(original * (1 - tier.pricingValue / 100) * 100) / 100;
  }

  function variantMatches(variant, selectedOptions) {
    return variant.selectedOptions.every(function (opt) {
      return selectedOptions[opt.name] === opt.value;
    });
  }

  // Finds the theme's own add-to-cart form (Dawn and most Dawn-derived
  // themes render one as form[data-type="add-to-cart-form"]) so the widget
  // can submit through it instead of its own bypass fetch — this keeps cart
  // drawer / quick-add / analytics behavior the theme already wires up.
  function findNativeForm() {
    return document.querySelector('form[data-type="add-to-cart-form"]');
  }

  // Quantity inputs are sometimes rendered outside the form and linked via
  // the HTML `form` attribute (Dawn's quantity-input component does this),
  // so a plain form.querySelector alone would miss them.
  function findQuantityInput(form) {
    if (form.id) {
      var linked = document.querySelector('[name="quantity"][form="' + form.id + '"]');
      if (linked) return linked;
    }
    return form.querySelector('[name="quantity"]');
  }

  // Keeps the theme's own form fields pointed at the currently selected
  // variant/quantity so its native submit button — not a button we render —
  // is what actually fires Shopify's add-to-cart request and event.
  function syncNativeFormFields(form, variant, quantity) {
    var idInput = form.querySelector('[name="id"]');
    if (!idInput) return false;
    idInput.value = variant.id;
    idInput.disabled = false;

    var qtyInput = findQuantityInput(form);
    if (!qtyInput) {
      qtyInput = document.createElement("input");
      qtyInput.type = "hidden";
      qtyInput.name = "quantity";
      form.appendChild(qtyInput);
    }
    qtyInput.value = quantity;
    return true;
  }

  function initWidget(root) {
    var productId = root.dataset.productId;
    if (!productId) return;
    var moneyFormat = root.dataset.moneyFormat;
    var stateEl = root.querySelector(".magyx-quantity-breaks__state");

    stateEl.innerHTML =
      '<div class="magyx-quantity-breaks__skeleton">' +
      '<div class="magyx-quantity-breaks__skeleton-bar"></div>' +
      '<div class="magyx-quantity-breaks__skeleton-bar"></div>' +
      '<div class="magyx-quantity-breaks__skeleton-bar"></div>' +
      "</div>";

    fetch("/apps/magyx-bundle/quantity-breaks/" + encodeURIComponent(productId))
      .then(function (response) {
        if (!response.ok) throw new Error("Quantity breaks unavailable");
        return response.json();
      })
      .then(render)
      .catch(function () {
        root.remove();
      });

    function render(data) {
      var tiers = data.tiers || [];
      var variants = (data.product && data.product.variants) || [];
      var options = (data.product && data.product.options) || [];
      if (tiers.length === 0 || variants.length === 0) {
        root.remove();
        return;
      }

      root.style.setProperty("--bc-accent", data.accentColor || "#1a1a1a");

      var showOptions = variants.length > 1 && options.length > 0;
      var selectedOptions = {};
      var firstAvailable = variants.find(function (v) {
        return v.available;
      }) || variants[0];
      firstAvailable.selectedOptions.forEach(function (opt) {
        selectedOptions[opt.name] = opt.value;
      });

      var selectedTierIndex = tiers.findIndex(function (t) {
        return t.isDefault;
      });
      if (selectedTierIndex === -1) selectedTierIndex = 0;

      // When the theme exposes a compatible native add-to-cart form, the
      // widget never renders its own CTA — it just keeps that form's fields
      // in sync so the theme's real button is what triggers the add-to-cart
      // request (and whatever cart drawer / analytics the theme wires to it).
      var nativeForm = findNativeForm();
      if (nativeForm && !nativeForm.querySelector('[name="id"]')) nativeForm = null;

      var html = "";
      if (data.heading) {
        html += '<p class="magyx-quantity-breaks__heading">' + escapeHtml(data.heading) + "</p>";
      }
      if (showOptions) {
        html += '<div class="magyx-quantity-breaks__options" data-qb="options"></div>';
      }
      html += '<div class="magyx-quantity-breaks__tiers" data-qb="tiers"></div>';
      html += '<div class="magyx-quantity-breaks__savings" data-qb="savings" hidden></div>';
      if (!nativeForm) {
        html += '<button type="button" class="magyx-quantity-breaks__cta" data-qb="cta"></button>';
      }
      stateEl.innerHTML = html;

      function selectedVariant() {
        return (
          variants.find(function (v) {
            return variantMatches(v, selectedOptions);
          }) || firstAvailable
        );
      }

      function renderOptions() {
        var container = stateEl.querySelector('[data-qb="options"]');
        if (!container) return;
        container.innerHTML = "";
        options.forEach(function (option) {
          var group = document.createElement("div");
          group.className = "magyx-quantity-breaks__option-group";
          var name = document.createElement("p");
          name.className = "magyx-quantity-breaks__option-name";
          name.textContent = option.name;
          group.appendChild(name);

          var values = document.createElement("div");
          values.className = "magyx-quantity-breaks__option-values";
          option.optionValues.forEach(function (optionValue) {
            var hasAvailableVariant = variants.some(function (v) {
              return (
                v.available &&
                v.selectedOptions.some(function (o) {
                  return o.name === option.name && o.value === optionValue.name;
                })
              );
            });
            var button = document.createElement("button");
            button.type = "button";
            button.className = "magyx-quantity-breaks__option-value";
            if (selectedOptions[option.name] === optionValue.name) {
              button.className += " magyx-quantity-breaks__option-value--selected";
            }
            if (!hasAvailableVariant) button.disabled = true;
            button.textContent = optionValue.name;
            button.addEventListener("click", function () {
              selectedOptions[option.name] = optionValue.name;
              renderOptions();
              renderTiers();
            });
            values.appendChild(button);
          });
          group.appendChild(values);
          container.appendChild(group);
        });
      }

      function renderTiers() {
        var container = stateEl.querySelector('[data-qb="tiers"]');
        var variant = selectedVariant();
        container.innerHTML = "";
        tiers.forEach(function (tier, index) {
          var each = tierUnitPrice(variant.price, tier);
          var total = Math.round(each * tier.quantity * 100) / 100;
          var compareTotal = Math.round(variant.price * tier.quantity * 100) / 100;
          var discounted = each < variant.price;

          var card = document.createElement("button");
          card.type = "button";
          card.className = "magyx-quantity-breaks__tier";
          if (index === selectedTierIndex) {
            card.className += " magyx-quantity-breaks__tier--selected";
          }

          var badgeHtml = tier.badgeText
            ? '<span class="magyx-quantity-breaks__tier-badge magyx-quantity-breaks__tier-badge--' +
              escapeHtml(tier.badgeTone || "info") +
              '">' +
              escapeHtml(tier.badgeText) +
              "</span>"
            : "";

          var giftsHtml =
            tier.gifts && tier.gifts.length > 0
              ? '<span class="magyx-quantity-breaks__tier-gift">Includes free ' +
                tier.gifts
                  .map(function (gift) {
                    return (gift.quantity > 1 ? gift.quantity + " × " : "") + escapeHtml(gift.title);
                  })
                  .join(", ") +
                "</span>"
              : "";

          card.innerHTML =
            '<span class="magyx-quantity-breaks__tier-radio"></span>' +
            '<span class="magyx-quantity-breaks__tier-info">' +
            '<span class="magyx-quantity-breaks__tier-label-row">' +
            '<span class="magyx-quantity-breaks__tier-label">' +
            escapeHtml(tier.label) +
            "</span>" +
            badgeHtml +
            "</span>" +
            '<span class="magyx-quantity-breaks__tier-each">' +
            formatMoney(each, moneyFormat) +
            " each</span>" +
            giftsHtml +
            "</span>" +
            '<span class="magyx-quantity-breaks__tier-price">' +
            '<span class="magyx-quantity-breaks__tier-price-total">' +
            formatMoney(total, moneyFormat) +
            "</span>" +
            (discounted
              ? '<span class="magyx-quantity-breaks__tier-price-compare">' +
                formatMoney(compareTotal, moneyFormat) +
                "</span>"
              : "") +
            "</span>";

          card.addEventListener("click", function () {
            selectedTierIndex = index;
            renderTiers();
          });
          container.appendChild(card);
        });

        var savingsEl = stateEl.querySelector('[data-qb="savings"]');
        var tier = tiers[selectedTierIndex];
        var each = tierUnitPrice(variant.price, tier);
        var savings = Math.round((variant.price - each) * tier.quantity * 100) / 100;
        if (savings > 0) {
          savingsEl.hidden = false;
          savingsEl.textContent = "You're saving " + formatMoney(savings, moneyFormat) + " on this order";
        } else {
          savingsEl.hidden = true;
        }

        if (nativeForm) {
          syncNativeFormFields(nativeForm, variant, tier.quantity);
        } else {
          renderCta();
        }
      }

      function renderCta() {
        var cta = stateEl.querySelector('[data-qb="cta"]');
        if (!cta) return;
        var variant = selectedVariant();
        var tier = tiers[selectedTierIndex];
        var each = tierUnitPrice(variant.price, tier);
        var total = Math.round(each * tier.quantity * 100) / 100;
        cta.textContent = "Add to cart — " + formatMoney(total, moneyFormat);
        cta.disabled = !variant.available;
      }

      if (!nativeForm) {
        stateEl.querySelector('[data-qb="cta"]').addEventListener("click", addToCart);
      }

      function addToCart() {
        var cta = stateEl.querySelector('[data-qb="cta"]');
        var variant = selectedVariant();
        var tier = tiers[selectedTierIndex];
        var originalLabel = cta.textContent;
        cta.disabled = true;
        cta.textContent = "Adding…";

        fetch("/cart/add.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ id: parseInt(variant.id, 10), quantity: tier.quantity }] }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error("add failed");
            window.location.href = "/cart";
          })
          .catch(function () {
            cta.disabled = false;
            cta.textContent = originalLabel;
            alert("Sorry, we couldn't add this to your cart. Please try again.");
          });
      }

      if (showOptions) renderOptions();
      renderTiers();
    }
  }

  function init() {
    document.querySelectorAll(".magyx-quantity-breaks").forEach(initWidget);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
