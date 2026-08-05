/* Merchant-authored CSS for the storefront widget. Pure, and deliberately not
   in a `.server` module: the settings form needs the length cap, and Remix
   refuses to bundle anything reachable from a `.server` file into the client.
   The server module that persists this imports from here. */

/* Ships on every product page that renders a widget, so it's capped. This is
   for tweaks — overriding a colour the settings don't expose, nudging spacing
   — not for hosting a stylesheet. */
export const CUSTOM_CSS_MAX_LENGTH = 20000;

/**
 * The merchant's CSS is injected into a `<style>` element on the storefront,
 * and Liquid does not escape output. Without this, typing `</style><script>`
 * into the settings field would be stored XSS on every product page.
 *
 * Stripping `<` is enough and costs nothing: CSS has no legitimate use for it.
 * Note `>` is deliberately kept — it's the child combinator (`.a > .b`), so
 * stripping it would silently break real stylesheets.
 *
 * Applied on write, and again in Liquid on read (`| remove: '<'`), so a row
 * written before this existed can't slip through.
 */
export function sanitizeCustomCss(css: string): string {
  return css.replace(/</g, "").slice(0, CUSTOM_CSS_MAX_LENGTH);
}
