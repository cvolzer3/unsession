# Unsession

Conference session booking platform: call for speakers → evaluation → decisions → speaker onboarding → agenda building → public publication. A focused, fast alternative to Sessionboard's Program product.

- **Stack:** Cloudflare Workers (Hono + JSX SSR, TypeScript) · D1 · R2 · Email Service · vanilla-JS islands
- **Live:** https://unsession.dev (admin at `/app`)
- **Docs:** `PLAN.md` (architecture + build plan) · `DECISIONS.md` (product decisions + open questions) · `SPECS/` (per-track build specs) · `prototype/` (hi-fi design reference — the visual source of truth) · `src/CONVENTIONS.md` (code conventions)

## Development

```sh
npm install
npm run db:migrate:local   # apply D1 migrations locally
npm run dev                # wrangler dev
npm run deploy             # deploy to Cloudflare (unsession account)
```
