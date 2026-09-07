import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Inventory, InputError } from './inventory.mjs'
import {
  SITE_COPY_FIELDS, SITE_COPY_KEY, SiteCopy,
  cleanSiteCopy, resolveSiteCopy, siteCopyConflicts, siteCopyDefaults,
} from './site-copy.mjs'

const SIZE = '215/60R16'

function setup(t) {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  return { inventory, copy: new SiteCopy(inventory) }
}

// --- The registry itself -----------------------------------------------------

test('every field has a non-empty default that fits its own limit', () => {
  for (const field of SITE_COPY_FIELDS) {
    assert.equal(typeof field.default, 'string', `${field.key} default is text`)
    assert.ok(field.default.trim(), `${field.key} default is not blank`)
    // A shipped default longer than its own cap would make the field
    // unsaveable the first time anyone edited it -- and nothing else would
    // notice until Ken hit it.
    assert.ok(field.default.length <= field.max, `${field.key} default fits max ${field.max}`)
  }
})

test('keys are unique', () => {
  const keys = SITE_COPY_FIELDS.map(field => field.key)
  assert.equal(new Set(keys).size, keys.length)
})

// --- Resolution: absent is the case that matters -----------------------------

test('nothing stored resolves to the shipped defaults', () => {
  assert.deepEqual(resolveSiteCopy(null), siteCopyDefaults())
  assert.deepEqual(resolveSiteCopy(undefined), siteCopyDefaults())
  assert.deepEqual(resolveSiteCopy({}), siteCopyDefaults())
  assert.deepEqual(resolveSiteCopy({ values: null }), siteCopyDefaults())
})

test('an override replaces one field and leaves the rest shipped', () => {
  const resolved = resolveSiteCopy({ values: { 'hero.eyebrow': 'I DRIVE TO YOU' } })
  assert.equal(resolved['hero.eyebrow'], 'I DRIVE TO YOU')
  assert.equal(resolved['hero.headingTop'], siteCopyDefaults()['hero.headingTop'])
  assert.equal(Object.keys(resolved).length, SITE_COPY_FIELDS.length)
})

test('a stored key the registry no longer has is ignored, not thrown on', () => {
  // The customer's landing page is not the place to discover a migration.
  const resolved = resolveSiteCopy({ values: { 'hero.gone': 'x', 'hero.eyebrow': 'KEPT' } })
  assert.equal(resolved['hero.eyebrow'], 'KEPT')
  assert.ok(!('hero.gone' in resolved))
})

// --- cleanSiteCopy: each guard tested with the value ABSENT, not wrong --------
//
// A test with a *wrong* value passes under the broken form of most of these
// guards; only the absent case exposes a `??`-shaped hole. Written that way
// deliberately -- see NOTES.md, 2026-09-06, on the empty invoice.

test('an unknown key is refused rather than dropped', () => {
  assert.throws(() => cleanSiteCopy({ 'hero.nope': 'text' }), InputError)
  // The point of refusing: the owner screen must never be told it saved a
  // field this module has never heard of.
  assert.throws(() => cleanSiteCopy({ 'hero.nope': 'text' }), /no copy field called/)
})

test('a missing value is refused, not treated as empty', () => {
  assert.throws(() => cleanSiteCopy({ 'hero.eyebrow': undefined }), /must be text/)
  assert.throws(() => cleanSiteCopy({ 'hero.eyebrow': null }), /must be text/)
})

test('a blank or whitespace value is refused, and the message says how to reset', () => {
  assert.throws(() => cleanSiteCopy({ 'hero.eyebrow': '' }), /cannot be empty/)
  assert.throws(() => cleanSiteCopy({ 'hero.eyebrow': '   ' }), /cannot be empty/)
  assert.throws(() => cleanSiteCopy({ 'strip.3.body': '\t\n ' }), /Use Reset/)
})

test('over-length is rejected rather than truncated', () => {
  const field = SITE_COPY_FIELDS.find(candidate => candidate.key === 'hero.eyebrow')
  assert.throws(() => cleanSiteCopy({ 'hero.eyebrow': 'x'.repeat(field.max + 1) }), /too long/)
  // Exactly at the limit is fine: an off-by-one here silently shortens what
  // Ken may write.
  assert.equal(cleanSiteCopy({ 'hero.eyebrow': 'x'.repeat(field.max) })['hero.eyebrow'], 'x'.repeat(field.max))
})

test('a non-object body is refused', () => {
  for (const bad of [null, undefined, 'text', 42, ['hero.eyebrow']]) {
    assert.throws(() => cleanSiteCopy(bad), InputError)
  }
})

