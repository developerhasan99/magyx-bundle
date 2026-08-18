/* Every customer-facing string in this file comes from the shared catalogue
   in app/utils/slot-builder-text.ts rather than being written inline — the
   same module the admin's translations editor renders its fields from, so
   the two can't drift. `buildTranslator` there documents how a merchant's
   per-locale overrides are resolved; here they arrive on the display
   metafield as `settings.text`. The import is inlined at build time by
   esbuild's --bundle (see the build:widget-js script); nothing is fetched at
   runtime. */
import {
  buildLocaleValueResolver,
  buildPackageTextResolver,
  buildTranslator,
  PACK_PRICE_TEMPLATE_DEFAULT,
  PACK_PRICE_TEXT_KEY,
} from "../app/utils/slot-builder-text";

/* Magyx Bundle builder: customer fills every slot from the merchant's
   product pool via a selection modal, then adds the bundle's own parent
   product to cart, stamping the customer's picks onto the line as
   properties for the Cart Transform function to expand and validate.
   Two add-to-cart modes, decided per render (see `ctaMode`):
   - "native": the merchant's "Skip Cart" setting is off AND the theme has
     its own add-to-cart form on the page — no button of our own at all;
     that native form's submit is gated/stamped instead (same "native form
     integration" convention as the Bundle Contents and Quantity Breaks
     widgets), so the theme's own button drives cart/drawer behavior.
   - "checkout": either the merchant turned "Skip Cart" on, or no
     compatible native form was found (a plain button is the only way to
     guarantee the bundle stays purchasable). Always our own plain button —
     no <form> at all — that does a raw /cart/add.js fetch, then sends the
     customer straight to /checkout. */
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

  /* Splits a merchant string around the value that was interpolated into it,
     so the two halves can be stacked instead of running along one line —
     "$129.99 VALUE" becomes "$129.99" over "VALUE". Worth the split rather
     than letting CSS wrap it: a plain wrap breaks at whichever space happens
     to fall past the edge, which for a money format that uses spaces as
     thousands separators ("1 299,99 KR VÄRDE") is the wrong one.

     Splitting on the interpolated value instead means the break lands either
     side of it whatever the merchant's word order, and the value keeps its
     own class so it can be the emphasised half. A template that dropped the
     placeholder entirely just renders as one line. */
  function stackedHtml(label, token, tokenClass, restClass) {
    var at = token ? String(label).indexOf(token) : -1;
    if (at === -1) {
      return '<span class="' + restClass + '">' + escapeHtml(label) + "</span>";
    }
    var parts = [];
    var before = label.slice(0, at).trim();
    var after = label.slice(at + token.length).trim();
    if (before) parts.push([restClass, before]);
    parts.push([tokenClass, token]);
    if (after) parts.push([restClass, after]);
    return parts
      .map(function (part) {
        return '<span class="' + part[0] + '">' + escapeHtml(part[1]) + "</span>";
      })
      .join("");
  }


  // The cart-add form's hidden "id" field and Liquid's `variant.id` are plain
  // numeric ids; the metafield/proxy data carries GraphQL GIDs.
  function numericId(id) {
    return String(id || "").replace(/\D/g, "");
  }

  // Bundle Builder's product page is the bundle's own parent product (same
  // convention as Bundle Contents' magyx-bundle-fixed.js), so its regular
  // Buy Buttons form — if the merchant kept one on the page — already
  // targets one of this widget's own package variants.
  function findNativeAtcForm() {
    return document.querySelector('form[action*="/cart/add"]');
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

  /* Keeps the snapshot's subtext line on any live item that came back without
     one, matched by variant id across every package.

     Subtext is derived from the merchant's template, and the snapshot is
     rebuilt on every publish — so a snapshot subtext can never be stale
     against the current template, and clearing the template blanks both
     sides. That makes a missing live subtext a resolution failure (a
     throttled/errored metafield lookup soft-fails to null server-side) rather
     than a deliberate removal, and without this the line would visibly
     disappear the moment the live fetch replaced the snapshot — then come
     back on the next page load, which renders the snapshot first. */
  function carryOverSubtext(snapshotPool, livePool) {
    var subtextByVariantId = {};
    Object.keys(snapshotPool).forEach(function (packageVariantId) {
      (snapshotPool[packageVariantId] || []).forEach(function (item) {
        if (item && item.variantId && item.subtext) {
          subtextByVariantId[item.variantId] = item.subtext;
        }
      });
    });
    Object.keys(livePool).forEach(function (packageVariantId) {
      (livePool[packageVariantId] || []).forEach(function (item) {
        if (item && !item.subtext && subtextByVariantId[item.variantId]) {
          item.subtext = subtextByVariantId[item.variantId];
        }
      });
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

    var settings = data.settings || {};
    var t = buildTranslator(settings.text, settings.primaryLocale, root.dataset.locale);
    // Count-dependent strings are `_one`/`_other` pairs rather than one
    // string with a plural rule — the merchant writes the forms their own
    // language needs. English splits at 1; a language that doesn't simply
    // gets the same copy in both fields.
    function tn(baseKey, count, vars) {
      return t(baseKey + (count === 1 ? "_one" : "_other"), vars);
    }
    // Thin wrapper so call sites read `packageText.field(pkg, "label")` — the
    // shared resolver takes the translations map and an explicit fallback,
    // which for a package is always its own primary-locale field.
    var resolver = buildPackageTextResolver(settings.primaryLocale, root.dataset.locale);
    var packageText = {
      field: function (pkg, name) {
        return resolver.field(pkg && pkg.translations, name, (pkg && pkg[name]) || "");
      },
      chip: function (pkg, index, fallback) {
        return resolver.chip(pkg && pkg.translations, index, fallback);
      },
    };

    if (
      packages.length === 0 ||
      packages.some(function (p) {
        return !(p.slotCount > 0);
      })
    ) {
      root.remove();
      return;
    }

    /* Product and gift names come from the merchant's catalog, so they're
       translated in Shopify's own Translate & Adapt rather than in this app's
       Translations card — they arrive as a `titleByLocale` map beside the
       untranslated `title`. The subtext line arrives the same way
       (`subtextByLocale`), though it's translated in this app: it's a template
       resolved against product data, so the server bakes one finished line per
       language rather than sending the template here. Both are collapsed to a
       single `title`/`subtext` once, up front, so every render site downstream
       stays locale-agnostic.

       Only the baked-in snapshot and gifts need this. The live pool fetch
       below is given the shopper's locale and returns both already in it, with
       no maps attached — and an older metafield with no maps at all just keeps
       its untranslated values. */
    var localizedValue = buildLocaleValueResolver(
      settings.primaryLocale,
      root.dataset.locale,
    );
    function applyLocalizedText(items) {
      (items || []).forEach(function (item) {
        if (!item) return;
        if (item.titleByLocale) {
          item.title = localizedValue(item.titleByLocale, item.title);
        }
        if (item.subtextByLocale) {
          item.subtext = localizedValue(item.subtextByLocale, item.subtext);
        }
      });
    }
    packages.forEach(function (pkg) {
      applyLocalizedText(pkg.poolSnapshot);
      applyLocalizedText(pkg.gifts);
    });

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

    // The locale rides in the query string, not a header, so it's part of the
    // URL the 60s Cache-Control applies to — a Swedish shopper and an English
    // one can't be served each other's cached titles.
    fetch(
      "/apps/magyx-bundle/slot-builder/" +
        encodeURIComponent(data.bundleId) +
        "?locale=" +
        encodeURIComponent(root.dataset.locale || ""),
    )
      .then(function (response) {
        if (!response.ok) throw new Error("Bundle builder unavailable");
        return response.json();
      })
      .then(function (pool) {
        var livePoolByVariantId = buildPoolMap(pool.packages, "items");
        carryOverSubtext(poolByVariantId, livePoolByVariantId);
        if (rendered) {
          // Update the same object in place — currentPoolItems()/renderList()
          // read straight off this reference, so the next modal open or pack
          // switch picks up the fresh data without disturbing any picks the
          // shopper already made against the snapshot.
          //
          // Do not replace the whole map. A bundle can be republished while a
          // cached product page still has its previous package variant IDs.
          // In that brief state the proxy response is valid but keyed by the
          // new IDs; replacing the map would make every old page key resolve
          // to an empty pool. Merge only response packages the page knows and
          // retain its publish-time snapshot for unmatched packages.
          var pagePackageIds = new Set(
            packages.map(function (pkg) {
              return numericId(pkg.variantId);
            }),
          );
          var matchedLivePackage = false;
          for (var liveKey in livePoolByVariantId) {
            if (
              Object.prototype.hasOwnProperty.call(livePoolByVariantId, liveKey) &&
              pagePackageIds.has(liveKey)
            ) {
              poolByVariantId[liveKey] = livePoolByVariantId[liveKey];
              matchedLivePackage = true;
            }
          }
          if (!matchedLivePackage) {
            console.warn(
              "Magyx Bundle: live pool package variants do not match this page's published bundle data; keeping the snapshot until the page is refreshed.",
            );
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
      /* The pack the merchant marked as default, else the first — which is
         both what every bundle predating the flag gets (nothing to backfill)
         and what happens if the default package is later deleted. Only the
         opening pack is affected: gifts and free shipping still inherit from
         packages *before* it, exactly as when the shopper switches tabs. */
      var activePackageIndex = 0;
      for (var p = 0; p < packages.length; p++) {
        if (packages[p].isDefault) {
          activePackageIndex = p;
          break;
        }
      }

      function currentPoolItems() {
        var pkg = activePackage();
        return poolByVariantId[numericId(pkg.variantId)] || [];
      }

      // See the file header for what "native" vs "checkout" mean.
      var skipCart = !!(data.settings && data.settings.skipCart);
      var nativeForm = !skipCart ? findNativeAtcForm() : null;
      // A form with no "id" field can't be synced/gated at all — treat it
      // the same as no compatible form being found (matches the Quantity
      // Breaks widget's identical check).
      if (nativeForm && !nativeForm.querySelector('[name="id"]')) nativeForm = null;
      var ctaMode = nativeForm ? "native" : "checkout";

      // We're already stamping the native form with this bundle's
      // properties/variant, so its button's label can track the same
      // "Choose N more" / "Add to cart — $X" copy our own CTA shows.
      // innerHTML (not textContent on some inner span) so any other markup
      // the theme puts in there — icon, loading spinner, sold-out text —
      // gets fully replaced instead of sitting alongside our label.
      var nativeCtaBtn =
        ctaMode === "native"
          ? nativeForm.querySelector('[name="add"]') ||
            nativeForm.querySelector('button[type="submit"]')
          : null;

      var html = "";
      html +=
        '<div class="magyx-slot-builder__price" data-sb="price" hidden>' +
        '<span class="magyx-slot-builder__price-sale" data-sb="price-sale"></span>' +
        '<span class="magyx-slot-builder__price-compare" data-sb="price-compare" hidden></span>' +
        '<span class="magyx-slot-builder__price-save" data-sb="price-save" hidden></span>' +
        "</div>";
      html +=
        '<p class="magyx-slot-builder__price-per-unit" data-sb="price-per-unit" hidden></p>';
      // `settings.heading` is the primary-locale copy the merchant typed in
      // the Appearance card; per-locale versions ride along in `text` under
      // the same reserved key every other string uses.
      var headingText = t("heading") || settings.heading || "";
      if (headingText) {
        html +=
          '<p class="magyx-slot-builder__heading">' + escapeHtml(headingText) + "</p>";
      }
      if (packages.length > 1) {
        html +=
          '<div class="magyx-slot-builder__packs" data-sb="packs" role="tablist"></div>';
      }
      /* Gifts go under the slots by default — what the shopper has to do
         first comes first. `giftsBeforeSlots` lifts them above the progress
         line instead (so above the whole builder, not just the slot rows),
         which is what a bundle sold on its gifts wants to lead with.

         Only where this string is written changes: renderGifts() works off
         the [data-sb] hook and doesn't care where in the tree it ended up. */
      var giftsHtml =
        '<div class="magyx-slot-builder__gifts" data-sb="gifts" hidden></div>';
      if (settings.giftsBeforeSlots) html += giftsHtml;
      html +=
        '<div class="magyx-slot-builder__progress" data-sb="progress"></div>';
      // Supporting copy under the progress line — same reserved-key treatment
      // as `heading` above, and like it, absent markup rather than an empty
      // element when the merchant hasn't written one.
      var descriptionText = t("description") || settings.description || "";
      if (descriptionText) {
        html +=
          '<p class="magyx-slot-builder__description">' +
          escapeHtml(descriptionText) +
          "</p>";
      }
      // One row per slot, filled or empty — the empty rows are themselves the
      // way into the picker, so there's no separate "Add items" button.
      html += '<div class="magyx-slot-builder__slots" data-sb="slots"></div>';
      if (!settings.giftsBeforeSlots) html += giftsHtml;
      html +=
        '<p class="magyx-slot-builder__error" data-sb="error" hidden></p>';
      if (ctaMode === "checkout") {
        // No <form> at all — a raw fetch + redirect to /checkout below.
        html +=
          '<button type="button" class="magyx-slot-builder__cta" data-sb="cta"></button>';
      }
      // ctaMode === "native": no button of our own — the theme's own
      // add-to-cart form and button (already on the page) do this instead.
      html +=
        '<div class="magyx-slot-builder-modal" data-sb="modal" hidden>' +
        '<div class="magyx-slot-builder-modal__overlay" data-sb="overlay"></div>' +
        '<div class="magyx-slot-builder-modal__panel" role="dialog" aria-modal="true">' +
        '<button type="button" class="magyx-slot-builder-modal__close" data-sb="close" aria-label="' +
        escapeHtml(t("close")) +
        '">&times;</button>' +
        '<div class="magyx-slot-builder-modal__header">' +
        '<p class="magyx-slot-builder-modal__title" data-sb="modal-title"></p>' +
        '<p class="magyx-slot-builder-modal__subtitle" data-sb="modal-subtitle"></p>' +
        "</div>" +
        '<div class="magyx-slot-builder-modal__filters" data-sb="filters" hidden></div>' +
        '<div class="magyx-slot-builder-modal__search-wrap">' +
        '<svg class="magyx-slot-builder-modal__search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg>' +
        '<input type="text" class="magyx-slot-builder-modal__search" data-sb="search" placeholder="' +
        escapeHtml(t("searchPlaceholder")) +
        '" autocomplete="off">' +
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
      var slotsEl = stateEl.querySelector('[data-sb="slots"]');
      var giftsEl = stateEl.querySelector('[data-sb="gifts"]');
      var errorEl = stateEl.querySelector('[data-sb="error"]');
      var modalEl = stateEl.querySelector('[data-sb="modal"]');
      var modalTitleEl = stateEl.querySelector('[data-sb="modal-title"]');
      var modalSubtitleEl = stateEl.querySelector('[data-sb="modal-subtitle"]');
      var filtersEl = stateEl.querySelector('[data-sb="filters"]');
      var searchInputEl = stateEl.querySelector('[data-sb="search"]');
      var listEl = stateEl.querySelector('[data-sb="list"]');
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
          // Display-only: the Cart Transform validates against
          // `_magyx_slot_selection` below, never these numbered keys, so
          // translating them can't affect what the customer is charged.
          props.push({ key: t("lineItemProperty", { index: index }), value: value });
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
        // Gift cards depend only on which package is active, so they're
        // rerendered here alongside the tabs rather than in update() — no
        // need to rebuild them on every stepper click.
        renderGifts();
        update();
        syncActiveVariant();
      }

      // "checkout" mode reads activePackage().variantId directly at add-to-
      // cart time, so only "native" mode needs the theme's form kept in
      // sync as the shopper switches packs (and once up front, since the
      // theme's own selected variant has no idea which pack the merchant
      // marked as the default one to open on).
      function syncActiveVariant() {
        if (ctaMode !== "native") return;
        var pkg = activePackage();
        if (!pkg.variantId) return;
        var idField = nativeForm.elements["id"];
        if (idField) {
          idField.value = numericId(pkg.variantId);
          idField.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      /* Fills a merchant's price template ("{per_item_compare_at_price}
         {per_item_price} / bottle") with a package's money, for the two lines
         written that way: the price inside each pack tab and the per-item
         line under the total.

         `per_item_*` divide by the package's own slot count rather than
         summing the pool's item prices, so neither line can disagree with the
         total. Dividing is always safe — a package with no slot count takes
         the whole widget down at init.

         Both compare-at shortcodes resolve to nothing unless the compare-at
         is genuinely higher than what the shopper pays, the same rule
         renderPrice() applies: neither line may strike through a price that
         isn't a saving. That can leave a stray space where the shortcode was,
         which HTML collapses. */
      function priceTemplateHtml(template, pkg) {
        var slots = pkg.slotCount;
        var compare =
          pkg.compareAtPrice != null && pkg.compareAtPrice > pkg.price
            ? pkg.compareAtPrice
            : null;
        var money = {
          package_price: formatMoney(pkg.price, moneyFormat),
          per_item_price: formatMoney(pkg.price / slots, moneyFormat),
          package_compare_at_price:
            compare == null ? null : formatMoney(compare, moneyFormat),
          per_item_compare_at_price:
            compare == null ? null : formatMoney(compare / slots, moneyFormat),
        };
        // The per-item line's original placeholder, before it grew the same
        // shortcode set as the pack tabs. Still honoured so a shop that
        // translated "Nur {amount} pro Stück" doesn't start showing the raw
        // shortcode in German.
        money.amount = money.per_item_price;

        /* Escaped first, then the shortcodes are swapped for markup — the
           merchant's own words can't smuggle in HTML, and escaping leaves
           `{...}` untouched so every shortcode still matches afterwards. An
           unknown one is left as typed (same as `interpolate`), so a typo
           shows up on the storefront instead of silently vanishing. */
        return escapeHtml(template).replace(
          /\{(\w+)\}/g,
          function (match, name) {
            if (!Object.prototype.hasOwnProperty.call(money, name)) return match;
            if (money[name] == null) return "";
            return (
              '<span class="magyx-slot-builder__money magyx-slot-builder__money--' +
              (name.indexOf("compare") === -1 ? "sale" : "compare") +
              '">' +
              escapeHtml(money[name]) +
              "</span>"
            );
          },
        );
      }

      /* The price line inside a pack tab. Defaults to the per-item pair
         rather than the pack total: "$24.75 a bottle" is what makes a bigger
         pack look like the better deal at a glance, and the total is still
         spelled out under the tabs by renderPrice(). */
      function packPriceHtml(pkg) {
        if (pkg.price == null) return "";
        var template = t(PACK_PRICE_TEXT_KEY) || settings.packPriceTemplate || "";
        if (!template.trim()) template = PACK_PRICE_TEMPLATE_DEFAULT;
        return (
          '<span class="magyx-slot-builder__pack-tab-price">' +
          priceTemplateHtml(template, pkg) +
          "</span>"
        );
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
          var badgeText = packageText.field(pkg, "badgeText");
          var badge = badgeText
            ? '<span class="magyx-slot-builder__pack-badge magyx-slot-builder__pack-badge--' +
              escapeHtml(pkg.badgeTone || "info") +
              '">' +
              escapeHtml(badgeText) +
              "</span>"
            : "";
          tab.innerHTML =
            badge +
            '<span class="magyx-slot-builder__pack-tab-label">' +
            escapeHtml(packageText.field(pkg, "label")) +
            "</span>" +
            packPriceHtml(pkg);
          tab.addEventListener("click", function () {
            selectPackage(index);
          });
          container.appendChild(tab);
        });
      }

      /* Sale price is this package's own (flat) price; the compare-at is
         whatever publish wrote to the package's Shopify variant — the
         merchant's override if they set one, otherwise the pool average times
         the slot count — baked into the metafield already filtered down to
         "actually a saving".

         It used to be summed here from the first `slotCount` pool items,
         which made this a third calculation that could disagree with both the
         variant and the editor's preview, and ignored the override. */
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

        var comparePrice = pkg.compareAtPrice != null ? pkg.compareAtPrice : null;
        var hasSavings = comparePrice != null && comparePrice > salePrice;
        priceCompareEl.hidden = !hasSavings;
        priceSaveEl.hidden = !hasSavings;
        if (hasSavings) {
          priceCompareEl.textContent = formatMoney(comparePrice, moneyFormat);
          // Both forms are offered so the merchant's copy decides which shows:
          // the default is "{percent}%", but a translation written as
          // "Save {amount}" keeps rendering the money saved.
          //
          // Floored, never rounded — comparePrice is strictly greater than
          // salePrice here so there's no divide-by-zero, and rounding 24.6%
          // up to "25% off" advertises a discount the shopper doesn't get.
          priceSaveEl.textContent = t("priceSave", {
            percent: Math.floor(((comparePrice - salePrice) / comparePrice) * 100),
            amount: formatMoney(comparePrice - salePrice, moneyFormat),
          });
        }

        /* Same shortcode template treatment as the pack tabs, including the
           struck-through compare-at — `t()` is asked for the raw string (no
           vars) so the shortcodes survive to priceTemplateHtml.

           A merchant who clears the Storefront field gets no line at all,
           which is why this key alone has no built-in English default to fall
           back to: one would resurrect the line they just deleted. */
        var perUnitTemplate =
          t("pricePerUnit") || settings.pricePerUnitTemplate || "";
        pricePerUnitEl.hidden = !perUnitTemplate.trim();
        if (!pricePerUnitEl.hidden) {
          pricePerUnitEl.innerHTML = priceTemplateHtml(perUnitTemplate, pkg);
        }
      }

      function renderProgress() {
        var total = totalQty();
        var left = remaining();
        progressEl.textContent =
          left > 0
            ? tn("progressChoose", left, { count: left })
            : t("progressComplete", {
                count: total,
                total: activePackage().slotCount || 0,
              });
        progressEl.classList.toggle(
          "magyx-slot-builder__progress--complete",
          left === 0,
        );
      }

      /* One row per slot, always `slotCount` of them — a filled slot shows
         its product, an empty one is a tappable placeholder that opens the
         picker. Replaces the old "one row per selection + a single Add Items
         button" layout: showing the empty slots up front makes the size of
         the job obvious before the shopper starts.

         An item picked more than once occupies that many slots, so the rows
         are the selections flattened by quantity rather than the Map itself.
         Quantity is still adjusted from the picker's own steppers; a slot row
         only removes, which decrements by one. */
      function slotOccupants() {
        var occupants = [];
        selections.forEach(function (item) {
          for (var i = 0; i < item.quantity; i++) occupants.push(item);
        });
        return occupants;
      }

      function renderSlots() {
        slotsEl.innerHTML = "";
        var occupants = slotOccupants();
        var slots = activePackage().slotCount || 0;
        for (var index = 0; index < slots; index++) {
          slotsEl.appendChild(
            occupants[index]
              ? filledSlot(occupants[index], index)
              : emptySlot(index),
          );
        }
      }

      function slotNumber(index) {
        return (
          '<span class="magyx-slot-builder__slot-number">' + (index + 1) + "</span>"
        );
      }

      function filledSlot(item, index) {
        var row = document.createElement("div");
        row.className =
          "magyx-slot-builder__slot magyx-slot-builder__slot--filled";
        row.innerHTML =
          slotNumber(index) +
          (item.image
            ? '<img class="magyx-slot-builder__slot-image" loading="lazy" src="' +
              item.image +
              '" alt="' +
              escapeHtml(item.title) +
              '">'
            : '<div class="magyx-slot-builder__slot-image"></div>') +
          '<div class="magyx-slot-builder__slot-info">' +
          '<span class="magyx-slot-builder__slot-title">' +
          escapeHtml(item.title) +
          "</span>" +
          (item.subtext
            ? '<span class="magyx-slot-builder__slot-subtext">' +
              escapeHtml(item.subtext) +
              "</span>"
            : "") +
          "</div>" +
          '<button type="button" class="magyx-slot-builder__slot-remove" aria-label="' +
          escapeHtml(t("a11yRemove", { title: item.title })) +
          '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
        row
          .querySelector(".magyx-slot-builder__slot-remove")
          .addEventListener("click", function () {
            // Frees this one slot, not every copy of the product.
            item.quantity -= 1;
            if (item.quantity <= 0) selections.delete(item.variantId);
            else selections.set(item.variantId, item);
            update();
          });
        return row;
      }

      // Phrasing content only — this row is itself a <button>, so it can't
      // contain the <div>s the filled row uses.
      function emptySlot(index) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "magyx-slot-builder__slot magyx-slot-builder__slot--empty";
        row.innerHTML =
          slotNumber(index) +
          '<span class="magyx-slot-builder__slot-image magyx-slot-builder__slot-image--empty">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>' +
          "</span>" +
          '<span class="magyx-slot-builder__slot-info">' +
          '<span class="magyx-slot-builder__slot-title">' +
          escapeHtml(t("slotEmptyTitle")) +
          "</span>" +
          '<span class="magyx-slot-builder__slot-subtext">' +
          escapeHtml(t("slotEmptyHint")) +
          "</span>" +
          "</span>" +
          '<span class="magyx-slot-builder__slot-action">' +
          escapeHtml(t("slotEmptyAction")) +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
          "</span>";
        row.addEventListener("click", openModal);
        return row;
      }

      /* ---- Progressive free gifts --------------------------------------
         Every package's gifts render as cards in two states, decided purely
         by which package tab is active:
         - UNLOCKED — the active package's own gifts and every earlier
           package's. Shown plainly, image and title visible.
         - EXCLUSIVE — a later package's gifts, rendered light gray behind a
           padlock and "{Package} Exclusive" to nudge shoppers toward the
           bigger pack; clicking one switches to the package that unlocks it.

         Filling slots is deliberately NOT a condition: picking the tab is the
         whole gesture, so the shopper sees what they've earned the moment
         they choose a pack rather than having it withheld until the box is
         full. Purely presentational either way — checkout truth is the
         cumulative gift list baked into the shop config metafield at sync
         time. */

      // Flattens every package's own gifts in unlock (tab) order, deduped by
      // variantId — the earliest package's entry wins, mirroring checkout's
      // cumulative merge. A package with free shipping enabled contributes
      // one extra virtual "gift" card (no variant/price, just a shipping
      // icon) the first time it turns on, so the perk shows up alongside
      // product gifts.
      function progressiveGifts() {
        var seen = {};
        var entries = [];
        var shippingAdded = false;
        packages.forEach(function (pkg, pkgIndex) {
          (((pkg && pkg.gifts) || [])).forEach(function (gift, giftIndex) {
            var key = String(gift.variantId || pkgIndex + ":" + giftIndex);
            if (seen[key]) return;
            seen[key] = true;
            entries.push({ gift: gift, unlockIndex: pkgIndex });
          });
          if (pkg && pkg.freeShipping && !shippingAdded) {
            shippingAdded = true;
            entries.push({
              gift: {
                title: t("giftFreeShipping"),
                isShipping: true,
                quantity: 1,
                price: null,
              },
              unlockIndex: pkgIndex,
            });
          }
        });
        return entries;
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
        heading.textContent = t("giftsHeading");
        giftsEl.appendChild(heading);

        var cards = document.createElement("div");
        cards.className = "magyx-slot-builder__gift-cards";
        giftsEl.appendChild(cards);

        entries.forEach(function (entry) {
          var gift = entry.gift;
          // Reaching the tier is the only condition — see the note above
          // progressiveGifts. Filling the box doesn't gate anything.
          var unlocked = entry.unlockIndex <= activePackageIndex;

          var titleText = gift.isShipping ? t("giftFreeShipping") : gift.title;
          var unlockPkg = packages[entry.unlockIndex];
          var unlockPkgLabel = unlockPkg
            ? packageText.field(unlockPkg, "label")
            : "";
          var lockLabel = unlockPkgLabel
            ? t("giftExclusive", { pack: unlockPkgLabel })
            : t("giftLocked");

          // Only an exclusive card is interactive (it switches packs); an
          // unlocked one is inert, so it stays a plain div.
          var card = document.createElement(unlocked ? "div" : "button");
          if (!unlocked) card.type = "button";
          card.className =
            "magyx-slot-builder__gift-card" +
            (unlocked ? "" : " magyx-slot-builder__gift-card--exclusive");

          /* Same row anatomy as a filled slot above — leading thumbnail, title
             block, one trailing control — so the two lists read as one design
             instead of a row list sitting on top of a thumbnail grid.

             Phrasing content only: an exclusive card is a <button>, which
             can't legally contain the <div>s a grid card used. Same constraint
             emptySlot() works under. */
          var quantity = gift.quantity || 1;
          // Matches the cart line property's own "2 × Vanilla Candle" form
          // rather than a separate quantity chip — one less thing on the row,
          // and the shopper sees the same phrasing here and in their cart.
          var titleLine = (quantity > 1 ? quantity + " × " : "") + titleText;
          card.title = titleLine;

          var value = !gift.isShipping && gift.price != null ? gift.price * quantity : null;
          var amountText = value != null ? formatMoney(value, moneyFormat) : "";

          card.innerHTML =
            (gift.isShipping
              ? '<span class="magyx-slot-builder__gift-image magyx-slot-builder__gift-image--shipping">' +
                '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="6" width="14" height="11" rx="1"></rect><path d="M15 10h4l3 3v4h-7z"></path><circle cx="6" cy="19" r="2"></circle><circle cx="17.5" cy="19" r="2"></circle></svg>' +
                "</span>"
              : gift.imageUrl
                ? '<img class="magyx-slot-builder__gift-image" loading="lazy" src="' +
                  gift.imageUrl +
                  '" alt="' +
                  escapeHtml(titleText) +
                  '">'
                : '<span class="magyx-slot-builder__gift-image"></span>') +
            '<span class="magyx-slot-builder__gift-info">' +
            '<span class="magyx-slot-builder__gift-title">' +
            escapeHtml(titleLine) +
            "</span>" +
            // The merchant's subtext line, resolved per gift at publish time.
            // A row has the width for it; the old grid card never did, so it
            // was baked into the metafield and then thrown away here.
            (gift.subtext
              ? '<span class="magyx-slot-builder__gift-subtext">' +
                escapeHtml(gift.subtext) +
                "</span>"
              : "") +
            "</span>" +
            (unlocked
              ? value != null && value > 0
                ? '<span class="magyx-slot-builder__gift-value">' +
                  stackedHtml(
                    t("giftValue", { amount: amountText }),
                    amountText,
                    "magyx-slot-builder__gift-value-amount",
                    "magyx-slot-builder__gift-value-label",
                  ) +
                  "</span>"
                : ""
              : '<span class="magyx-slot-builder__gift-lock">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path><circle cx="12" cy="15.5" r="1.5" fill="currentColor" stroke="none"></circle></svg>' +
                '<span class="magyx-slot-builder__gift-lock-text">' +
                // Stacked on the package name for the same reason the value
                // badge is: "50ML" over "Exclusive" is half the width.
                stackedHtml(
                  lockLabel,
                  unlockPkgLabel,
                  "magyx-slot-builder__gift-lock-pack",
                  "magyx-slot-builder__gift-lock-word",
                ) +
                "</span>" +
                "</span>");

          if (!unlocked) {
            var unlockIndex = entry.unlockIndex;
            card.addEventListener("click", function () {
              selectPackage(unlockIndex);
            });
          }
          cards.appendChild(card);
        });
      }

      // Shared by our own CTA button and (in "native" mode) the theme's own
      // submit button label.
      function ctaLabel() {
        var pkg = activePackage();
        var left = remaining();
        if (left > 0) return tn("ctaChoose", left, { count: left });
        return pkg && pkg.price != null
          ? t("ctaAddPriced", { price: formatMoney(pkg.price, moneyFormat) })
          : t("ctaAdd");
      }

      function renderCta() {
        if (!ctaBtn) return;
        ctaBtn.textContent = ctaLabel();
        ctaBtn.disabled = remaining() > 0;
      }

      function renderNativeCta() {
        if (!nativeCtaBtn) return;
        nativeCtaBtn.innerHTML = escapeHtml(ctaLabel());
        nativeCtaBtn.disabled = remaining() > 0;
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
        // The automatic "All" chip is index -1 in the merchant's own chip
        // list, so its label comes from the shared catalogue while every
        // other chip resolves against the package's positional overrides.
        var chips = [{ label: t("filterAll"), tag: null, index: -1 }].concat(
          filters.map(function (filter, index) {
            // Chip labels are translated positionally against this list; the
            // `tag` a chip matches is never translated, only its button text.
            return {
              label: packageText.chip(pkg, index, filter.label),
              tag: filter.tag,
              index: index,
            };
          }),
        );
        chips.forEach(function (filter) {
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
          empty.textContent = t("emptyPool");
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
          noMatch.textContent = searchText ? t("emptySearch") : t("emptyFilter");
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
            '<button type="button" data-action="decrement" aria-label="' +
            escapeHtml(t("a11yRemoveOne", { title: item.title })) +
            '"' +
            (qty === 0 ? " disabled" : "") +
            ">−</button>" +
            '<span class="magyx-slot-builder-modal__qty">' +
            qty +
            "</span>" +
            '<button type="button" data-action="increment" aria-label="' +
            escapeHtml(t("a11yAddOne", { title: item.title })) +
            '"' +
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
            ? t("modalTitleReady")
            : tn("modalTitle", left, { count: left });
        modalSubtitleEl.textContent = t("modalSubtitle", { count: slots });
      }

      /* ---- Automatic checkout -------------------------------------------
         With the merchant's "go to checkout as soon as the last slot is
         filled" setting on, the shopper never presses anything: filling the
         final slot submits for them. It rides on the same button "checkout"
         mode already renders, so it's only reachable when Skip Cart is on —
         guarded again here in case an older metafield was baked with the two
         out of step.

         Armed by the transition to a full box, not by fullness itself:
         update() runs on every change, including the re-render after a failed
         submit, so without the latch a failure would resubmit forever. Emptying
         a slot (or switching packs, which clears the picks) re-arms it. */
      var autoCheckout = !!settings.autoCheckout && ctaMode === "checkout";
      var autoCheckoutFired = false;
      var autoCheckoutTimer = null;

      // Long enough for the shopper to see their final pick register and the
      // modal close (which itself runs on a 350ms timer) — submitting out
      // from under an open modal reads as a glitch, not as their own action.
      var AUTO_CHECKOUT_DELAY = 550;

      function maybeAutoCheckout() {
        if (!autoCheckout) return;
        if (remaining() > 0) {
          // Dropping below full cancels any submit still counting down, so a
          // fill → remove → fill sequence can't leave two timers pending and
          // add the bundle to the cart twice.
          clearTimeout(autoCheckoutTimer);
          autoCheckoutTimer = null;
          autoCheckoutFired = false;
          return;
        }
        if (autoCheckoutFired) return;
        autoCheckoutFired = true;
        autoCheckoutTimer = setTimeout(function () {
          autoCheckoutTimer = null;
          // Re-checked on the way out: the shopper has had the delay to
          // remove something, and submitting a box they've since emptied
          // would be worse than doing nothing.
          if (remaining() === 0) submitToCheckout();
        }, AUTO_CHECKOUT_DELAY);
      }

      function update() {
        renderPrice();
        renderSlots();
        renderProgress();
        renderCta();
        renderNativeCta();
        renderModalHeader();
        errorEl.hidden = true;
        maybeAutoCheckout();
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
        errorEl.textContent = tn("errorIncomplete", left, { count: left });
        openModal();
      }

      // Shared source of truth for both the hidden-input form path
      // (injectProperties) and the raw-fetch JSON path (checkout mode).
      function allProperties() {
        var props = buildProperties();
        props.push({ key: "_magyx_slot_bundle_id", value: data.bundleId });
        props.push({
          key: "_magyx_slot_selection",
          value: JSON.stringify(selectionArray()),
        });
        return props;
      }

      function propertiesObject() {
        var obj = {};
        allProperties().forEach(function (property) {
          obj[property.key] = property.value;
        });
        return obj;
      }

      function injectProperties(form) {
        form
          .querySelectorAll("[data-magyx-slot-builder-property]")
          .forEach(function (el) {
            el.remove();
          });
        allProperties().forEach(function (property) {
          var input = document.createElement("input");
          input.type = "hidden";
          input.name = "properties[" + property.key + "]";
          input.value = property.value;
          input.setAttribute("data-magyx-slot-builder-property", "");
          form.appendChild(input);
        });
      }

      if (ctaMode === "native") {
        // Global + capturing so this fires before the theme's own submit
        // handling, and works no matter how the theme re-renders/replaces
        // its variant picker form. Matches the variant id against this
        // bundle's own packages so an unrelated form elsewhere on the page
        // (e.g. a recommendations block) is never intercepted.
        var packageVariantIds = packages.map(function (pkg) {
          return numericId(pkg.variantId);
        });
        document.addEventListener(
          "submit",
          function (event) {
            var form = event.target;
            if (!(form instanceof HTMLFormElement)) return;
            if (!/\/cart\/add/.test(form.action)) return;
            var idField = form.elements["id"];
            var variantId = idField ? numericId(idField.value) : null;
            if (!variantId || packageVariantIds.indexOf(variantId) === -1) return;
            if (remaining() > 0) {
              event.preventDefault();
              showIncompleteError();
              return;
            }
            injectProperties(form);
          },
          true,
        );
      } else if (ctaMode === "checkout") {
        ctaBtn.addEventListener("click", function () {
          if (remaining() > 0) {
            showIncompleteError();
            return;
          }
          submitToCheckout();
        });
      }

      // The whole of "checkout" mode's add-to-cart: stamp the picks onto the
      // line, then hand off to /checkout. Shared by the button and — when the
      // merchant enabled it — the automatic submit below, so both paths give
      // identical feedback and identical recovery on failure.
      var checkoutInFlight = false;

      function submitToCheckout() {
        // Two callers now (the button and the timer) and a live /cart/add.js
        // in between — disabling the button isn't enough on its own, since
        // the automatic path never touches it.
        if (checkoutInFlight) return;
        checkoutInFlight = true;
        var pkg = activePackage();
        var originalLabel = ctaBtn.textContent;
        ctaBtn.disabled = true;
        ctaBtn.textContent = t("ctaAdding");
        fetch("/cart/add.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [
              {
                id: parseInt(numericId(pkg.variantId), 10),
                quantity: 1,
                properties: propertiesObject(),
              },
            ],
          }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error("add failed");
            window.location.href = "/checkout";
          })
          .catch(function () {
            // Puts the shopper back in control: the button returns to its
            // normal label so they can retry by hand. autoCheckoutFired
            // stays set, so the automatic path won't immediately retry on
            // its own and trap them in a loop.
            checkoutInFlight = false;
            ctaBtn.disabled = false;
            ctaBtn.textContent = originalLabel;
            alert(t("errorAddFailed"));
          });
      }

      renderPacks();
      renderGifts();
      update();
      syncActiveVariant();
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
