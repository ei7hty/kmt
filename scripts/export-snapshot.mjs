#!/usr/bin/env node
/**
 * Export the supplier table as a scrape snapshot, for build-image-mapping.
 *
 *   node export-snapshot.mjs /data/owner.sqlite /tmp/snapshot-production.json
 *
 * WHY. `build-image-mapping.mjs` reads a snapshot because that is where
 * `source.url` lives, and the committed one covers 703 of production's 1,353
 * models -- so every remaining photo gap is a model it cannot map. The rows it
 * is missing are not lost; they are already in the owner database, imported
 * from scrapes that were never committed to the repository. This reads them
 * back out in the shape the tool expects, which costs the supplier nothing.
 *
 * READ-ONLY, AND THE SUPPLIER TABLE ONLY. It opens the database, runs one
 * SELECT, and writes one file. It touches no customer request, quote, outbox
 * row or session -- the point is that only tire data leaves the machine, so
 * the export can be downloaded without moving anyone's personal data off the
 * server.
 *
 * `active=1` on purpose: a row the supplier has delisted should not be
 * photographed, and `catalog()` already treats it as out of stock.
 */
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'

const [database, output] = process.argv.slice(2)
if (!database || !output) {
  console.error('Use: node export-snapshot.mjs ABS_DB ABS_OUT')
  process.exit(1)
}

const db = new DatabaseSync(database, { readOnly: true })
try {
  const rows = db.prepare('SELECT payload FROM supplier WHERE active=1 ORDER BY size, id').all()
  const tires = rows.map(row => JSON.parse(row.payload))
  const sizes = [...new Set(tires.map(tire => tire.size))].sort()
  // Same top-level shape as src/data/scraped-tires.json. `coverage` is left
  // empty rather than invented: this is an export of what the database holds,
  // not a record of a walk that happened, and claiming coverage it cannot
  // vouch for is how a snapshot starts lying about its own completeness.
  const snapshot = { source: 'kmt-owner-db', scrapedAt: new Date().toISOString(), sizes, coverage: {}, tires }
  writeFileSync(output, JSON.stringify(snapshot))
  const models = new Set(tires.map(tire => String(tire.name ?? '').trim().toLowerCase())).size
  console.log(JSON.stringify({ tires: tires.length, sizes: sizes.length, models, output }))
} finally {
  db.close()
}
