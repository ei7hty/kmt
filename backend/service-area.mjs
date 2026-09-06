/**
 * Is a customer's ZIP one the business will drive to?
 *
 * The service ZIP has been collected since the wizard took it and nothing has
 * read it (#95): a customer two hundred miles away completes the flow, is
 * quoted a flat mobile fee, may pay, and the owner finds out when he reads
 * the address. This module answers the question the form should have asked,
 * from a ZIP centroid table cut from the Census gazetteer
 * (scripts/cut-zip-centroids.mjs) and three environment settings:
 *
 *   KMT_SERVICE_BASE_ZIP      where the van starts, default 02148 (Malden)
 *   KMT_SERVICE_RADIUS_MILES  beyond this a request is refused; unset accepts all
 *   KMT_SERVICE_REVIEW_MILES  beyond this a request is flagged for the owner, default 25
 *
 * Distance is the great-circle distance between ZIP interior points, which
 * is not the drive. It is a straight line under the road distance by a third
 * or so around here, so the radius is a floor on how far the owner may be
 * asked to go, not a ceiling. That is the right side to err on for a refusal
 * that offers a phone number, and the review band exists for the rest.
 *
 * Wiring into submit is part two of t48; this file is the rule and its data.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Beside this file, not under data/: .dockerignore drops that directory from
// the image, and a table that is in git but not in production is worse than
// none, because every test would pass and the first submit would fail.
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'zip-centroids.json')

const DEFAULT_BASE_ZIP = '02148'
/**
 * The radius the business is expected to run with, for the deployment
 * configuration to set. The code's own default is no radius at all, so the
 * check can ship before the number is decided and refuse nobody until it is.
 */
export const SUGGESTED_RADIUS_MILES = 100
const DEFAULT_REVIEW_MILES = 25

/** The reasons a ZIP is refused or flagged, as the names the API and the owner card read. */
export const REASONS = Object.freeze({
  MALFORMED: 'malformed_zip',
  UNKNOWN: 'unknown_zip',
  BEYOND_RADIUS: 'beyond_radius',
  REVIEW: 'review_distance',
})

let table = null

/** The centroid table, read once. */
function centroids() {
  if (!table) table = JSON.parse(readFileSync(DATA, 'utf8'))
  return table
}

/** Where the table came from, for the boot line and the owner note. */
export function centroidProvenance() {
  const { source, vintage, cutOn, count, prefixes } = centroids()
  return { source, vintage, cutOn, count, prefixes }
}

const ZIP = /^\d{5}$/

/** A five-digit ZIP from what a form or an environment variable carries, or null. */
export function normalizeZip(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const digits = String(value).trim().replace(/-\d{4}$/, '')
  return ZIP.test(digits) ? digits : null
}

const EARTH_RADIUS_MILES = 3958.7613
const toRadians = degrees => degrees * Math.PI / 180

/** Great-circle miles between two ZIP interior points, or null if either is not in the table. */
export function distanceMiles(zipA, zipB) {
  const a = centroids().zips[normalizeZip(zipA)]
  const b = centroids().zips[normalizeZip(zipB)]
  if (!a || !b) return null
  const [latA, longA] = a.map(toRadians)
  const [latB, longB] = b.map(toRadians)
  const sinLat = Math.sin((latB - latA) / 2)
  const sinLong = Math.sin((longB - longA) / 2)
  const h = sinLat * sinLat + Math.cos(latA) * Math.cos(latB) * sinLong * sinLong
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * The service area from the environment.
 *
 * A base ZIP the table does not know is refused at boot rather than at the
 * first submit: every distance would be null and every request would read
 * as unknown. A radius that is not a positive number is refused the same
 * way; unset means no radius, which is today's behaviour, so the switch can
 * be deployed before the number is decided.
 */
export function readServiceAreaConfig(env = process.env) {
  const baseZip = normalizeZip(env.KMT_SERVICE_BASE_ZIP ?? DEFAULT_BASE_ZIP)
  if (!baseZip || !centroids().zips[baseZip]) {
    throw new Error(`KMT_SERVICE_BASE_ZIP must be a five-digit ZIP in the centroid table; got ${JSON.stringify(env.KMT_SERVICE_BASE_ZIP)}.`)
  }
  const number = (name, fallback) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of miles; got ${JSON.stringify(raw)}.`)
    return value
  }
  return {
    baseZip,
    radiusMiles: number('KMT_SERVICE_RADIUS_MILES', null),
    reviewMiles: number('KMT_SERVICE_REVIEW_MILES', DEFAULT_REVIEW_MILES),
  }
}

/** The one line the server prints at boot about this. */
export function describeServiceArea(config) {
  const { vintage, count } = centroidProvenance()
  const radius = config.radiusMiles === null ? 'no radius (every ZIP accepted)' : `${config.radiusMiles} mile radius`
  return `Service area: base ${config.baseZip}, ${radius}, review beyond ${config.reviewMiles} miles; ${count} ZIP centroids (Census ${vintage}).`
}

/**
 * May this ZIP be served, and does the owner need to look?
 *
 * Returns { serviceable, reason, miles, message }. `reason` is null when
 * there is nothing to say, REVIEW when the request goes through but the
 * owner should see how far it is, and one of the refusals otherwise. `miles`
 * is the computed distance whenever both ends are known, so the owner card
 * can show it and a refusal can name it.
 */
export function isServiceable(zip, config) {
  const normalized = normalizeZip(zip)
  if (!normalized) {
    return { serviceable: false, reason: REASONS.MALFORMED, miles: null, message: 'Enter a five-digit ZIP code.' }
  }
  const miles = distanceMiles(config.baseZip, normalized)
  if (miles === null) {
    return { serviceable: false, reason: REASONS.UNKNOWN, miles: null, message: 'We do not recognise that ZIP code.' }
  }
  const rounded = Math.round(miles)
  if (config.radiusMiles !== null && miles > config.radiusMiles) {
    return {
      serviceable: false, reason: REASONS.BEYOND_RADIUS, miles: rounded,
      message: `That address is about ${rounded} miles from us, outside the ${config.radiusMiles} mile area we serve.`,
    }
  }
  if (miles > config.reviewMiles) {
    return {
      serviceable: true, reason: REASONS.REVIEW, miles: rounded,
      message: `About ${rounded} miles from base, beyond the ${config.reviewMiles} mile review distance.`,
    }
  }
  return { serviceable: true, reason: null, miles: rounded, message: null }
}
