# Brand assets: provenance and the swap rule

Derived on 2026-09-06 by the KMT lead from the three files the user placed in
`public/` (git-ignored there as watermarked previews from the seller,
DesignNoirCo): the primary "KENS / MOBILE TIRE" lockup on the navy ground, the
same lockup on white, and the sheet of compact "KMT" and "KENS" badges.

The user chose to ship these as they are. Every file below still carries the
seller's watermark; when the licensed, unwatermarked art arrives, regenerate
`public/brand/` from it with the same names and nothing in `src/` changes.

One condition on that swap, from the lead: `/brand/*` is served with
`Cache-Control: public, max-age=86400`, so a browser that has seen a file keeps
it for a day. The PR that swaps in the licensed art must also bump a version
query on every reference (`/brand/icon-192.png?v=2`) or give the files a new
suffix, so nobody holds a watermark for a day after the real art is live.

This note lives in `docs/`, not in `public/brand/` beside the files, because
everything under `public/` ships to the site as-is: for a while it was readable
at `/brand/SOURCES.md`, announcing the provenance and the watermarks to anyone
who asked. The files' provenance belongs in the repository, not on the web.

| file | use |
| --- | --- |
| `kens-dark-1200.webp`, `kens-dark-600.webp` | primary lockup on the dark theme: hero (1200) and nav (600) |
| `kens-light-1200.webp`, `kens-light-600.webp` | primary lockup on white: light surfaces, email templates |
| `kmt-dark-800.webp`, `kmt-light-800.webp` | compact "KMT" badge, dark and light |
| `kens-badge-dark-800.webp`, `kens-badge-light-800.webp` | compact "KENS" badge, dark and light |
| `icon-512.png`, `icon-192.png`, `icon-180.png`, `icon-64.png`, `icon-32.png` | the wheel alone on navy: manifest icons, apple-touch-icon (180), favicon fallbacks |
| `og-1200x630.jpg` | link preview image for shared URLs |

Brand ground: navy `#0d1b24`. Brand red: `#ed1c24` (already `--accent`).
Chrome/silver is reserved for the wordmark and the page headline; the flame
appears nowhere except inside the logo.
