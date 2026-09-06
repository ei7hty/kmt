#!/usr/bin/env node
/**
 * Cut the Census ZCTA gazetteer down to the ZIPs this business can reach.
 *
 * The service area (backend/service-area.mjs) needs a latitude and longitude
 * for a ZIP code to say how far a customer is from the base. The US Census
 * Bureau publishes one for every ZIP Code Tabulation Area in its Gazetteer
 * Files, public domain, about 34,000 rows. Only New England and eastern New
 * York are within any radius the business would set, so this keeps the
 * prefixes 010-069 (MA, RI, NH, ME, VT, CT) and 100-139 (New York City, Long
 * Island and the state north of them) and writes them to
 * backend/zip-centroids.json with a header saying where they came from and
 * when. The city is in the cut although it is well outside any radius: a
 * visitor from there should be told they are 190 miles away, not that their
 * ZIP is unrecognised.
 *
 * Rerunnable:  node scripts/cut-zip-centroids.mjs [--vintage 2024]
 *
 * The zip archive is read here rather than with a dependency: it holds one
 * deflated text file, and the central directory says where.
 *
 * The output is committed, and it sits beside the module rather than under
 * backend/data/ on purpose: .dockerignore excludes that whole directory (it
 * is where the local database lives), so a table there would be in git and
 * missing from the deployed image. Nothing imports it from src/, so it never
 * enters the customer bundle; .forge/bundle-leak-check.mjs would not catch a
 * ZIP table the way it catches supplier fields, so keep it that way by hand.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = path.join(ROOT, 'backend/zip-centroids.json')

/** Three-digit prefixes to keep, as inclusive ranges. */
const PREFIX_RANGES = [[10, 69], [100, 139]]

const vintageFlag = process.argv.indexOf('--vintage')
const VINTAGE = vintageFlag > -1 ? process.argv[vintageFlag + 1] : '2024'
const SOURCE_URL = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${VINTAGE}_Gazetteer/${VINTAGE}_Gaz_zcta_national.zip`

/** The first file in a zip archive, inflated. */
function firstEntry(archive) {
  const END_OF_CENTRAL_DIR = 0x06054b50
  let end = archive.length - 22
  while (end >= 0 && archive.readUInt32LE(end) !== END_OF_CENTRAL_DIR) end -= 1
  if (end < 0) throw new Error('Not a zip archive: no end-of-central-directory record.')
  const centralDir = archive.readUInt32LE(end + 16)

  const CENTRAL_FILE_HEADER = 0x02014b50
  if (archive.readUInt32LE(centralDir) !== CENTRAL_FILE_HEADER) throw new Error('Not a zip archive: bad central directory.')
  const method = archive.readUInt16LE(centralDir + 10)
  const compressedSize = archive.readUInt32LE(centralDir + 20)
  const nameLength = archive.readUInt16LE(centralDir + 28)
  const localHeader = archive.readUInt32LE(centralDir + 42)
  const name = archive.toString('utf8', centralDir + 46, centralDir + 46 + nameLength)

  const localNameLength = archive.readUInt16LE(localHeader + 26)
  const localExtraLength = archive.readUInt16LE(localHeader + 28)
  const start = localHeader + 30 + localNameLength + localExtraLength
  const data = archive.subarray(start, start + compressedSize)
  if (method === 0) return { name, text: data.toString('utf8') }
  if (method === 8) return { name, text: inflateRawSync(data).toString('utf8') }
  throw new Error(`Unsupported zip compression method ${method}.`)
}

const inRange = zip => {
  const prefix = Number(zip.slice(0, 3))
  return PREFIX_RANGES.some(([low, high]) => prefix >= low && prefix <= high)
}

console.log(`Fetching ${SOURCE_URL}`)
const response = await fetch(SOURCE_URL)
if (!response.ok) throw new Error(`The Census server answered ${response.status} for ${SOURCE_URL}.`)
const archive = Buffer.from(await response.arrayBuffer())
const { name, text } = firstEntry(archive)

const lines = text.split(/\r?\n/).filter(Boolean)
const header = lines[0].split('\t').map(column => column.trim())
const column = label => {
  const index = header.indexOf(label)
  if (index < 0) throw new Error(`The gazetteer has no ${label} column; its layout has changed. Header: ${header.join(', ')}`)
  return index
}
const [zipAt, latAt, longAt] = [column('GEOID'), column('INTPTLAT'), column('INTPTLONG')]

const zips = {}
let total = 0
for (const line of lines.slice(1)) {
  const cells = line.split('\t')
  const zip = cells[zipAt].trim()
  total += 1
  if (!/^\d{5}$/.test(zip) || !inRange(zip)) continue
  const latitude = Number(cells[latAt])
  const longitude = Number(cells[longAt])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error(`Row for ${zip} has no usable coordinates.`)
  zips[zip] = [latitude, longitude]
}

const output = {
  source: SOURCE_URL,
  file: name,
  vintage: VINTAGE,
  cutOn: new Date().toISOString().slice(0, 10),
  prefixes: PREFIX_RANGES.map(([low, high]) => `${String(low).padStart(3, '0')}-${String(high).padStart(3, '0')}`),
  columns: ['latitude', 'longitude'],
  note: 'US Census Bureau ZCTA Gazetteer, public domain. Interior point of each ZIP Code Tabulation Area. Recut with scripts/cut-zip-centroids.mjs.',
  count: Object.keys(zips).length,
  zips,
}

writeFileSync(OUTPUT, JSON.stringify(output, null, 0) + '\n')
console.log(`Kept ${output.count} of ${total} ZCTAs from ${name} (${VINTAGE}) -> ${path.relative(ROOT, OUTPUT)}`)