test('values are trimmed', () => {
  assert.equal(cleanSiteCopy({ 'hero.eyebrow': '  PADDED  ' })['hero.eyebrow'], 'PADDED')
})

// --- The claim check ---------------------------------------------------------

test('a hard claim is reported with the constraint that makes it false', () => {
  const { conflicts } = siteCopyConflicts({ 'strip.1.body': 'Same-day fitting, wherever you are' })
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].term, 'same day')
  assert.match(conflicts[0].constraint, /seven-day minimum/)
  assert.match(conflicts[0].constraint, /MIN_LEAD_DAYS/)
})

test('the shipped defaults raise nothing', () => {
  // If our own copy tripped the check, the first thing Ken would learn is that
  // the warning is noise -- which is how a check stops being read.
  const { conflicts, composite } = siteCopyConflicts(siteCopyDefaults())
  assert.deepEqual(conflicts, [])
  assert.equal(composite, null)
})

test('word boundaries hold: "breakfast" is not "fast"', () => {
  const { conflicts, composite } = siteCopyConflicts({ 'order.lede': 'Booked before breakfast, fitted next week' })
  assert.deepEqual(conflicts, [])
  assert.equal(composite, null)
})

test('one energetic word alone is a voice, not a claim', () => {
  const { conflicts, composite } = siteCopyConflicts({ 'hero.lede1': 'A quick quote, no haggling' })
  assert.deepEqual(conflicts, [])
  assert.equal(composite, null, 'one soft term must not fire')
})

test('two soft terms across different fields compose into a claim', () => {
  // The failure that actually happened: no line wrong, the stack wrong. A
  // per-field check cannot see this, which is why the check spans the
  // submission.
  const { conflicts, composite } = siteCopyConflicts({
    'hero.lede1': 'Fast, honest work',
    'strip.2.body': 'A quick answer every time',
  })
  assert.deepEqual(conflicts, [], 'neither line is a hard claim on its own')
  assert.ok(composite, 'the composite fires')
  assert.deepEqual(composite.terms.sort(), ['fast', 'quick'])
  assert.equal(composite.keys.length, 2)
})

// --- Saving: the acknowledgement is enforced on the server --------------------

test('a save carrying a hard claim is refused without acknowledgement', t => {
  const { copy } = setup(t)
  try {
    copy.save({ 'strip.1.body': 'Emergency call-outs, 24/7' })
    assert.fail('should have refused')
  } catch (error) {
    assert.ok(error instanceof InputError)
    assert.equal(error.conflicts.length, 2, 'both terms are named, not just the first')
    assert.deepEqual(error.conflicts.map(conflict => conflict.term).sort(), ['24/7', 'emergency'])
  }
})

test('acknowledging the exact terms lets it through -- warn, never block', t => {
  const { copy } = setup(t)
  const saved = copy.save({ 'strip.1.body': 'Emergency call-outs, 24/7' }, { acknowledged: ['emergency', '24/7'] })
  assert.equal(saved.values['strip.1.body'], 'Emergency call-outs, 24/7')
})

test('acknowledging one term does not wave through the other', t => {
  const { copy } = setup(t)
  assert.throws(
    () => copy.save({ 'strip.1.body': 'Emergency call-outs, 24/7' }, { acknowledged: ['emergency'] }),
    /booking form will refuse/,
  )
})

test('an absent acknowledgement list is a refusal, not a pass', t => {
  const { copy } = setup(t)
  // The `??`-shaped hole: `acknowledged` missing entirely must behave as
  // "nothing acknowledged", never as "everything acknowledged".
  assert.throws(() => copy.save({ 'hero.lede1': 'Same day, every day' }, {}), InputError)
  assert.throws(() => copy.save({ 'hero.lede1': 'Same day, every day' }), InputError)
  assert.throws(() => copy.save({ 'hero.lede1': 'Same day, every day' }, { acknowledged: null }), InputError)
})

test('the composite needs its own acknowledgement', t => {
  const { copy } = setup(t)
  const values = { 'hero.lede1': 'Fast, honest work', 'strip.2.body': 'A quick answer every time' }
  assert.throws(() => copy.save(values), InputError)
  // Acknowledging the individual words is not acknowledging the composite --
  // they are not what was shown.
  assert.throws(() => copy.save(values, { acknowledged: ['fast', 'quick'] }), InputError)
  const saved = copy.save(values, { acknowledged: ['composite'] })
  assert.equal(saved.values['hero.lede1'], 'Fast, honest work')
})

