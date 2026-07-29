// Shared money formatting for the admin editor — the storefront widgets have
// their own formatMoney() using the theme's money_format, this is just for
// the Shopify admin UI, which only has the shop's ISO currency code to work
// with (no money_format there).
export function formatMoney(amount: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currencyCode}`;
  }
}

// For TextField prefixes where a full formatted amount doesn't fit (the
// merchant is typing the number themselves) — just the symbol/code, e.g. "$"
// or "kr".
export function currencySymbol(currencyCode: string): string {
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? currencyCode;
  } catch {
    return currencyCode;
  }
}
