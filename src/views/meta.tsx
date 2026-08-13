/**
 * Shared `<head>` metadata for link sharing. One component renders the title,
 * description, canonical URL, and the Open Graph / Twitter card tags so every
 * page that can be pasted into Slack or social unfurls the same way: the
 * page's own content as the text, the brand card (`/og.png`, 1200×630 —
 * regenerate with scripts/make-og-image.sh) as the visual.
 */
import type { FC } from 'hono/jsx';

export const SITE_NAME = 'Unsession';

/** Favicon links only — for chrome-less shells (admin, auth) that don't need share tags. */
export const Favicons: FC = () => (
  <>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
    <meta name="theme-color" content="#4c5fd5" />
  </>
);

export const SocialMeta: FC<{
  /** Page title as shared — rendered verbatim into `<title>` and og:title. */
  title: string;
  description: string;
  /**
   * Absolute canonical URL of this page; og:image must also be absolute, so
   * this doubles as its base. Omit when the layout doesn't know its own URL —
   * canonical and og:url are skipped, and a relative `image` is skipped too.
   */
  url?: string;
  /**
   * Share image path or absolute URL. Defaults to the brand card. Pass `null`
   * for pages whose content isn't Unsession's own (public event pages) — the
   * unfurl falls back to a text-only card instead of wearing our branding.
   */
  image?: string | null;
  imageAlt?: string;
  siteName?: string;
}> = ({ title, description, url, image = '/og.png', imageAlt, siteName = SITE_NAME }) => {
  const origin = url ? new URL(url).origin : null;
  const imageUrl = image && image.startsWith('http') ? image : image && origin ? origin + image : null;
  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
      {url ? <link rel="canonical" href={url} /> : null}
      <Favicons />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={siteName} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      {url ? <meta property="og:url" content={url} /> : null}
      {imageUrl ? (
        <>
          <meta property="og:image" content={imageUrl} />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:image:alt" content={imageAlt ?? `${siteName} — from open call to opening keynote`} />
        </>
      ) : null}
      <meta name="twitter:card" content={imageUrl ? 'summary_large_image' : 'summary'} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      {imageUrl ? <meta name="twitter:image" content={imageUrl} /> : null}
    </>
  );
};