// --- Storage, and the one undo step -----------------------------------------

test('an empty store renders exactly the shipped site', t => {
  const { copy, inventory } = setup(t)
  assert.equal(inventory.getMeta(SITE_COPY_KEY), null, 'nothing is written until a save')
  assert.deepEqual(copy.resolved(), siteCopyDefaults())
})

test('a save is visible to the resolved read, and only for the field saved', t => {
  const { copy } = setup(t)
  copy.save({ 'order.heading': 'Order your tires' })
  const resolved = copy.resolved()
  assert.equal(resolved['order.heading'], 'Order your tires')
  assert.equal(resolved['hero.eyebrow'], siteCopyDefaults()['hero.eyebrow'])
})

test('undo restores the previous save, and is itself undoable', t => {
  const { copy } = setup(t)
  copy.save({ 'order.heading': 'First' })
  copy.save({ 'order.heading': 'Second' })
  assert.equal(copy.resolved()['order.heading'], 'Second')

  copy.undo()
  assert.equal(copy.resolved()['order.heading'], 'First')
  copy.undo()
  assert.equal(copy.resolved()['order.heading'], 'Second', 'undo is a swap, so it is its own redo')
})

test('undo with nothing behind it is refused, not a silent no-op', t => {
  const { copy } = setup(t)
  assert.throws(() => copy.undo(), /nothing to undo/)
})

test('dropping an override returns that field to the shipped wording', t => {
  const { copy } = setup(t)
  copy.save({ 'order.heading': 'Order your tires', 'hero.eyebrow': 'I DRIVE TO YOU' })
  // Per-field revert: save the set without that key.
  copy.save({ 'hero.eyebrow': 'I DRIVE TO YOU' })
  assert.equal(copy.resolved()['order.heading'], siteCopyDefaults()['order.heading'])
  assert.equal(copy.resolved()['hero.eyebrow'], 'I DRIVE TO YOU')
})

test('saving needs no schema change: it is one metadata row', t => {
  const { copy, inventory } = setup(t)
  copy.save({ 'hero.eyebrow': 'I DRIVE TO YOU' })
  const row = inventory.db.prepare('SELECT value FROM metadata WHERE key=?').get(SITE_COPY_KEY)
  assert.ok(row, 'stored in the existing key/JSON table')
  assert.equal(JSON.parse(row.value).values['hero.eyebrow'], 'I DRIVE TO YOU')
})

// --- Every declared key is actually rendered somewhere -----------------------

test('every registry key is referenced by a customer-facing component', () => {
  // The defect this exists for, found in review rather than by any test: the
  // registry, the store, the routes, the injection and the owner screen were
  // all correct and complete, every test passed, and no component read any of
  // it. The screen told Ken his words were live while the page rendered
  // hardcoded literals -- a tool lying to the one person using it.
  //
  // Nothing caught it because every part was tested against its own contract
  // and no test spanned the seam. This is the cheapest assertion that does:
  // a key nobody renders is a key that does nothing.
  //
  // It proves the wiring exists, not that it works at runtime -- that is a
  // browser's job, and the flow audits own it. Two layers on purpose: this one
  // fails the moment a key is added without being rendered, which is when the
  // mistake is cheap to fix.
  const sources = ['../src/routes/CustomerRequest.jsx', '../src/routes/Inquiry.jsx', '../src/routes/NotFound.jsx']
    .map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
    .join('\n')

  const unrendered = SITE_COPY_FIELDS.filter(field => !sources.includes(`'${field.key}'`))
  assert.deepEqual(unrendered.map(field => field.key), [],
    'these keys are editable but nothing renders them, so saving one changes nothing a customer sees')
})

test('the positive control: this test can see a key that is rendered', () => {
  // Guards the assertion above against the way it would fail silently -- a
  // path typo makes `sources` empty, every key looks unrendered, and the test
  // goes red for the wrong reason. This one goes red if the files are read but
  // hold nothing, which is the other direction.
  // Deliberately not keyed to any single field: an earlier version canaried on
  // `hero.eyebrow`, so unwiring that one key turned BOTH tests red and the
  // control could no longer isolate what had broken. A control that fails for
  // the same reason as the thing it is controlling is not a control.
  const sources = readFileSync(new URL('../src/routes/CustomerRequest.jsx', import.meta.url), 'utf8')
  assert.ok(sources.length > 1000, 'the source was actually read, not silently empty from a bad path')
  assert.ok(sources.includes('COPY['), 'and it genuinely reads the registry at all')
})
