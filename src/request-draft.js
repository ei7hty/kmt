/**
 * What the order flow remembers when a customer comes back, and what it must
 * never remember.
 *
 * THE PROBLEM. Nothing survived a reload. Measured on production 2026-09-13:
 * chose 225/50R17, reloaded, and the flow was back at the width step with
 * "Select width, ratio, and diameter" -- only a device key in localStorage,
 * no size, no tire, no step. On a phone that is not an edge case. Tabs get
 * evicted under memory pressure, people follow a link and come back, someone
 * takes a call mid-form. All of them started again from zero, at the point in
 * the flow where they had already spent the most effort.
 *
 * KEN'S RULE, verbatim, deciding it: "just the shopping, no personal details".
 *
 * So this stores what is being BOUGHT and nothing about the person buying.
 * `FIELDS` below is the whole of it, and it is an allow-list rather than a
 * deny-list on purpose: a deny-list has to be updated every time the form
 * grows a field, and the update that gets forgotten is the one that leaks. A
 * field that is not named here cannot be written by this module even if the
 * caller hands over the entire form object -- `src/request-draft.test.mjs`
 * hands it one and asserts the stored bytes contain no name, email, phone or
 * address.
 *
 * NOT STORED, deliberately, though it is arguably "shopping": the service
 * ZIP. It is not personally identifying on its own -- a ZIP holds thousands
 * of people -- but this is a mobile service, so the ZIP is where a van drives
 * to rather than a shipping estimate, which puts it closer to an address than
 * to a tire. Ken said no personal details and this is the reading that
 * respects that. The cost is one field retyped; adding it back is one entry
 * in `FIELDS`.
 */

/** Bumped whenever the shape below changes. See `readDraft`. */
export const DRAFT_VERSION = 1

const KEY = 'kmt_request_draft'

/**
 * How long a remembered order stays useful.
 *
 * A tire chosen three weeks ago is not a resumed order, it is a stale price
 * on a row that may not be in the catalogue any more. The flow already
 * handles a vanished tire (it clears the selection and says so), so this is
 * not a correctness guard -- it is about not greeting someone with a
 * half-remembered order they have forgotten making.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Every field this is allowed to remember, and the check each value must pass.
 *
 * The guards are not validation for its own sake. This reads a string that
 * anything on the device could have written, so a value reaching the flow's
 * state unchecked is a value the flow never expected -- a `quantity` of
 * `{}` or a `tireSize` of 50KB. Each one is narrow enough that a wrong type
 * is dropped rather than restored.
 */
const FIELDS = {
  tireSize: value => typeof value === 'string' && value.length <= 20,
  tireSelection: value => typeof value === 'string' && value.length <= 200,
  quantity: value => Number.isInteger(value) && value > 0 && value <= 8,
  disposeOldTires: value => typeof value === 'boolean',
}

/*
 * NO `orderStep`, and the reason is worth keeping because it looks like an
 * omission. A restored customer is always put back at the ZIP question with
 * their size already chosen, never further in -- the service ZIP is asked for
 * in step 1 and is not editable anywhere later, so restoring someone to step
 * 2 or 3 without one walks them all the way to submit and then refuses it
 * with "Enter the five-digit ZIP code", for a field that is not on the screen
 * they are looking at. Since the step is always 1, storing which step they
 * left from would be data kept on a customer's device that nothing reads.
 */

/** The allowed field names, for tests and for anyone reading the wiring. */
export const DRAFT_FIELDS = Object.freeze(Object.keys(FIELDS))

/**
 * Storage can throw rather than merely be empty -- Safari private browsing
 * and a browser set to block site data both raise on access, and a thumbnail
 * or preview context can too. A customer whose browser refuses storage must
 * still get a working order flow, so every path here degrades to "remember
 * nothing" instead of taking the page down with it.
 */
function storage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Keep only the allowed fields, and only values that pass their own guard.
 *
 * Takes whatever it is given -- the caller passes the live form object, which
 * holds the customer's name, email, phone and address -- and returns an object
 * that provably cannot contain them.
 */
export function pickDraftFields(source) {
  const draft = {}
  if (source === null || typeof source !== 'object') return draft
  for (const [name, isValid] of Object.entries(FIELDS)) {
    const value = source[name]
    if (value !== undefined && isValid(value)) draft[name] = value
  }
  return draft
}

/** Remember the shopping. Never throws; a failure just means nothing is kept. */
export function writeDraft(source) {
  const store = storage()
  if (!store) return false
  const fields = pickDraftFields(source)
  // Nothing chosen yet is not worth a row, and writing one would mean every
  // visitor who opens the page leaves a key behind having bought nothing.
  if (!fields.tireSize && !fields.tireSelection) {
    clearDraft()
    return false
  }
  try {
    store.setItem(KEY, JSON.stringify({ v: DRAFT_VERSION, at: Date.now(), ...fields }))
    return true
  } catch {
    // Quota, or a store that accepts reads and refuses writes.
    return false
  }
}

/**
 * The remembered shopping, or `null`.
 *
 * Returns `null` rather than a partial object for anything it does not fully
 * trust: a different version, an unreadable string, a missing timestamp, or a
 * draft old enough to have stopped being one. The version check is the one
 * that matters most going forward -- a cart is next, and when the shape
 * changes, state written by today's build must be DISCARDED rather than
 * half-read into a flow that now means something different by the same field
 * names. Bump `DRAFT_VERSION` in the same commit as any change to `FIELDS`.
 */
export function readDraft(now = Date.now()) {
  const store = storage()
  if (!store) return null
  let raw
  try {
    raw = store.getItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearDraft()
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  if (parsed.v !== DRAFT_VERSION) {
    clearDraft()
    return null
  }
  if (!Number.isFinite(parsed.at) || now - parsed.at > MAX_AGE_MS) {
    clearDraft()
    return null
  }

  // Re-filtered on the way out, not just on the way in: what is on the device
  // was not necessarily written by this build.
  const fields = pickDraftFields(parsed)
  return fields.tireSize || fields.tireSelection ? fields : null
}

/** Forget it. Called on a successful submit, and whenever a draft is rejected. */
export function clearDraft() {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(KEY)
  } catch {
    // Nothing to do: the caller's next read re-checks anyway.
  }
}
