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
        '<div class="magyx-slot-builder__gifts" data-sb="gifts" hidden></div>';
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

      // Shared by the pack tabs and locked gift cards (clicking a locked
      // gift jumps to the package that unlocks it). Each package has its own
      // pool and slot count, so a prior package's picks don't carry over —
      // keeps totals/eligibility unambiguous rather than trying to partially
      // remap them.
      function selectPackage(index) {
        if (index === activePackageIndex) return;
        activePackageIndex = index;
        selections.clear();
        renderPacks();
        update();
        var pkgAfter = activePackage();
        if (nativeForm && pkgAfter.variantId) {
          var idField = nativeForm.querySelector('[name="id"]');
          if (idField) {
            idField.value = numericId(pkgAfter.variantId);
            idField.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
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
            selectPackage(index);
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

      /* ---- Progressive free gifts --------------------------------------
         Every package's gifts render as cards: the active package's own and
         every earlier package's are UNLOCKED — hidden behind a cosmetic
         scratch-off foil the shopper can rub away — while later packages'
         stay LOCKED (blurred, padlock) to nudge them toward the bigger
         pack; clicking a locked card switches to the package that unlocks
         it. Purely presentational: checkout truth is the cumulative gift
         list baked into the shop config metafield at sync time, so unlocked
         gifts are added to the order whether or not they're scratched. */

      // Revealed foils, keyed by gift — survives package switches so an
      // already-scratched gift never re-covers itself.
      var scratchedGifts = {};

      // Flattens every package's own gifts in unlock (tab) order, deduped by
      // variantId — the earliest package's entry wins, mirroring checkout's
      // cumulative merge. A package with free shipping enabled contributes
      // one extra virtual "gift" card (no variant/price, just a shipping
      // icon) the first time it turns on, so the perk shows up in the same
      // scratch-to-reveal flow as product gifts.
      function progressiveGifts() {
        var seen = {};
        var entries = [];
        var shippingAdded = false;
        packages.forEach(function (pkg, pkgIndex) {
          (((pkg && pkg.gifts) || [])).forEach(function (gift, giftIndex) {
            var key = String(gift.variantId || pkgIndex + ":" + giftIndex);
            if (seen[key]) return;
            seen[key] = true;
            entries.push({ key: key, gift: gift, unlockIndex: pkgIndex });
          });
          if (pkg && pkg.freeShipping && !shippingAdded) {
            shippingAdded = true;
            entries.push({
              key: "free-shipping",
              gift: { title: "Free Shipping", isShipping: true, quantity: 1, price: null },
              unlockIndex: pkgIndex,
            });
          }
        });
        return entries;
      }

      // Rubbing erases the foil (destination-out strokes); once ~40% is
      // gone the whole thing fades out and the gift stays revealed.
      function attachScratchFoil(body, key) {
        var canvas = document.createElement("canvas");
        canvas.className = "magyx-slot-builder__gift-foil";
        body.appendChild(canvas);
        var ctx = canvas.getContext("2d");
        var scratching = false;
        var lastPoint = null;
        var revealed = false;

        function paint() {
          var rect = body.getBoundingClientRect();
          if (rect.width === 0) return;
          var dpr = window.devicePixelRatio || 1;
          canvas.width = Math.round(rect.width * dpr);
          canvas.height = Math.round(rect.height * dpr);
          ctx.scale(dpr, dpr);
          var w = rect.width;
          var h = rect.height;
          ctx.fillStyle = "#f7d63d";
          ctx.fillRect(0, 0, w, h);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = Math.round(Math.min(w, h) * 0.32) + "px serif";
          ctx.fillText("🎁", w / 2, h * 0.38);
          ctx.fillStyle = "#1a1a1a";
          ctx.font = "800 " + Math.max(12, Math.round(w * 0.13)) + "px sans-serif";
          ctx.fillText("SCRATCH", w / 2, h * 0.76);
        }
        // Deferred a frame: the card isn't laid out (zero-sized) until it's
        // actually in the document.
        requestAnimationFrame(paint);

        function pointFrom(event) {
          var rect = canvas.getBoundingClientRect();
          return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        }

        function scratchTo(point) {
          ctx.globalCompositeOperation = "destination-out";
          ctx.lineWidth = 26;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(lastPoint ? lastPoint.x : point.x, lastPoint ? lastPoint.y : point.y);
          ctx.lineTo(point.x, point.y);
          ctx.stroke();
          lastPoint = point;
        }

        // Once 60% of the foil is rubbed away, the rest auto-clears — the
        // shopper doesn't have to scratch every last pixel by hand.
        var REVEAL_THRESHOLD = 0.6;

        function scratchedRatio() {
          var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          var cleared = 0;
          var total = 0;
          // Every 16th pixel's alpha is plenty to estimate coverage
          for (var i = 3; i < data.length; i += 64) {
            total += 1;
            if (data[i] === 0) cleared += 1;
          }
          return total > 0 ? cleared / total : 0;
        }

        function reveal() {
          if (revealed) return;
          revealed = true;
          scratchedGifts[key] = true;
          canvas.classList.add("magyx-slot-builder__gift-foil--revealed");
          // `body`'s parent is the card element, which also holds the title
          // heading rendered (but hidden) alongside it — see renderGifts.
          var card = body.parentElement;
          var titleEl = card && card.querySelector(".magyx-slot-builder__gift-title");
          if (titleEl) titleEl.hidden = false;
          setTimeout(function () {
            canvas.remove();
          }, 400);
        }

        canvas.addEventListener("pointerdown", function (event) {
          scratching = true;
          lastPoint = null;
          if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
          scratchTo(pointFrom(event));
          if (scratchedRatio() >= REVEAL_THRESHOLD) reveal();
        });
        canvas.addEventListener("pointermove", function (event) {
          if (!scratching || revealed) return;
          scratchTo(pointFrom(event));
          // Checked live so the auto-clear fires mid-scratch, not only once
          // the shopper lifts their finger/mouse.
          if (scratchedRatio() >= REVEAL_THRESHOLD) reveal();
        });
        canvas.addEventListener("pointerup", function () {
          scratching = false;
          lastPoint = null;
          if (scratchedRatio() >= REVEAL_THRESHOLD) reveal();
        });
        canvas.addEventListener("pointercancel", function () {
          scratching = false;
          lastPoint = null;
        });
      }

      function renderGifts() {
        var entries = progressiveGifts();
        giftsEl.innerHTML = "";
        if (entries.length === 0) {
          giftsEl.hidden = true;
          return;
        }
        giftsEl.hidden = false;

        var heading = document.createElement("p");
        heading.className = "magyx-slot-builder__gifts-heading";
        heading.textContent = "Free Gifts";
        giftsEl.appendChild(heading);

        var cards = document.createElement("div");
        cards.className = "magyx-slot-builder__gift-cards";
        giftsEl.appendChild(cards);

        // A gift only actually unlocks once its tier is reached AND the
        // active package's own slots are filled — picking the "3 Pack" tab
        // isn't enough on its own, the shopper still has to fill it.
        var slotsFilled = remaining() === 0;
        var tierLockedCount = 0;
        var nextUnlockIndex = null;

        entries.forEach(function (entry) {
          var gift = entry.gift;
          var tierReached = entry.unlockIndex <= activePackageIndex;
          var unlocked = tierReached && slotsFilled;
          var lockedByTier = !tierReached;
          if (lockedByTier) {
            tierLockedCount += 1;
            if (nextUnlockIndex === null || entry.unlockIndex < nextUnlockIndex) {
              nextUnlockIndex = entry.unlockIndex;
            }
          }

          var titleText = gift.isShipping ? "Free Shipping" : gift.title;

          var card = document.createElement(unlocked ? "div" : "button");
          if (!unlocked) card.type = "button";
          card.className =
            "magyx-slot-builder__gift-card" +
            (unlocked ? "" : " magyx-slot-builder__gift-card--locked");
          card.title = (gift.quantity > 1 ? gift.quantity + " × " : "") + titleText;

          var quantity = gift.quantity || 1;
          var value = !gift.isShipping && gift.price != null ? gift.price * quantity : null;
          var badge = "";
          if (value != null && value > 0) {
            badge =
              '<span class="magyx-slot-builder__gift-value">' +
              escapeHtml(formatMoney(value, moneyFormat)) +
              " VALUE</span>";
          }

          card.innerHTML =
            badge +
            '<div class="magyx-slot-builder__gift-body">' +
            (gift.isShipping
              ? '<div class="magyx-slot-builder__gift-image magyx-slot-builder__gift-image--shipping">' +
                '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="6" width="14" height="11" rx="1"></rect><path d="M15 10h4l3 3v4h-7z"></path><circle cx="6" cy="19" r="2"></circle><circle cx="17.5" cy="19" r="2"></circle></svg>' +
                "</div>"
              : gift.imageUrl
                ? '<img class="magyx-slot-builder__gift-image" loading="lazy" src="' +
                  gift.imageUrl +
                  '" alt="' +
                  escapeHtml(titleText) +
                  '">'
                : '<div class="magyx-slot-builder__gift-image"></div>') +
            (quantity > 1
              ? '<span class="magyx-slot-builder__gift-qty">×' + quantity + "</span>"
              : "") +
            (unlocked
              ? ""
              : '<span class="magyx-slot-builder__gift-lock">' +
                '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>' +
                "LOCKED</span>") +
            "</div>" +
            (unlocked
              ? '<p class="magyx-slot-builder__gift-title"' +
                (scratchedGifts[entry.key] ? "" : " hidden") +
                ">" +
                escapeHtml(titleText) +
                "</p>"
              : "");

          if (unlocked && !scratchedGifts[entry.key]) {
            attachScratchFoil(
              card.querySelector(".magyx-slot-builder__gift-body"),
              entry.key,
            );
          }
          if (lockedByTier) {
            var unlockIndex = entry.unlockIndex;
            card.addEventListener("click", function () {
              selectPackage(unlockIndex);
            });
          } else if (!unlocked) {
            // Reached this tier already, just hasn't filled its slots yet —
            // send them straight to the picker instead of switching packs.
            card.addEventListener("click", openModal);
          }
          cards.appendChild(card);
        });

        if (tierLockedCount > 0) {
          var unlockPkg = packages[nextUnlockIndex];
          var hint = document.createElement("p");
          hint.className = "magyx-slot-builder__gifts-hint";
          hint.textContent =
            "Choose " +
            ((unlockPkg && unlockPkg.label) || "a bigger pack") +
            " to unlock " +
            tierLockedCount +
            " more free gift" +
            (tierLockedCount === 1 ? "" : "s") +
            "!";
          giftsEl.appendChild(hint);
        }
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
        renderGifts();
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
