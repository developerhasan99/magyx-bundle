/* Magyx Bundle builder: customer fills every slot from the merchant's
   product pool via a selection modal, then adds the bundle's own parent
   product to cart. Keeps the theme's native add-to-cart form in control when
   one exists (same "native form integration" convention as the Bundle
   Contents and Quantity Breaks widgets) — it just gates that form's submit
   until every slot is filled, and stamps the customer's picks onto the
   line as properties for the Cart Transform function to expand and
   validate. Falls back to its own button only when the theme exposes no
   compatible form. */
(function () {
  "use strict";

  // Inserts `thousands` every 3 digits of the integer part, then joins back
  // to the decimal part (if any) with `decimal` — e.g. ("1049.95", " ", ",")
  // -> "1 049,95", matching Shopify's {{ amount_with_space_separator }}.
  function withSeparators(value, thousands, decimal) {
    var parts = value.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
    return parts.join(decimal);
  }

  // Covers all of Shopify's money_format placeholders, not just the 3 most
  // common ones — a market/locale using a less common one (e.g. Sweden's
  // default {{ amount_with_space_separator }}) would otherwise show the
  // literal, un-replaced placeholder text instead of a price.
  function formatMoney(amount, format) {
    var noDecimals = String(Math.round(amount));
    var twoDecimals = (Math.round(amount * 100) / 100).toFixed(2);
    if (!format) return "$" + twoDecimals;
    return format
      .replace(/\{\{\s*amount\s*\}\}/g, twoDecimals)
      .replace(/\{\{\s*amount_no_decimals\s*\}\}/g, noDecimals)
      .replace(
        /\{\{\s*amount_with_comma_separator\s*\}\}/g,
        withSeparators(twoDecimals, ".", ","),
      )
      .replace(
        /\{\{\s*amount_no_decimals_with_comma_separator\s*\}\}/g,
        withSeparators(noDecimals, ".", ","),
      )
      .replace(
        /\{\{\s*amount_with_apostrophe_separator\s*\}\}/g,
        withSeparators(twoDecimals, "'", "."),
      )
      .replace(
        /\{\{\s*amount_with_space_separator\s*\}\}/g,
        withSeparators(twoDecimals, " ", ","),
      )
      .replace(
        /\{\{\s*amount_no_decimals_with_space_separator\s*\}\}/g,
        withSeparators(noDecimals, " ", ","),
      );
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  // The cart-add form's hidden "id" field and Liquid's `variant.id` are plain
  // numeric ids; the metafield/proxy data carries GraphQL GIDs.
  function numericId(id) {
    return String(id || "").replace(/\D/g, "");
  }

  function readData(root) {
    var script = root.querySelector("[data-magyx-slot-builder-data]");
    if (!script) return null;
    try {
      return JSON.parse(script.textContent);
    } catch (e) {
      return null;
    }
  }

  function findNativeForm() {
    return (
      document.querySelector('form[data-type="add-to-cart-form"]') ||
      document.querySelector('form[action*="/cart/add"]')
    );
  }

  // Each package (bottle size / pack size) has its own independent product
  // pool, keyed by that package's own variant id. Used for both the
  // publish-time snapshot baked into the page and the live proxy fetch —
  // same shape, different `itemsKey`.
  function buildPoolMap(packageEntries, itemsKey) {
    var map = {};
    (packageEntries || []).forEach(function (p) {
      map[numericId(p.variantId)] = p[itemsKey] || [];
    });
    return map;
  }

  function poolHasItems(poolByVariantId, packages) {
    return packages.some(function (pkg) {
      return (poolByVariantId[numericId(pkg.variantId)] || []).length > 0;
    });
  }

  function initWidget(root) {
    var data = readData(root);
    if (!data || !data.bundleId) {
      root.remove();
      return;
    }

    var moneyFormat = root.dataset.moneyFormat;
    var stateEl = root.querySelector(".magyx-slot-builder__state");
    var packages = Array.isArray(data.packages) ? data.packages : [];

    if (
      packages.length === 0 ||
      packages.some(function (p) {
        return !(p.slotCount > 0);
      })
    ) {
      root.remove();
      return;
    }

    // Bundle-scoped snapshot baked in at publish time (a bounded handful of
    // items per package, not the merchant's whole catalog/collection) lets
    // the widget render immediately, and keeps it working even if the live
    // refresh below fails — that fetch is an enhancement for fresher
    // price/stock/newly-added pool products, not a hard dependency.
    var poolByVariantId = buildPoolMap(packages, "poolSnapshot");
    var rendered = false;
    if (poolHasItems(poolByVariantId, packages)) {
      render(poolByVariantId);
      rendered = true;
    } else {
      stateEl.innerHTML =
        '<div class="magyx-slot-builder__skeleton">' +
        '<div class="magyx-slot-builder__skeleton-bar"></div>' +
        '<div class="magyx-slot-builder__skeleton-bar"></div>' +
        '<div class="magyx-slot-builder__skeleton-bar"></div>' +
        "</div>";
    }

    fetch(
      "/apps/magyx-bundle/slot-builder/" + encodeURIComponent(data.bundleId),
    )
      .then(function (response) {
        if (!response.ok) throw new Error("Bundle builder unavailable");
        return response.json();
      })
      .then(function (pool) {
        var livePoolByVariantId = buildPoolMap(pool.packages, "items");
        if (rendered) {
          // Update the same object in place — currentPoolItems()/renderList()
          // read straight off this reference, so the next modal open or pack
          // switch picks up the fresh data without disturbing any picks the
          // shopper already made against the snapshot.
          for (var key in poolByVariantId) {
            if (Object.prototype.hasOwnProperty.call(poolByVariantId, key)) {
              delete poolByVariantId[key];
            }
          }
          for (var liveKey in livePoolByVariantId) {
            if (Object.prototype.hasOwnProperty.call(livePoolByVariantId, liveKey)) {
              poolByVariantId[liveKey] = livePoolByVariantId[liveKey];
            }
          }
        } else {
          render(livePoolByVariantId);
          rendered = true;
        }
      })
      .catch(function () {
        // No snapshot and the live fetch failed — nothing to show.
        if (!rendered) root.remove();
      });

    function render(poolByVariantId) {
      var hasAnyPool = poolHasItems(poolByVariantId, packages);
      if (!hasAnyPool) {
        root.remove();
        return;
      }

      // variantId -> { productId, variantId, title, image, price, quantity }
      var selections = new Map();
      var activePackageIndex = 0;

      function currentPoolItems() {
        var pkg = activePackage();
        return poolByVariantId[numericId(pkg.variantId)] || [];
      }

      var nativeForm = findNativeForm();
      var hasNativeButton = !!(
        nativeForm && nativeForm.querySelector('[name="id"]')
      );

      var html = "";
      html +=
        '<div class="magyx-slot-builder__price" data-sb="price" hidden>' +
        '<span class="magyx-slot-builder__price-sale" data-sb="price-sale"></span>' +
        '<span class="magyx-slot-builder__price-compare" data-sb="price-compare" hidden></span>' +
        '<span class="magyx-slot-builder__price-save" data-sb="price-save" hidden></span>' +
        "</div>";
      html +=
        '<p class="magyx-slot-builder__price-per-unit" data-sb="price-per-unit" hidden></p>';
      if (data.settings && data.settings.heading) {
        html +=
          '<p class="magyx-slot-builder__heading">' +
          escapeHtml(data.settings.heading) +
          "</p>";
      }
      if (packages.length > 1) {
        html +=
          '<div class="magyx-slot-builder__packs" data-sb="packs" role="tablist"></div>';
      }
      html +=
        '<div class="magyx-slot-builder__progress" data-sb="progress"></div>';
      html += '<div class="magyx-slot-builder__picks" data-sb="picks"></div>';
      html +=
        '<button type="button" class="magyx-slot-builder__add-btn" data-sb="open">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>' +
        "Add Items</button>";
      html +=
        '<p class="magyx-slot-builder__gifts" data-sb="gifts" hidden></p>';
      html +=
        '<p class="magyx-slot-builder__error" data-sb="error" hidden></p>';
      if (!hasNativeButton) {
        html +=
          '<button type="button" class="magyx-slot-builder__cta" data-sb="cta"></button>';
      }
      html +=
        '<div class="magyx-slot-builder-modal" data-sb="modal" hidden>' +
        '<div class="magyx-slot-builder-modal__overlay" data-sb="overlay"></div>' +
        '<div class="magyx-slot-builder-modal__panel" role="dialog" aria-modal="true">' +
        '<button type="button" class="magyx-slot-builder-modal__close" data-sb="close" aria-label="Close">&times;</button>' +
        '<div class="magyx-slot-builder-modal__header">' +
        '<p class="magyx-slot-builder-modal__title" data-sb="modal-title"></p>' +
        '<p class="magyx-slot-builder-modal__subtitle" data-sb="modal-subtitle"></p>' +
        "</div>" +
        '<div class="magyx-slot-builder-modal__filters" data-sb="filters" hidden></div>' +
        '<div class="magyx-slot-builder-modal__search-wrap">' +
        '<svg class="magyx-slot-builder-modal__search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg>' +
        '<input type="text" class="magyx-slot-builder-modal__search" data-sb="search" placeholder="Search products…" autocomplete="off">' +
        "</div>" +
        '<div class="magyx-slot-builder-modal__list" data-sb="list"></div>' +
        "</div>" +
        "</div>";

      stateEl.innerHTML = html;

      var priceEl = stateEl.querySelector('[data-sb="price"]');
      var priceSaleEl = stateEl.querySelector('[data-sb="price-sale"]');
      var priceCompareEl = stateEl.querySelector('[data-sb="price-compare"]');
      var priceSaveEl = stateEl.querySelector('[data-sb="price-save"]');
      var pricePerUnitEl = stateEl.querySelector('[data-sb="price-per-unit"]');
      var progressEl = stateEl.querySelector('[data-sb="progress"]');
      var picksEl = stateEl.querySelector('[data-sb="picks"]');
      var giftsEl = stateEl.querySelector('[data-sb="gifts"]');
      var errorEl = stateEl.querySelector('[data-sb="error"]');
      var modalEl = stateEl.querySelector('[data-sb="modal"]');
      var modalTitleEl = stateEl.querySelector('[data-sb="modal-title"]');
      var modalSubtitleEl = stateEl.querySelector('[data-sb="modal-subtitle"]');
      var filtersEl = stateEl.querySelector('[data-sb="filters"]');
      var searchInputEl = stateEl.querySelector('[data-sb="search"]');
      var listEl = stateEl.querySelector('[data-sb="list"]');
      var openBtn = stateEl.querySelector('[data-sb="open"]');
      var ctaBtn = stateEl.querySelector('[data-sb="cta"]');
      var searchText = "";
      // Tag the shopper is filtering the pool by (chips defined per package
      // in the app admin); null = the "All" chip.
      var activeTag = null;

      // `position: fixed` only escapes to the viewport when nothing between
      // this element and <body> establishes its own containing block
      // (a transform/filter/will-change/contain on a theme wrapper is
      // enough) — if it does, the modal gets trapped inside that ancestor's
      // stacking context and a sticky header outside it can render on top
      // regardless of z-index. Moving the modal to be a direct child of
      // <body> sidesteps that entirely, since we don't control the theme's
      // surrounding markup/CSS.
      // That move also takes the modal out of `.magyx-slot-builder`'s
      // subtree, so the --bc-accent/--bc-border/--bc-radius custom
      // properties set there (accent inline per-bundle, the other two in
      // magyx-bundle.css) no longer cascade in — copy their resolved
      // values onto the modal directly so its own border/accent-based
      // styles still resolve.
      var rootStyle = getComputedStyle(root);
      ["--bc-accent", "--bc-border", "--bc-radius"].forEach(function (name) {
        var value = rootStyle.getPropertyValue(name).trim();
        if (value) modalEl.style.setProperty(name, value);
      });
      document.body.appendChild(modalEl);

      function totalQty() {
        var total = 0;
        selections.forEach(function (item) {
          total += item.quantity;
        });
        return total;
      }

      function remaining() {
        return Math.max(0, (activePackage().slotCount || 0) - totalQty());
      }

      function activePackage() {
        return packages[activePackageIndex] || packages[0];
      }

      function selectionArray() {
        var arr = [];
        selections.forEach(function (item) {
          arr.push({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
          });
        });
        return arr;
      }

      function buildProperties() {
        var props = [];
        var index = 0;
        selections.forEach(function (item) {
          index += 1;
          var value =
            item.quantity > 1 ? item.quantity + " × " + item.title : item.title;
          props.push({ key: "Item " + index, value: value });
        });
        return props;
      }

      function renderPacks() {
        var container = stateEl.querySelector('[data-sb="packs"]');
        if (!container) return;
        container.innerHTML = "";
        packages.forEach(function (pkg, index) {
          var tab = document.createElement("button");
          tab.type = "button";
          tab.className = "magyx-slot-builder__pack-tab";
          if (index === activePackageIndex) {
            tab.className += " magyx-slot-builder__pack-tab--active";
          }
          tab.setAttribute(
            "aria-pressed",
            index === activePackageIndex ? "true" : "false",
          );
          var badge = pkg.badgeText
            ? ' <span class="magyx-slot-builder__pack-badge magyx-slot-builder__pack-badge--' +
              escapeHtml(pkg.badgeTone || "info") +
              '">' +
              escapeHtml(pkg.badgeText) +
              "</span>"
            : "";
          tab.innerHTML =
            '<span class="magyx-slot-builder__pack-tab-label">' +
            escapeHtml(pkg.label) +
            badge +
            "</span>" +
            (pkg.price != null
              ? '<span class="magyx-slot-builder__pack-tab-price">' +
                formatMoney(pkg.price, moneyFormat) +
                "/ea</span>"
              : "");
          tab.addEventListener("click", function () {
            if (index === activePackageIndex) return;
            // Each package has its own pool and slot count, so a prior
            // package's picks don't carry over — keeps totals/eligibility
            // unambiguous rather than trying to partially remap them.
            activePackageIndex = index;
            selections.clear();
            renderPacks();
            renderGifts();
            update();
            var pkgAfter = activePackage();
            if (nativeForm && pkgAfter.variantId) {
              var idField = nativeForm.querySelector('[name="id"]');
              if (idField) {
                idField.value = numericId(pkgAfter.variantId);
                idField.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }
          });
          container.appendChild(tab);
        });
      }

      // Sale price is this package's own (flat) price. The compare-at price
      // isn't the pool's average (that's the admin editor/checkout-truth
      // math) — here it's simply the combined price of the first `slotCount`
      // products in the pool, in whatever order the proxy returned them.
      function renderPrice() {
        var pkg = activePackage();
        var salePrice = pkg.price;
        if (salePrice == null) {
          priceEl.hidden = true;
          pricePerUnitEl.hidden = true;
          return;
        }
        priceEl.hidden = false;
        priceSaleEl.textContent = formatMoney(salePrice, moneyFormat);

        var slots = pkg.slotCount || 0;
        var comparePool = currentPoolItems()
          .slice(0, slots)
          .filter(function (item) {
            return item.price != null;
          });
        var comparePrice =
          comparePool.length > 0
            ? comparePool.reduce(function (sum, item) {
                return sum + item.price;
              }, 0)
            : null;

        var hasSavings = comparePrice != null && comparePrice > salePrice;
        priceCompareEl.hidden = !hasSavings;
        priceSaveEl.hidden = !hasSavings;
        if (hasSavings) {
          priceCompareEl.textContent = formatMoney(comparePrice, moneyFormat);
          priceSaveEl.textContent =
            "Save " + formatMoney(comparePrice - salePrice, moneyFormat);
        }

        if (slots > 0) {
          pricePerUnitEl.hidden = false;
          pricePerUnitEl.textContent =
            "That's only " +
            formatMoney(salePrice / slots, moneyFormat) +
            " per item.";
        } else {
          pricePerUnitEl.hidden = true;
        }
      }

      function renderProgress() {
        var total = totalQty();
        var left = remaining();
        var text =
          left > 0
            ? "Choose " + left + " more product" + (left === 1 ? "" : "s")
            : total + " of " + (activePackage().slotCount || 0) + " selected";
        progressEl.textContent = text;
        progressEl.classList.toggle(
          "magyx-slot-builder__progress--complete",
          left === 0,
        );
      }

      function renderPicks() {
        picksEl.innerHTML = "";
        if (selections.size > 0) {
          var full = remaining() === 0;
          selections.forEach(function (item) {
            var row = document.createElement("div");
            row.className = "magyx-slot-builder__pick";
            row.innerHTML =
              (item.image
                ? '<img class="magyx-slot-builder__pick-image" loading="lazy" src="' +
                  item.image +
                  '" alt="' +
                  escapeHtml(item.title) +
                  '">'
                : '<div class="magyx-slot-builder__pick-image"></div>') +
              '<div class="magyx-slot-builder__pick-info">' +
              '<span class="magyx-slot-builder__pick-title">' +
              escapeHtml(item.title) +
              "</span>" +
              (item.subtext
                ? '<span class="magyx-slot-builder__pick-subtext">' +
                  escapeHtml(item.subtext) +
                  "</span>"
                : "") +
              "</div>" +
              '<div class="magyx-slot-builder__pick-stepper">' +
              '<button type="button" data-action="decrement" aria-label="Remove one ' +
              escapeHtml(item.title) +
              '">−</button>' +
              '<span class="magyx-slot-builder__pick-qty">' +
              item.quantity +
              "</span>" +
              '<button type="button" data-action="increment" aria-label="Add one ' +
              escapeHtml(item.title) +
              '"' +
              (full ? " disabled" : "") +
              ">+</button>" +
              "</div>" +
              '<button type="button" class="magyx-slot-builder__pick-remove" aria-label="Remove ' +
              escapeHtml(item.title) +
              '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
            row
              .querySelector('[data-action="increment"]')
              .addEventListener("click", function () {
                if (remaining() === 0) return;
                item.quantity += 1;
                selections.set(item.variantId, item);
                update();
                if (remaining() === 0) {
                  setTimeout(closeModal, 350);
                }
              });
            row
              .querySelector('[data-action="decrement"]')
              .addEventListener("click", function () {
                item.quantity -= 1;
                if (item.quantity <= 0) {
                  selections.delete(item.variantId);
                } else {
                  selections.set(item.variantId, item);
                }
                update();
              });
            row
              .querySelector(".magyx-slot-builder__pick-remove")
              .addEventListener("click", function () {
                selections.delete(item.variantId);
                update();
              });
            picksEl.appendChild(row);
          });
        }
      }

      function renderGifts() {
        var pkg = activePackage();
        var gifts = (pkg && pkg.gifts) || [];
        if (gifts.length === 0) {
          giftsEl.hidden = true;
          return;
        }
        giftsEl.hidden = false;
        giftsEl.textContent =
          "Includes free " +
          gifts
            .map(function (g) {
              return (g.quantity > 1 ? g.quantity + " × " : "") + g.title;
            })
            .join(", ");
      }

      function renderCta() {
        if (!ctaBtn) return;
        var pkg = activePackage();
        var left = remaining();
        if (left > 0) {
          ctaBtn.textContent = "Choose " + left + " more";
          ctaBtn.disabled = true;
        } else {
          ctaBtn.textContent =
            "Add to cart" +
            (pkg && pkg.price != null
              ? " — " + formatMoney(pkg.price, moneyFormat)
              : "");
          ctaBtn.disabled = false;
        }
      }

      function itemHasTag(item, tag) {
        var tags = item.tags || [];
        for (var i = 0; i < tags.length; i++) {
          if (String(tags[i]).toLowerCase() === tag) return true;
        }
        return false;
      }

      // Round filter chips between the modal header and the search field —
      // one per merchant-defined category (button text + product tag), plus
      // an automatic "All" chip. Hidden when the package defines none.
      function renderFilters() {
        var pkg = activePackage();
        var filters = (pkg && pkg.tagFilters) || [];
        filtersEl.innerHTML = "";
        if (filters.length === 0) {
          filtersEl.hidden = true;
          return;
        }
        filtersEl.hidden = false;
        [{ label: "All", tag: null }].concat(filters).forEach(function (filter) {
          var tag = filter.tag == null ? null : String(filter.tag).toLowerCase();
          var chip = document.createElement("button");
          chip.type = "button";
          chip.className =
            "magyx-slot-builder-modal__filter" +
            (tag === activeTag ? " magyx-slot-builder-modal__filter--active" : "");
          chip.setAttribute("aria-pressed", tag === activeTag ? "true" : "false");
          chip.textContent = filter.label;
          chip.addEventListener("click", function () {
            if (tag === activeTag) return;
            activeTag = tag;
            renderFilters();
            renderList();
          });
          filtersEl.appendChild(chip);
        });
      }

      function renderList() {
        listEl.innerHTML = "";
        var full = remaining() === 0;
        var poolItems = currentPoolItems();
        if (poolItems.length === 0) {
          var empty = document.createElement("p");
          empty.className = "magyx-slot-builder__empty";
          empty.textContent =
            "No products available for this option right now.";
          listEl.appendChild(empty);
          return;
        }
        var tagItems = activeTag
          ? poolItems.filter(function (item) {
              return itemHasTag(item, activeTag);
            })
          : poolItems;
        var visibleItems = searchText
          ? tagItems.filter(function (item) {
              return (
                item.title.toLowerCase().indexOf(searchText) !== -1 ||
                (item.subtext &&
                  item.subtext.toLowerCase().indexOf(searchText) !== -1)
              );
            })
          : tagItems;
        if (visibleItems.length === 0) {
          var noMatch = document.createElement("p");
          noMatch.className = "magyx-slot-builder__empty";
          noMatch.textContent = searchText
            ? "No products match your search."
            : "No products match this filter.";
          listEl.appendChild(noMatch);
          return;
        }
        visibleItems.forEach(function (item) {
          var selected = selections.get(item.variantId);
          var qty = selected ? selected.quantity : 0;
          var row = document.createElement("div");
          row.className =
            "magyx-slot-builder-modal__item" +
            (qty > 0 ? " magyx-slot-builder-modal__item--selected" : "");
          row.innerHTML =
            (item.image
              ? '<img class="magyx-slot-builder-modal__item-image" loading="lazy" src="' +
                item.image +
                '" alt="' +
                escapeHtml(item.title) +
                '">'
              : '<div class="magyx-slot-builder-modal__item-image"></div>') +
            '<div class="magyx-slot-builder-modal__item-info">' +
            '<p class="magyx-slot-builder-modal__item-title">' +
            escapeHtml(item.title) +
            "</p>" +
            (item.subtext
              ? '<p class="magyx-slot-builder-modal__item-subtext">' +
                escapeHtml(item.subtext) +
                "</p>"
              : "") +
            (data.settings && data.settings.showPrices
              ? '<p class="magyx-slot-builder-modal__item-price">' +
                formatMoney(item.price, moneyFormat) +
                "</p>"
              : "") +
            "</div>" +
            '<div class="magyx-slot-builder-modal__stepper">' +
            '<button type="button" data-action="decrement" aria-label="Remove one"' +
            (qty === 0 ? " disabled" : "") +
            ">−</button>" +
            '<span class="magyx-slot-builder-modal__qty">' +
            qty +
            "</span>" +
            '<button type="button" data-action="increment" aria-label="Add one"' +
            (!item.available || (full && qty === 0) ? " disabled" : "") +
            ">+</button>" +
            "</div>";

          row
            .querySelector('[data-action="increment"]')
            .addEventListener("click", function () {
              if (remaining() === 0) return;
              var current = selections.get(item.variantId) || {
                productId: item.productId,
                variantId: item.variantId,
                title: item.title,
                image: item.image,
                price: item.price,
                subtext: item.subtext,
                quantity: 0,
              };
              current.quantity += 1;
              selections.set(item.variantId, current);
              renderList();
              update();
              if (remaining() === 0) {
                // Let the shopper see their last pick register as selected
                // before the modal closes on its own.
                setTimeout(closeModal, 350);
              }
            });
          row
            .querySelector('[data-action="decrement"]')
            .addEventListener("click", function () {
              var current = selections.get(item.variantId);
              if (!current) return;
              current.quantity -= 1;
              if (current.quantity <= 0) {
                selections.delete(item.variantId);
              } else {
                selections.set(item.variantId, current);
              }
              renderList();
              update();
            });

          listEl.appendChild(row);
        });
      }

      // Mirrors what the merchant's reference bundle builder does: the modal
      // title itself tracks progress ("Add 2 more products" → "Your bundle
      // is ready!") instead of a static "Choose N products" label.
      function renderModalHeader() {
        var left = remaining();
        var slots = activePackage().slotCount || 0;
        modalTitleEl.textContent =
          left === 0
            ? "Your bundle is ready!"
            : "Add " + left + " more product" + (left === 1 ? "" : "s");
        modalSubtitleEl.textContent =
          "Build your " + slots + "-product bundle.";
      }

      function update() {
        renderPrice();
        renderPicks();
        renderProgress();
        renderCta();
        renderModalHeader();
        openBtn.hidden = remaining() === 0;
        errorEl.hidden = true;
      }

      function openModal() {
        searchText = "";
        searchInputEl.value = "";
        // Fresh filter state each open — also picks up the right chip set
        // after a pack switch, since each package has its own tagFilters.
        activeTag = null;
        renderFilters();
        renderModalHeader();
        renderList();
        modalEl.hidden = false;
      }

      function closeModal() {
        modalEl.hidden = true;
      }

      openBtn.addEventListener("click", openModal);
      // Queried from modalEl, not stateEl — the modal was moved out to
      // <body> above, so these are no longer stateEl's descendants.
      modalEl
        .querySelector('[data-sb="close"]')
        .addEventListener("click", closeModal);
      modalEl
        .querySelector('[data-sb="overlay"]')
        .addEventListener("click", closeModal);
      searchInputEl.addEventListener("input", function () {
        searchText = searchInputEl.value.trim().toLowerCase();
        renderList();
      });

      function showIncompleteError() {
        var left = remaining();
        errorEl.hidden = false;
        errorEl.textContent =
          "Choose " +
          left +
          " more product" +
          (left === 1 ? "" : "s") +
          " before adding to cart.";
        openModal();
      }

      function packageVariantIds() {
        return packages.map(function (pkg) {
          return numericId(pkg.variantId);
        });
      }

      function injectProperties(form) {
        form
          .querySelectorAll("[data-magyx-slot-builder-property]")
          .forEach(function (el) {
            el.remove();
          });
        var props = buildProperties();
        props.push({ key: "_magyx_slot_bundle_id", value: data.bundleId });
        props.push({
          key: "_magyx_slot_selection",
          value: JSON.stringify(selectionArray()),
        });
        props.forEach(function (property) {
          var input = document.createElement("input");
          input.type = "hidden";
          input.name = "properties[" + property.key + "]";
          input.value = property.value;
          input.setAttribute("data-magyx-slot-builder-property", "");
          form.appendChild(input);
        });
      }

      if (nativeForm) {
        var variantIds = packageVariantIds();
        document.addEventListener(
          "submit",
          function (event) {
            var form = event.target;
            if (!(form instanceof HTMLFormElement)) return;
            if (!/\/cart\/add/.test(form.action)) return;
            var idField = form.elements["id"];
            var variantId = idField ? numericId(idField.value) : null;
            if (!variantId || variantIds.indexOf(variantId) === -1) return;
            if (remaining() > 0) {
              event.preventDefault();
              event.stopPropagation();
              showIncompleteError();
              return;
            }
            injectProperties(form);
          },
          true,
        );
      }

      if (!hasNativeButton) {
        ctaBtn.addEventListener("click", function () {
          if (remaining() > 0) {
            showIncompleteError();
            return;
          }
          var pkg = activePackage();
          var originalLabel = ctaBtn.textContent;
          ctaBtn.disabled = true;
          ctaBtn.textContent = "Adding…";
          var props = {};
          buildProperties().forEach(function (p) {
            props[p.key] = p.value;
          });
          props._magyx_slot_bundle_id = data.bundleId;
          props._magyx_slot_selection = JSON.stringify(selectionArray());
          fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: [
                {
                  id: parseInt(numericId(pkg.variantId), 10),
                  quantity: 1,
                  properties: props,
                },
              ],
            }),
          })
            .then(function (response) {
              if (!response.ok) throw new Error("add failed");
              window.location.href = "/cart";
            })
            .catch(function () {
              ctaBtn.disabled = false;
              ctaBtn.textContent = originalLabel;
              alert(
                "Sorry, we couldn't add this to your cart. Please try again.",
              );
            });
        });
      }

      renderPacks();
      renderGifts();
      update();
    }
  }

  function boot() {
    document.querySelectorAll(".magyx-slot-builder").forEach(initWidget);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
