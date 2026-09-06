import test from 'node:test'
import assert from 'node:assert/strict'
import { REASONS, centroidProvenance, describeServiceArea, distanceMiles, isServiceable, normalizeZip, readServiceAreaConfig } from './service-area.mjs'

/** The area the business runs with by default: Malden, 100 miles, review past 25. */
const AREA = readServiceAreaConfig({})

/** Places a customer might type, by their downtown ZIP. */
const ZIPS = {
  malden: '02148', medford: '02155', boston: '02108', worcester: '01608', providence: '02903',
  manchesterNH: '03101', portlandME: '04101', hartfordCT: '06103',
  bangor: '04401', albany: '12207', newYorkCity: '10001',
}

test('the centroid table says where it came from', () => {
  const provenance = centroidProvenance()
  assert.match(provenance.source, /^https:\/\/www2\.census\.gov\/geo\/docs\/maps-data\/data\/gazetteer\//)
  assert.match(provenance.vintage, /^\d{4}$/)
  assert.match(provenance.cutOn, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(provenance.prefixes, ['010-069', '100-139'])
  assert.ok(provenance.count > 2000, `a New England cut is thousands of ZIPs, not ${provenance.count}`)
})

test('distance is zero at home and roughly right to the places the van would go', () => {
  assert.equal(distanceMiles(ZIPS.malden, ZIPS.malden), 0)
  const near = (zip, miles, within = 3) => {
    const actual = distanceMiles(ZIPS.malden, zip)
    assert.ok(Math.abs(actual - miles) <= within, `${zip}: ${actual.toFixed(1)} miles, expected about ${miles}`)
  }
  near(ZIPS.boston, 5)
  near(ZIPS.worcester, 40)
  near(ZIPS.providence, 46)
  near(ZIPS.manchesterNH, 44)
  near(ZIPS.portlandME, 94)
  near(ZIPS.hartfordCT, 95)
  near(ZIPS.bangor, 200)
  near(ZIPS.albany, 138)
  near(ZIPS.newYorkCity, 190, 5)
  assert.equal(distanceMiles(ZIPS.malden, '99999'), null, 'a ZIP the table lacks is null, not zero')
})

test('inside the radius is served; the review band names the miles; beyond is refused with the miles', () => {
  const home = isServiceable(ZIPS.malden, AREA)
  assert.deepEqual(home, { serviceable: true, reason: null, miles: 0, message: null })

  const close = isServiceable(ZIPS.medford, AREA)
  assert.equal(close.serviceable, true)
  assert.equal(close.reason, null, 'three miles needs no reason')
  assert.equal(close.miles, 3)

  for (const zip of [ZIPS.boston, ZIPS.worcester, ZIPS.providence, ZIPS.manchesterNH, ZIPS.portlandME, ZIPS.hartfordCT]) {
    assert.equal(isServiceable(zip, AREA).serviceable, true, `${zip} is inside 100 miles`)
  }

  const worcester = isServiceable(ZIPS.worcester, AREA)
  assert.equal(worcester.serviceable, true)
  assert.equal(worcester.reason, REASONS.REVIEW)
  assert.equal(worcester.miles, 40)
  assert.match(worcester.message, /About 40 miles/, 'the owner is told how far, not just that it is far')

  // The city is in the cut on purpose: a visitor from there is told they are
  // about 190 miles away, which is true, rather than that their ZIP is not
  // recognised, which reads as a broken form.
  for (const zip of [ZIPS.bangor, ZIPS.albany, ZIPS.newYorkCity]) {
    const far = isServiceable(zip, AREA)
    assert.equal(far.serviceable, false, `${zip} is beyond 100 miles`)
    assert.equal(far.reason, REASONS.BEYOND_RADIUS)
    assert.ok(far.miles > 100)
    assert.match(far.message, new RegExp(`about ${far.miles} miles`))
    assert.match(far.message, /100 mile area/)
  }
})

test('an unknown or malformed ZIP is refused before any distance is computed', () => {
  assert.deepEqual(isServiceable('99999', AREA), { serviceable: false, reason: REASONS.UNKNOWN, miles: null, message: 'We do not recognise that ZIP code.' })
  for (const bad of ['2148', '021480', 'abcde', '', null, undefined, '02148-', '0214x']) {
    const result = isServiceable(bad, AREA)
    assert.equal(result.serviceable, false, `${JSON.stringify(bad)} is refused`)
    assert.equal(result.reason, REASONS.MALFORMED)
  }
  assert.equal(normalizeZip(' 02148-1234 '), '02148', 'a ZIP+4 is its five-digit ZIP')
  assert.equal(normalizeZip(2148), null, 'a number that lost its leading zero is not a ZIP')
})

test('the check is on by default: unset applies 100 miles and a 25 mile review band', () => {
  // A fix that ships inactive is #95 wearing the fix's clothes: the ZIP was
  // collected and nothing read it. Accepting every ZIP is an explicit opt-out.
  assert.deepEqual(AREA, { baseZip: '02148', radiusMiles: 100, reviewMiles: 25 })
  assert.deepEqual(readServiceAreaConfig({ KMT_SERVICE_RADIUS_MILES: '', KMT_SERVICE_REVIEW_MILES: '' }), AREA, 'empty is unset')
  assert.equal(isServiceable(ZIPS.bangor, AREA).serviceable, false, 'with nothing set, Bangor is refused')
  assert.equal(describeServiceArea(AREA), 'service-area check ON: base 02148, radius 100 mi, review beyond 25 mi')
})

test('"off" accepts every known ZIP, says so at boot, and the review band still flags unless it is off too', () => {
  for (const value of ['off', 'OFF', '0']) {
    const open = readServiceAreaConfig({ KMT_SERVICE_RADIUS_MILES: value })
    assert.equal(open.radiusMiles, null, `${value} switches the radius off`)
    assert.equal(open.reviewMiles, 25)
    const bangor = isServiceable(ZIPS.bangor, open)
    assert.equal(bangor.serviceable, true)
    assert.equal(bangor.reason, REASONS.REVIEW, 'accepted, but the owner is shown 200 miles')
    assert.equal(bangor.miles, 200)
    assert.equal(isServiceable('99999', open).serviceable, false, 'unknown is still unknown')
    assert.equal(describeServiceArea(open), 'service-area check OFF: accepting every ZIP')
  }

  const noReview = readServiceAreaConfig({ KMT_SERVICE_REVIEW_MILES: 'off' })
  assert.equal(noReview.reviewMiles, null)
  assert.equal(isServiceable(ZIPS.worcester, noReview).reason, null, 'forty miles raises nothing when the band is off')
  assert.equal(isServiceable(ZIPS.bangor, noReview).reason, REASONS.BEYOND_RADIUS, 'the radius still refuses')
  assert.equal(describeServiceArea(noReview), 'service-area check ON: base 02148, radius 100 mi, no review band')
})

test('the configuration refuses a base the table does not know and a radius that is not a distance', () => {
  assert.throws(() => readServiceAreaConfig({ KMT_SERVICE_BASE_ZIP: '99999' }), /KMT_SERVICE_BASE_ZIP/)
  assert.throws(() => readServiceAreaConfig({ KMT_SERVICE_BASE_ZIP: 'home' }), /KMT_SERVICE_BASE_ZIP/)
  assert.throws(() => readServiceAreaConfig({ KMT_SERVICE_RADIUS_MILES: 'far' }), /KMT_SERVICE_RADIUS_MILES/)
  assert.throws(() => readServiceAreaConfig({ KMT_SERVICE_RADIUS_MILES: '-100' }), /KMT_SERVICE_RADIUS_MILES/)
  assert.throws(() => readServiceAreaConfig({ KMT_SERVICE_REVIEW_MILES: '-5' }), /KMT_SERVICE_REVIEW_MILES/)
  const boston = readServiceAreaConfig({ KMT_SERVICE_BASE_ZIP: '02108', KMT_SERVICE_RADIUS_MILES: '50', KMT_SERVICE_REVIEW_MILES: '10' })
  assert.deepEqual(boston, { baseZip: '02108', radiusMiles: 50, reviewMiles: 10 })
})
