/**
 * The rule this module exists to keep, and the ways a stored draft goes bad.
 *
 * Ken decided the scope himself, verbatim: "just the shopping, no personal
 * details". That is a promise about a customer's data, so the test that
 * matters most here is not that the right fields are kept -- it is that the
 * wrong ones CANNOT be, even when the caller hands over the whole form. The
 * wiring in `CustomerRequest.jsx` passes the live `formData` object, which
 * holds a name, an email, a phone number and a street address, so "the caller
 * will only pass the safe fields" is not a property anyone can rely on. The
 * allow-list is.
 *
 * There is no DOM in this suite, so `window.localStorage` is stood up by hand
 * below -- including the two failure modes real browsers actually have, which
 * are not "empty": Safari private browsing THROWS on access, and a full quota
 * throws on write. Both have to leave a working order flow behind.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** A localStorage good enough to be wrong in the ways the real one is. */
function fakeStorage({ throwOnGet = false, throwOnSet = false } = {}) {
  const items = new Map()
  return {
    items,
    getItem(key) {
      if (throwOnGet) throw new DOMException('denied')
      return items.has(key) ? items.get(key) : null
    },
    setItem(key, value) {
      if (throwOnSet) throw new DOMException('quota')
      items.set(key, String(value))
    },
    removeItem(key) { items.delete(key) },
  }
}

/** Install a storage (or a getter that throws, like a blocked browser). */
function install(storage) {
  globalThis.window = storage === 'throws'
    ? { get localStorage() { throw new DOMException('blocked') } }
    : { localStorage: storage }
}

const { writeDraft, readDraft, clearDraft, pickDraftFields, DRAFT_VERSION, DRAFT_FIELDS } =
  await import('./request-draft.js')

/** A whole customer form, exactly as CustomerRequest.jsx holds it. */
const FULL_FORM = {
  tireSize: '225/50R17',
  tireSelection: 'giga-12345',
  quantity: 4,
  disposeOldTires: true,
  // Everything below is the part that must never reach storage.
  customerName: 'Dana Whitfield',
  customerEmail: 'dana.whitfield@example.com',
  customerPhone: '(617) 555-0100',
  location: '42 Pleasant Street, Malden, MA',
  locationNotes: 'Blue Civic, behind the gate, code 4417',
  serviceZip: '02148',
  vehicleInfo: '2020 Honda Civic',
}

const PERSONAL = ['Dana', 'Whitfield', 'dana.whitfield@example.com', '555-0100',
  'Pleasant Street', 'Blue Civic', '4417', '02148']

test('handed the entire form, it stores the shopping and none of the person', () => {
  const store = fakeStorage()
  install(store)
  assert.equal(writeDraft(FULL_FORM), true)

  const stored = store.items.get('kmt_request_draft')
  assert.ok(stored, 'nothing was written at all, so the assertions below would pass vacuously')

  // Read the raw bytes, not the parsed object: this is the promise Ken was
  // given, and it is about what is on the customer's device.
  for (const secret of PERSONAL) {
    assert.ok(!stored.includes(secret),
      `${JSON.stringify(secret)} reached localStorage -- "just the shopping, no personal details"`)
  }

  // The control: the shopping really is in there, so the loop above is not
  // passing because the file is empty or the fields were all dropped.
  assert.ok(stored.includes('225/50R17') && stored.includes('giga-12345'),
    'the shopping was not stored either, so this test proves nothing about filtering')

  const back = readDraft()
  assert.deepEqual(back, { tireSize: '225/50R17', tireSelection: 'giga-12345', quantity: 4, disposeOldTires: true })
})

test('the allow-list is the whole contract, and it holds nothing personal', () => {
  // A field added to FIELDS without thinking shows up here rather than in
  // production. Anything on this list is written to a customer's device.
  assert.deepEqual(DRAFT_FIELDS, ['tireSize', 'tireSelection', 'quantity', 'disposeOldTires'])

  // And the filter itself drops what is not on it, given an object made
  // entirely of fields that are not.
  assert.deepEqual(pickDraftFields({ customerEmail: 'x@y.z', location: 'somewhere' }), {})
  assert.deepEqual(pickDraftFields(null), {})
  assert.deepEqual(pickDraftFields('not an object'), {})
})

