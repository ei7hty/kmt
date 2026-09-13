/**
 * The public contract for a catalogue row, and why it needed changing.
 *
 * `.forge/audit-ui.mjs` declares which fields may cross to a customer's
 * browser. The rule it enforced was "exactly these seven keys", which cannot
 * describe a field that is only sometimes there -- and two of them are:
 * `imageUrl` appears once a photo of that tire is approved, `brand` once the
 * supplier's own listing URL carries a recognisable one.
 *
 * So the deployed-site audit went red on EVERY production deploy from the day
 * photos went live, naming `imageUrl` as the offender on 6,115 rows. A true
 * report of the rule as written, a false alarm about a leak, and a check that
 * cries wolf on every deploy is one people stop reading.
 *
 * The rule that replaced it is STRICTER, not looser: required fields must all
 * be present, optional ones are approved by name, and anything else is a
 * failure. The leak it exists to catch is #61 -- `sku`, `stock`, `listPrice`
 * and the supplier's product URL reaching every customer's browser -- and each
 * of those is asserted below rather than assumed.
 *
 * This test lives in `backend/` rather than beside the file it covers because
 * CI's globs do not reach `.forge/*.test.mjs`; `.forge/orphaned-test-check.mjs`
 * would report it as running nowhere. Same reason `backend/worktree.test.mjs`
 * and `backend/claim.test.mjs` sit here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CATALOG_FIELDS, CATALOG_OPTIONAL_FIELDS, CATALOG_FIELDS_PHRASE, catalogRowProblem,
} from '../.forge/audit-ui.mjs'

/** A row as `catalog()` builds one, with the required fields and nothing else. */
const row = (extra = {}, drop = null) => {
  const base = {
    id: 'giga-abcd1234', name: 'Michelin Defender', size: '225/50R17',
    price: 168.4, inStock: true, category: 'all-season',
    description: 'Touring All Season', ...extra,
  }
  if (drop) delete base[drop]
  return base
}

test('a row of exactly the required fields is the contract', () => {
  assert.equal(catalogRowProblem(row()), null)
  // The fixture above has to actually be that set, or every case below is
  // measuring a row this test invented rather than the contract.
  assert.deepEqual(Object.keys(row()).sort(), [...CATALOG_FIELDS].sort())
})

test('each approved optional field is allowed, alone and together', () => {
  // Emptying CATALOG_OPTIONAL_FIELDS made this whole test pass by looping over
  // nothing -- caught by controlling it, which is the only way that shape ever
  // is. The loop below proves nothing unless there is something to loop over.
  assert.ok(CATALOG_OPTIONAL_FIELDS.length > 0,
    'no optional field is approved, so every assertion below runs zero times and reports a pass')

  for (const field of CATALOG_OPTIONAL_FIELDS) {
    assert.equal(catalogRowProblem(row({ [field]: 'x' })), null, `${field} is approved and was refused`)
  }
  const all = Object.fromEntries(CATALOG_OPTIONAL_FIELDS.map(field => [field, 'x']))
  assert.equal(catalogRowProblem(row(all)), null, 'a row carrying every optional field at once was refused')
})

test('every field the projection can add is on one of the two lists', () => {
  // The invariant that would have caught `imageUrl` the day it shipped, rather
  // than after it had reddened every production deploy since. The contract is
  // tied to the code that builds the rows, not to a memory of it: `catalog()`
  // adds its optional fields as `...(cond ? { field: value } : {})`, and every
  // field name that appears that way has to be approved somewhere.
  const source = readFileSync(new URL('./inventory.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('const tires = []')
  const end = source.indexOf('return tires', start)
  assert.ok(start !== -1 && end > start,
    "catalog()'s row builder is not where this test looks for it; if it moved, move this with it")

  const body = source.slice(start, end)
  const conditional = [...body.matchAll(/\.\.\.\([^?]*\?\s*\{\s*([A-Za-z_$][\w$]*)\s*:/g)].map(match => match[1])
  assert.ok(conditional.length > 0,
    'no conditional field found in the row builder -- this test would pass over an empty list otherwise')

  const approved = new Set([...CATALOG_FIELDS, ...CATALOG_OPTIONAL_FIELDS])
  for (const field of conditional) {
    assert.ok(approved.has(field),
      `catalog() can put "${field}" on a customer's row and no field list approves it. ` +
      'Either it belongs in CATALOG_OPTIONAL_FIELDS after a person has looked at it, or it should not cross.')
  }
  // And the reverse, so the lists cannot grow approvals for fields nothing emits.
  for (const field of CATALOG_OPTIONAL_FIELDS) {
    assert.ok(conditional.includes(field),
      `"${field}" is approved as optional but catalog() never adds it; an approval nobody uses is a hole waiting for a name`)
  }
})

test('the #61 leak is still caught, field by field', () => {
  // sku, stock, listPrice and the supplier product URL reached every
  // customer's browser once. Each is named, not covered by a general case,
  // because a general case cannot tell you which one came back.
  const leaks = {
    sku: 'ROYA0161626570H',
    stock: 12,
    listPrice: 41.2,
    source: { url: 'https://www.giga-tires.com/tires/225-50-17/some-tire' },
    supplierPrice: 41.2,
  }
  for (const [field, value] of Object.entries(leaks)) {
    const why = catalogRowProblem(row({ [field]: value }))
    assert.ok(why, `${field} crossed the customer boundary unreported`)
    assert.match(why, new RegExp(field), `the refusal does not name ${field}: ${why}`)
  }
})

test('a missing required field is a failure, and says which', () => {
  for (const field of CATALOG_FIELDS) {
    const why = catalogRowProblem(row({}, field))
    assert.ok(why, `a row with no ${field} was accepted`)
    assert.match(why, new RegExp(`missing.*${field}`), `the refusal does not name ${field}: ${why}`)
  }
})

test('no field is on both lists, and the phrase counts rather than spells', () => {
  const both = CATALOG_FIELDS.filter(field => CATALOG_OPTIONAL_FIELDS.includes(field))
  assert.deepEqual(both, [], 'a field that is both required and optional makes the rule mean nothing')
  // The word "seven" used to be a third copy of CATALOG_FIELDS.length, written
  // into two check messages. It said seven while the list said eight for as
  // long as it took someone to notice.
  assert.ok(CATALOG_FIELDS_PHRASE.includes(String(CATALOG_FIELDS.length)),
    `the phrase does not carry the count it claims to: ${CATALOG_FIELDS_PHRASE}`)
  assert.doesNotMatch(CATALOG_FIELDS_PHRASE, /seven|eight|nine/i,
    'the phrase spells a number out again, which is the copy that drifted')
  for (const field of CATALOG_OPTIONAL_FIELDS) assert.match(CATALOG_FIELDS_PHRASE, new RegExp(field))
})
