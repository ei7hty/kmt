# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Updating the tire catalog

`scripts/scrape-tires.mjs` pulls real tires from giga-tires.com into a
reviewable JSON snapshot at `src/data/scraped-tires.json`.

```bash
npm run scrape-tires -- 215/60R16 225/50R17 --limit 6
npm run scrape-tires -- 215/60R16 --dry-run     # report only, writes nothing
npm run scrape-tires -- --help
```

It is a person-in-the-loop tool, not a scheduled job. It writes a snapshot and
prints a diff (added, removed, repriced, back in or out of stock); it never
touches `src/data/catalog.js`. Wiring the snapshot into the live catalog is a
separate, deliberate step, because what KMT charges is not what giga-tires
charges.

A run over one size updates that size and leaves the rest of the snapshot
alone. Pass `--replace` to drop sizes the run did not cover.

### Why it opens a browser window

giga-tires.com sits behind AWS WAF. A plain HTTP request gets a challenge page
and a *headless* browser is refused outright, so the scraper drives an ordinary
visible browser instead and reads pages the way a person would. There is no
stealth plugin, no spoofed user agent and no token replay: if the site decides
to turn this away, it should be able to.

What keeps that reasonable is staying small and honest -- one window, one page
at a time, a pause between requests, and only the `/tires/` paths their
robots.txt allows. It is not built to run unattended or at volume. If KMT ends
up wanting this regularly, the right move is to ask giga-tires for a dealer
feed rather than to scrape harder.

### Layout

| File | Job |
|---|---|
| `scripts/scrape-tires.mjs` | CLI: arguments, the run loop, the diff, the snapshot |
| `scripts/giga-tires.mjs` | Parsing and normalising one listing page. Pure, so it can be tested on saved HTML |
| `scripts/browser-fetch.mjs` | Fetching pages through a real browser |

Rows come out in the shape `src/data/catalog.js` already uses (`id`, `name`,
`size`, `price`, `inStock`, `category`, `description`) plus a `source` block
holding the SKU, stock count, list price and product URL, so any row can be
traced back to the page it came from.