test('a value of the wrong type is dropped, not restored into the flow', () => {
  // Anything on the device could have written this string, so a quantity of
  // `{}` or a 50KB size must not reach the form's state.
  const store = fakeStorage()
  install(store)
  store.items.set('kmt_request_draft', JSON.stringify({
    v: DRAFT_VERSION, at: Date.now(),
    tireSize: '225/50R17', tireSelection: 'giga-1',
    quantity: { evil: true }, disposeOldTires: 'yes',
  }))

  const back = readDraft()
  assert.deepEqual(back, { tireSize: '225/50R17', tireSelection: 'giga-1' },
    'a malformed quantity or flag was restored instead of being dropped')
})

test('a draft from a different shape is discarded, not half-read', () => {
  // This is the guard that matters for what comes next: Ken has asked for a
  // cart, and when the shape changes, state written by today's build means
  // something different by the same field names.
  const store = fakeStorage()
  install(store)
  store.items.set('kmt_request_draft', JSON.stringify({
    v: DRAFT_VERSION + 1, at: Date.now(), tireSize: '225/50R17', tireSelection: 'giga-1',
  }))

  assert.equal(readDraft(), null, 'a draft from another version was read anyway')
  assert.equal(store.items.has('kmt_request_draft'), false, 'and it was left on the device')

  // The control: the same draft at the current version IS read, so the
  // rejection above is about the version and not about everything failing.
  store.items.set('kmt_request_draft', JSON.stringify({
    v: DRAFT_VERSION, at: Date.now(), tireSize: '225/50R17', tireSelection: 'giga-1',
  }))
  assert.deepEqual(readDraft(), { tireSize: '225/50R17', tireSelection: 'giga-1' })
})

test('a draft old enough to be forgotten is forgotten', () => {
  const store = fakeStorage()
  install(store)
  const eightDays = 8 * 24 * 60 * 60 * 1000
  store.items.set('kmt_request_draft', JSON.stringify({
    v: DRAFT_VERSION, at: Date.now() - eightDays, tireSize: '225/50R17', tireSelection: 'giga-1',
  }))
  assert.equal(readDraft(), null)
  assert.equal(store.items.has('kmt_request_draft'), false)

  // The control: six days old still comes back, so the cutoff is a cutoff and
  // not "nothing is ever restored".
  store.items.set('kmt_request_draft', JSON.stringify({
    v: DRAFT_VERSION, at: Date.now() - 6 * 24 * 60 * 60 * 1000, tireSize: '225/50R17', tireSelection: 'giga-1',
  }))
  assert.ok(readDraft(), 'a six-day-old draft was thrown away too')
})

test('garbage on the device is thrown away rather than crashing the flow', () => {
  const store = fakeStorage()
  install(store)
  store.items.set('kmt_request_draft', 'not json at all {{{')
  assert.equal(readDraft(), null)
  assert.equal(store.items.has('kmt_request_draft'), false, 'unparseable state was left to fail again on the next visit')

  store.items.set('kmt_request_draft', JSON.stringify({ v: DRAFT_VERSION, at: Date.now() }))
  assert.equal(readDraft(), null, 'a draft naming no tire and no size is not a draft')
})

test('a browser that refuses storage still gets a working order flow', () => {
  // Safari private browsing throws on ACCESS, not on read. This is the case
  // that takes a page down with it if it is not caught.
  install('throws')
  assert.doesNotThrow(() => readDraft())
  assert.doesNotThrow(() => clearDraft())
  assert.equal(readDraft(), null)
  assert.equal(writeDraft(FULL_FORM), false)

  // A full quota throws on write instead.
  install(fakeStorage({ throwOnSet: true }))
  assert.equal(writeDraft(FULL_FORM), false, 'a failed write reported success')
  assert.doesNotThrow(() => writeDraft(FULL_FORM))

  // And a store that refuses reads.
  install(fakeStorage({ throwOnGet: true }))
  assert.equal(readDraft(), null)
})

test('nothing chosen leaves nothing behind, and submitting forgets', () => {
  const store = fakeStorage()
  install(store)

  // Someone who opens the page and picks nothing should not leave a key.
  assert.equal(writeDraft({ quantity: 4 }), false)
  assert.equal(store.items.size, 0, 'a visitor who chose nothing still left a stored draft behind')

  writeDraft(FULL_FORM)
  assert.equal(store.items.size, 1)
  clearDraft()
  assert.equal(store.items.size, 0, 'the draft outlived the order it belonged to')
})
