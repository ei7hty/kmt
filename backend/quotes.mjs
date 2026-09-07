import { randomBytes } from 'node:crypto'

import { InputError } from './inventory.mjs'
import { REASONS, isServiceable, normalizeZip, readServiceAreaConfig } from './service-area.mjs'
import { catalogFromLiveRows } from '../src/data/catalog.js'
import { ALLOWED_QUANTITIES, calculateDraftQuote, computeQuoteTotals, normalizePricingSettings } from '../src/pricing.js'

/** The number a refusal offers. The same one the wizard's call button dials. */
const SHOP_PHONE = '(617) 410-8319'

/**
 * Today, where the van is.
 *
 * A date the customer picks is a day in Massachusetts, not a UTC instant, so
 * "today or later" is judged against the calendar there: a request typed at
 * 11pm should not be refused because it is already tomorrow in Greenwich.
 */
export function todayInServiceArea(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** Ken needs a week's notice: the earliest bookable day is seven days out. */
const MIN_LEAD_DAYS = 7

/**
 * `dateStr` (YYYY-MM-DD) advanced by whole calendar days.
 *
 * This adds days to the calendar, not milliseconds to an instant: the day
 * arithmetic happens in `Date.UTC`, which has no daylight-saving transitions
 * of its own, so the result is the right calendar day regardless of what the
 * server's clock or the customer's timezone is doing. `today` is already the
 * Massachusetts calendar day (`todayInServiceArea`); this only walks it
 * forward.
 */
function addCalendarDays(dateStr, days) {
  const [, year, month, day] = DATE_PATTERN.exec(dateStr).map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/**
 * The preferred date, as YYYY-MM-DD, a real calendar day, at least
 * `MIN_LEAD_DAYS` out.
 *
 * Anything up to forty characters used to be accepted, and the audits
 * themselves submitted a day in 2025 and passed (#70). A date the calendar
 * does not have (the 31st of June) is refused as such rather than being
 * quietly rolled into July. The floor used to be "today or later"; the user
 * moved it to a week out so Ken has notice, and it is still judged on the
 * Massachusetts calendar `today` comes from.
 */
function cleanDate(value, today) {
  const match = DATE_PATTERN.exec(value)
  if (!match) throw new InputError('Enter the preferred date as YYYY-MM-DD.')
  const [, year, month, day] = match.map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new InputError('That date is not on the calendar.')
  }
  const floor = addCalendarDays(today, MIN_LEAD_DAYS)
  if (value < floor) throw new InputError(`I need at least a week's notice -- the earliest I can come is ${floor}.`)
  return value
}

/**
 * Requests and the quotes drafted for them.
 *
 * Until now these lived in the customer's browser, which meant a request no
 * owner could see and a quote no other device could read. They move here, into
 * the database that already holds inventory, because the draft has to be
 * computed over the catalog this process already serves -- and because a second
 * store would be infrastructure with no payoff at this size.
 *
 * The quote is drafted by calculateDraftQuote from src/pricing.js, imported
 * unchanged, the way this backend already imports markup and the catalog. One
 * pricing implementation, so the server and the screen cannot disagree about
 * what a customer was told.
 *
 * Access is by unguessable id, or by the key of the browser that submitted:
 * there is no listing without one, and no accounts. See decisions.md.
 */

const now = () => new Date().toISOString()

/** 128 bits from the platform CSPRNG: not guessable, not enumerable. */
export const newId = () => randomBytes(16).toString('hex')

/** Exported only so quotes.test.mjs can check it against the partition below -- not an invitation to import or derive from it elsewhere. */
export const FORM_FIELDS = [
  'vehicleInfo',
  'tireSelection',
  'location',
  'date',
  'locationType',
  'serviceZip',
  'locationNotes',
  'customerNotes',
  'customerName',
  'customerEmail',
]

/**
 * The personal keys inside `requests.payload`, redacted on a removal request.
 *
 * Deliberately separate from `FORM_FIELDS` above and not derived from it:
 * that list is the intake allow-list (business fields like `vehicleInfo` and
 * `date` mixed in with personal ones, and missing `customerPhone`, which is
 * cleaned and stored under its own name via `cleanCustomerPhone` rather than
 * passing through the form-field loop). This list answers a different
 * question -- which keys identify the customer -- and is pinned by a test the
 * same way `OUTBOX_PERSONAL_DATA_KEYS` and `INQUIRY_PERSONAL_FIELDS` are.
 * If you change this list, update the `UPDATE requests` statement in
 * docs/operations.md's manual removal procedure to match -- and check
 * whether the new or changed key also reaches `outbox.data` (see
 * `OUTBOX_PERSONAL_DATA_KEYS`) or `inquiries` (see `INQUIRY_PERSONAL_FIELDS`),
 * which are governed by their own constants and their own statements, not
 * this one (#230's bug, closed for `outbox` and `inquiries` already -- this
 * is `requests`' own list).
 */
export const REQUEST_PERSONAL_DATA_KEYS = [
  'customerName', 'customerEmail', 'customerPhone', 'location', 'locationNotes', 'customerNotes',
]

/**
 * Every `FORM_FIELDS` key that is not personal -- named so that "not in
 * `REQUEST_PERSONAL_DATA_KEYS`" has somewhere to be *said*, not just noticed
 * by its absence. Together with `REQUEST_PERSONAL_DATA_KEYS`, this is meant
 * to be an exhaustive partition of `FORM_FIELDS`: a test asserts every form
 * field lands in exactly one of the two lists, so a new intake field with
 * neither -- the likelier mistake than changing an existing key, since
 * nothing has to be touched for it to happen -- fails loudly instead of
 * quietly reaching the database unclassified. `customerPhone` is
 * deliberately outside `FORM_FIELDS` (see the comment above) and is not
 * expected here either; the partition test names that exception rather than
 * silently passing it through.
 */
export const REQUEST_NON_PERSONAL_FIELDS = [
  'vehicleInfo', 'tireSelection', 'date', 'locationType', 'serviceZip',
]

/** Bounded so a request cannot carry an essay. */
const LIMITS = {
  vehicleInfo: 200, tireSelection: 200, location: 300, date: 40,
  locationType: 40, serviceZip: 20, locationNotes: 1000,
  // "Anything else I should know?" (t64): special instructions, timing, where
  // the car is. Free text, so it is the field most likely to hold something a
  // customer would want gone: owner-only, like locationNotes, and redacted
  // with it on a removal request.
  customerNotes: 500,
  customerName: 200, customerEmail: 254,
}

const REQUIRED = ['vehicleInfo', 'tireSelection', 'location', 'date', 'customerName', 'customerEmail']

/**
 * What a customer-facing read of a request carries.
 *
 * Everything the status screen and the receipt need, and nothing that
 * identifies the customer to whoever else opens the link: no name, email or
 * phone; no street address, which is the strongest identifier on the row and
 * the same reason it is in the removal set (the ZIP stays as the coarse form,
 * and the kind of place is one of three fixed words); and no location notes,
 * which is free text where people write where a key is hidden or what the
 * gate code is. The owner reads the full payload.
 */
const CUSTOMER_REQUEST_FIELDS = ['vehicleInfo', 'tireSelection', 'quantity', 'date', 'locationType', 'serviceZip', 'disposeOldTires']

/**
 * What a customer-facing read of a quote carries, from inside `quotes.payload`.
 *
 * The same shape of list as `CUSTOMER_REQUEST_FIELDS` above and for the same
 * reason (#65): a positive list, not the payload minus a few, so a field
 * added to the payload later stays with the owner by default instead of
 * reaching `GET /api/requests/:id` -- a link designed to be shared (R19) --
 * the moment someone forgets to exclude it. `lineItems` and `total` are the
 * quote itself, the reason the customer is looking; `exception` and
 * `exceptionReasons` are shown to the customer by design (not a leak --
 * see the test pinning that a few lines below the request one). `requestId`
 * is deliberately absent: it is already set explicitly, from `quote.request_id`,
 * before this list is applied, and does not need to also come from the payload.
 *
 * `id`, `status`, `version`, `reason` and the timestamps are not payload
 * fields at all -- they are columns, added to both audiences' shape outside
 * this list, the same way `request`'s `id`/`createdAt`/`updatedAt` sit
 * outside `CUSTOMER_REQUEST_FIELDS`.
 *
 * `note` (t35): the owner's message attached to an adjusted quote, written
 * in the editor as "Note for customer" and rendered on `/status` and
 * `/confirmation` as "Note from Ken:" -- customer-facing by design, added to
 * this list in the same change that adds the field, so the field and its
 * permission are reviewed together rather than the permission arriving
 * later where nobody is looking at what it names.
 */
// subtotal/tax (pricing-settings.md, #289): both are the quote's own numbers,
// the reason the customer is looking, the same standing as lineItems/total.
// tax ships disabled by default, so most quotes never carry the key at all --
// `field in quotePayload` already handles an absent key correctly.
const CUSTOMER_QUOTE_FIELDS = ['lineItems', 'subtotal', 'tax', 'total', 'exception', 'exceptionReasons', 'note']

/** Deliberately permissive: catches typos, not RFC edge cases. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A job is usually a full set. Offered at the tire step; this is what a request carries if it says nothing. */
const DEFAULT_QUANTITY = 4

/**
 * How many tires, validated against the same list the tire step offers.
 *
 * A missing quantity is a request from before this existed, or a caller that
 * has not been told about it -- either way it means a full set, not a
 * refusal. Anything present that is not exactly one of the offered choices is
 * refused: this is not a general-purpose number field, it is a fixed choice,
 * and a stray "3" or "40" reaching the database would be a job nobody quoted.
 */
function cleanQuantity(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_QUANTITY
  const quantity = Number(value)
  if (!ALLOWED_QUANTITIES.includes(quantity)) {
    throw new InputError(`quantity must be one of ${ALLOWED_QUANTITIES.join(', ')}.`)
  }
  return quantity
}

/**
 * Whether the customer opted in to old-tire disposal (pricing-settings.md,
 * #289) -- a real choice, not a form field to trim, so it goes through its
 * own strict boolean check the way `quantity` gets its own numeric one
 * rather than passing through the FORM_FIELDS string loop.
 */
function cleanDisposeOldTires(value) {
  if (value === undefined || value === null || value === '') return false
  if (typeof value !== 'boolean') throw new InputError('disposeOldTires must be true or false.')
  return value
}

/**
 * The optional sentence attached to a cancellation.
 *
 * Optional means optional: nothing is a valid reason, and stores as no reason
 * rather than as an empty string every screen would then have to test for.
 */
function cleanReason(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new InputError('A reason must be text.')
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > 500) throw new InputError('That reason is too long.')
  return trimmed
}

function cleanQuoteAdjustment(input) {
  if (!input || typeof input !== 'object') throw new InputError('Send the quote adjustment as an object.')
  if (!Array.isArray(input.lineItems) || input.lineItems.length === 0 || input.lineItems.length > 25) {
    throw new InputError('A quote needs between 1 and 25 line items.')
  }

  const lineItems = input.lineItems.map((item, index) => {
    if (!item || typeof item !== 'object') throw new InputError(`Line ${index + 1} is not valid.`)
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    if (!description || description.length > 200) throw new InputError(`Line ${index + 1} needs a description under 200 characters.`)
    const quantity = Number(item.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new InputError(`Line ${index + 1} needs a quantity from 1 to 100.`)
    const unitPrice = Number(item.unitPrice)
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 100000 || Math.abs(Math.round(unitPrice * 100) - unitPrice * 100) > 1e-7) {
      throw new InputError(`Line ${index + 1} needs a valid unit price with no more than two decimal places.`)
    }
    return { description, quantity, unitPrice }
  })

  const note = input.note === undefined || input.note === null ? '' : input.note
  if (typeof note !== 'string') throw new InputError('The customer note must be text.')
  const trimmedNote = note.trim()
  if (trimmedNote.length > 1000) throw new InputError('The customer note is too long.')

  // subtotal/tax/total are not this function's to compute -- adjust() derives
  // them from these lineItems with computeQuoteTotals, the same function the
  // initial draft uses, so an adjusted quote can never store a total that
  // disagrees with its own subtotal and tax (finding 1, scrutiny pass 3).
  return { lineItems, note: trimmedNote }
}

function cleanCustomerKey(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{16,64}$/i.test(value.trim())) {
    throw new InputError('A customer key is required, and must be the one this browser was given.')
  }
  return value.trim().toLowerCase()
}

/**
 * A US number typed the ways people type it, stored E.164.
 *
 * Optional: an empty value returns ''. Anything else must resolve to ten
 * digits (with or without a leading 1, spaces, dashes, dots or parens).
 */
export function cleanCustomerPhone(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new InputError('customerPhone must be text.')
  const digits = value.replace(/\D/g, '')
  const tenDigits = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (tenDigits.length !== 10) {
    throw new InputError('customerPhone must be a US phone number.')
  }
  return '+1' + tenDigits
}

/**
 * Validate what the form submits.
 *
 * The same shape of check saveOffer makes: refuse on the way in, with a message
 * a person could act on, rather than storing something the rest of the system
 * has to keep making excuses for.
 */
function cleanRequest(input, today) {
  if (!input || typeof input !== 'object') throw new InputError('Send the request as an object.')

  const cleaned = {}
  for (const field of FORM_FIELDS) {
    const value = input[field]
    if (value === undefined || value === null) { cleaned[field] = ''; continue }
    if (typeof value !== 'string') throw new InputError(field + ' must be text.')
    const trimmed = value.trim()
    if (trimmed.length > LIMITS[field]) throw new InputError(field + ' is too long.')
    cleaned[field] = trimmed
  }
  cleaned.customerEmail = cleaned.customerEmail.toLowerCase()
  cleaned.customerPhone = cleanCustomerPhone(input.customerPhone)
  cleaned.quantity = cleanQuantity(input.quantity)
  cleaned.disposeOldTires = cleanDisposeOldTires(input.disposeOldTires)

  for (const field of REQUIRED) {
    if (!cleaned[field]) throw new InputError(field + ' is required.')
  }
  if (cleaned.customerEmail && !EMAIL_PATTERN.test(cleaned.customerEmail)) {
    throw new InputError('customerEmail must be a valid email address.')
  }
  cleaned.date = cleanDate(cleaned.date, today)

  // The ZIP is where the van goes, and the service-area check needs it. Five
  // digits, or ZIP+4 read as its five; the wizard carries the fitment ZIP into
  // this field, so a customer who typed it once is not asked twice (#70, #95).
  const zip = normalizeZip(cleaned.serviceZip)
  if (!zip) throw new InputError('Enter the five-digit ZIP code where we will meet you.')
  cleaned.serviceZip = zip
  return cleaned
}

/**
 * Every status a quote may hold.
 *
 * `approved` is here for what is already stored, not for anything new: the
 * owner's decision writes `sent` from now on, and the deployed database holds
 * rows that were approved before that was true. Dropping it from this list
 * would not tidy the vocabulary, it would make those rows unreadable.
 */
/**
 * Who performed an owner decision, recorded in `quotes.decided_by`.
 *
 * Today the owner screen is behind one shared password, so the system cannot
 * say *which person* approved a quote -- only that somebody holding that
 * password did. **"Ken approved this quote" is not a fact this system can
 * produce**, and that is a hole in the product's central promise rather than a
 * login inconvenience: the owner approval gate is what stands between a draft
 * and a customer being charged, and nothing records who operated it.
 *
 * This constant is the honest answer until Google sign-in lands (#290): rows
 * decided under the shared credential say so, and rows decided afterwards
 * carry the verified address. Both are true statements about how the decision
 * was authorised, and telling them apart later is the whole reason the column
 * exists now rather than after months of decisions nobody can attribute.
 *
 * `moveTo` takes an `actor` so the sign-in work has a seam to fill; until then
 * every owner decision falls back to this.
 *
 * ## One column keeps the latest decision, not a history -- and when that stops
 * ## being good enough
 *
 * A quote goes draft -> sent -> paid -> done, so marking a job done overwrites
 * who sent it. With one owner those are the same person and nothing is lost.
 *
 * **The trigger is a second Workspace account, not the sign-in change.**
 * Domain-only sign-in with exactly one `@kensmobiletire.com` account is still
 * one decider and this column stays honest; the history only starts being lost
 * when two people can decide, and from that moment it is lost silently and
 * immediately. That is a condition somebody can check -- count the accounts --
 * rather than a judgement about whether a project is far enough along.
 *
 * So an append-only events table is a **precondition of the second account**,
 * not a follow-up to #290. Its place is here. It is deliberately not built,
 * because today there is no accumulating loss to get ahead of.
 */
export const SHARED_PASSWORD_ACTOR = 'owner:shared-password'

export const QUOTE_STATUSES = [
  'draft', 'sent', 'approved', 'rejected', 'paid', 'done', 'cancelled',
]

/**
 * How the owner's screen groups those statuses.
 *
 * Named for what the owner is waiting on rather than for the status itself,
 * because that is the question the screen answers: `attention` is work waiting
 * on them, `awaiting` is waiting on the customer, `paid` is a job to go and do.
 * `open` is everything not finished, which is the default because an owner
 * opening the screen wants what is live, not the whole history.
 *
 * `approved` sits beside `sent` everywhere: it is the same state under the name
 * it was written with before this change, and a filter that hid those rows
 * would hide the requests that have been waiting longest.
 */
export const QUOTE_VIEWS = {
  open: ['draft', 'sent', 'approved', 'paid'],
  attention: ['draft'],
  awaiting: ['sent', 'approved'],
  paid: ['paid'],
  closed: ['done', 'rejected', 'cancelled'],
}

/** Statuses a request can still be cancelled from: before any money moved. */
const CANCELLABLE = ['draft', 'sent', 'approved']

/** Statuses a customer may pay from. `approved` is what the deployed rows say. */
const PAYABLE = ['sent', 'approved']

/** The current shape of the quotes table, as one place both paths use. */
const QUOTES_COLUMNS = `
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
  payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1, reason TEXT,
  draft_line_items TEXT, draft_total_cents INTEGER,
  decided_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(status IN (${QUOTE_STATUSES.map(status => `'${status}'`).join(', ')}))
`

export class Quotes {
  /**
   * `serviceArea` is the radius rule from backend/service-area.mjs (the
   * server reads it from the environment; tests pass one). `today` answers
   * the calendar day a preferred date is judged against, injectable so a
   * test can stand at a chosen day.
   */
  constructor(inventory, { serviceArea = readServiceAreaConfig({}), today = todayInServiceArea } = {}) {
    this.inventory = inventory
    this.serviceArea = serviceArea
    this.today = today
    this.db = inventory.db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_customer ON requests(customer_key, created_at);
      CREATE TABLE IF NOT EXISTS quotes (${QUOTES_COLUMNS});
      CREATE INDEX IF NOT EXISTS quotes_request ON quotes(request_id);
    `)
    this.migrate()
  }

  /**
   * Widen an already-created quotes table to the statuses above.
   *
   * CREATE TABLE IF NOT EXISTS does nothing to a table that exists, and SQLite
   * cannot ALTER a CHECK constraint, so a database created before these
   * statuses existed keeps the old one -- silently. Nothing in the tests would
   * notice, because every test and both CI jobs build the table fresh. The
   * deployed database does not: fly.toml mounts a volume, the rows are the
   * owner's real ones, and the first write of `sent` there would fail the
   * check. That is the owner's Approve button, so this runs before anything
   * else touches the table.
   *
   * The rebuild is SQLite's documented one -- new table, copy, drop, rename --
   * with foreign keys off around it, because dropping `quotes` while `requests`
   * is referenced by it is exactly what the switch is for. It is off outside
   * the transaction because the pragma is a no-op inside one.
   *
   * The condition is the stored schema itself rather than a version counter.
   * There is no migration framework here to hang a counter on, and asking the
   * table what constraint it actually carries is the question we care about: it
   * is right on a database from any earlier day, and it is a no-op on a fresh
   * one.
   */
  migrate() {
    const stored = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quotes'")
      .get()?.sql ?? ''
    if (!QUOTE_STATUSES.every(status => stored.includes(`'${status}'`))) {
      this.db.exec('PRAGMA foreign_keys=OFF')
      try {
        this.transaction(() => {
          this.db.exec(`CREATE TABLE quotes_migrating (${QUOTES_COLUMNS})`)
          // Copy forward every column both tables have, read off the tables
          // themselves rather than named by hand.
          //
          // This used to be a hand-written list, which was correct when the
          // only columns it could lose were `draft_line_items` and
          // `draft_total_cents` -- both re-derived from `payload` by the
          // additive step below, so dropping them cost nothing. `decided_by`
          // broke that: it cannot be re-derived from anything, so the next
          // status widening would have silently discarded who decided every
          // existing quote, in the one place where "it passed every test and
          // failed in production" is this file's own documented history.
          //
          // Reading the new shape from `quotes_migrating` and the old shape
          // from `quotes` keeps the two in step with no second list to
          // maintain: a column present in both is carried, one only in the new
          // shape is left to its default, and the next column added is
          // preserved without anyone remembering this comment.
          const target = this.db.prepare('PRAGMA table_info(quotes_migrating)').all().map(column => column.name)
          const source = new Set(this.db.prepare('PRAGMA table_info(quotes)').all().map(column => column.name))
          const carried = target.filter(column => source.has(column)).join(', ')
          this.db.exec(`
            INSERT INTO quotes_migrating (${carried}) SELECT ${carried} FROM quotes;
            DROP TABLE quotes;
            ALTER TABLE quotes_migrating RENAME TO quotes;
            CREATE INDEX IF NOT EXISTS quotes_request ON quotes(request_id);
          `)
        })
      } finally {
        this.db.exec('PRAGMA foreign_keys=ON')
      }
    }

    const columns = new Set(this.db.prepare('PRAGMA table_info(quotes)').all().map(column => column.name))
    if (!columns.has('draft_line_items')) this.db.exec('ALTER TABLE quotes ADD COLUMN draft_line_items TEXT')
    if (!columns.has('draft_total_cents')) this.db.exec('ALTER TABLE quotes ADD COLUMN draft_total_cents INTEGER')
    // Who decided. Nullable and left null on existing rows on purpose: a quote
    // decided before this column existed genuinely has no recorded actor, and
    // back-filling `SHARED_PASSWORD_ACTOR` would invent a record rather than
    // admit its absence. Null means "we did not record it"; the constant means
    // "we recorded that it was the shared credential". Those are different
    // claims and the difference is the point.
    if (!columns.has('decided_by')) this.db.exec('ALTER TABLE quotes ADD COLUMN decided_by TEXT')
    const missing = this.db.prepare('SELECT id, payload FROM quotes WHERE draft_line_items IS NULL OR draft_total_cents IS NULL').all()
    const saveDraft = this.db.prepare('UPDATE quotes SET draft_line_items=?, draft_total_cents=? WHERE id=?')
    for (const row of missing) {
      const payload = JSON.parse(row.payload)
      saveDraft.run(JSON.stringify(payload.lineItems ?? []), Math.round(Number(payload.total ?? 0) * 100), row.id)
    }
  }

  /** The catalog the customer was shown: live rows, composed the way the flow composes them. */
  catalog() {
    return catalogFromLiveRows(this.inventory.catalog())
  }

  transaction(fn) {
    return this.inventory.transaction(fn)
  }

  /**
   * Store a request and the quote drafted for it, in one transaction.
   *
   * A request without its quote is a customer waiting for a reply nobody
   * drafted, so neither row exists unless both do.
   */
  submit(input) {
    const customerKey = cleanCustomerKey(input?.customerKey)
    const request = cleanRequest(input, this.today())

    // Is this somewhere the van goes? Beyond the radius, or a ZIP nobody can
    // place, is refused here with the phone number, before anything is stored
    // and before a quote exists for a job nobody will do (#95). Inside the
    // radius but past the review distance, the request goes through and the
    // owner is told how far, on the same path every other reason for review
    // takes, so the card reads it like any other.
    const area = isServiceable(request.serviceZip, this.serviceArea)
    if (!area.serviceable) {
      // "Text", not "call": every customer-facing control promotes texting
      // (t63), and the panel that shows this sentence carries the text button.
      throw new InputError(`${area.message} Text me at ${SHOP_PHONE} if you'd like to ask anyway.`)
    }
    // The distance rides with the request for the owner's card. It is not in
    // the customer shape: the customer knows where they are.
    request.serviceMiles = area.miles

    const catalog = this.catalog()
    if (!catalog.some(tire => tire.id === request.tireSelection)) {
      throw new InputError("That tire isn't one I offer right now. Choose another.")
    }

    const id = newId()
    const stamp = now()
    // chosenLineIds is always [] until the wizard control exists (#354's
    // stage 3): an optional catalogue entry cannot be picked yet, so only
    // automatic entries can appear on a draft today. Passing [] here rather
    // than omitting the argument keeps this call site the one place that
    // will need to change once the wizard sends real choices.
    const draft = calculateDraftQuote({ ...request, id }, catalog, this.inventory.getPricingSettings(), this.inventory.getCatalogueLines(), [])
    if (area.reason === REASONS.REVIEW) {
      draft.exceptionReasons = [...draft.exceptionReasons, `Service address is ${area.message.replace(/^About/, 'about')}`]
      draft.exception = true
    }

    return this.transaction(() => {
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)')
        .run(id, customerKey, JSON.stringify(request), stamp, stamp)
      this.db.prepare(`INSERT INTO quotes
          (id, request_id, payload, status, version, reason, draft_line_items, draft_total_cents, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId(), id, JSON.stringify(draft), 'draft', 1, null,
          JSON.stringify(draft.lineItems), Math.round(draft.total * 100), stamp, stamp)
      return this.get(id)
    })
  }

  /**
   * A stored row as an API shape, for one of two audiences.
   *
   * The customer shape is a list of fields, not the payload minus a few. The
   * contact fields were never decided to be public: t34 added them to the
   * payload and the spread here passed everything through, so `GET
   * /api/requests/:id` answered name, email and phone to anyone holding the
   * link -- a link that is designed to be shared (R19), to a request whose
   * contact details must never reach another customer (R23). Listing what a
   * customer read carries means the next field added to the payload stays
   * with the owner until someone decides otherwise (#65).
   *
   * Legacy rows lack some fields and read `null` for others; the list copies
   * what is present and invents nothing, so both shapes stay as they were.
   */
  shapeRow(row, audience = 'customer') {
    if (!row) return null
    const quote = this.db
      .prepare('SELECT * FROM quotes WHERE request_id=? ORDER BY created_at DESC')
      .get(row.id)
    const payload = JSON.parse(row.payload)
    const request = audience === 'owner'
      ? payload
      : Object.fromEntries(CUSTOMER_REQUEST_FIELDS.filter(field => field in payload).map(field => [field, payload[field]]))
    const quotePayload = quote ? JSON.parse(quote.payload) : null
    // draftLineItems/draftTotal (t35) are computed from their own columns, not
    // payload keys, so they cannot pass through CUSTOMER_QUOTE_FIELDS the way
    // a payload field does -- but they are exactly the kind of owner-only
    // figure that list exists to keep out, so the owner gets them merged in
    // before the filter and the customer's read never sees them named at all.
    const ownerOnlyQuoteFields = quote ? {
      ...quotePayload,
      draftLineItems: JSON.parse(quote.draft_line_items ?? '[]'),
      draftTotal: (quote.draft_total_cents ?? Math.round(Number(quotePayload.total ?? 0) * 100)) / 100,
    } : null
    const quoteFields = audience === 'owner'
      ? ownerOnlyQuoteFields
      : Object.fromEntries(CUSTOMER_QUOTE_FIELDS.filter(field => field in quotePayload).map(field => [field, quotePayload[field]]))
    return {
      request: {
        id: row.id, ...request,
        createdAt: row.created_at, updatedAt: row.updated_at,
      },
      quote: quote
        ? {
            id: quote.id, requestId: quote.request_id, ...quoteFields,
            status: quote.status, version: quote.version,
            // Why a quote was rejected or cancelled, when the owner gave a
            // reason. Every screen that shows a closed request reads it here
            // rather than each one inventing a place to keep it.
            reason: quote.reason ?? null,
            // Who decided, owner-side only, and spread in rather than listed
            // unconditionally for a reason worth stating precisely.
            //
            // The quote *payload* is audience-partitioned: `quoteFields` above
            // filters it through CUSTOMER_QUOTE_FIELDS (#246, closing the quote
            // half of #65's seam). **The columns spread beside it here are
            // not.** `reason` above is unconditional -- deliberately, because
            // /status renders a decline reason to the customer -- and anything
            // added in this block follows it out to the shareable link unless
            // it says otherwise. So the partition that protects a payload key
            // does not protect a column, and this is a column.
            //
            // Nothing about who operates the owner screen is a customer's
            // business, hence the audience check.
            ...(audience === 'owner' ? { decidedBy: quote.decided_by ?? null } : {}),
            createdAt: quote.created_at, updatedAt: quote.updated_at,
          }
        : null,
    }
  }

  /**
   * One request by id alone: holding the id is the access.
   *
   * Because the id is the access, this is the customer shape unless the caller
   * says it is the owner asking: whoever holds the link gets the request and
   * the quote, and not who the customer is or where the key is hidden.
   */
  get(id, audience = 'customer') {
    if (typeof id !== 'string' || !id) return null
    return this.shapeRow(this.db.prepare('SELECT * FROM requests WHERE id=?').get(id), audience)
  }

  /** Everything one browser submitted, newest first, and nobody else's. */
  listForCustomer(customerKey) {
    const key = cleanCustomerKey(customerKey)
    return this.db
      .prepare('SELECT * FROM requests WHERE customer_key=? ORDER BY created_at DESC')
      .all(key)
      .map(row => this.shapeRow(row))
  }

  /**
   * Every request with its quote, newest first, for the owner's screen.
   *
   * The tire is resolved here rather than on the screen: the quote was drafted
   * against a catalog that may since have changed, and the owner reviewing it
   * should see the tire that was quoted. A row the catalog no longer carries
   * still shows its id, because "this tire is gone" is information the owner
   * needs, not a reason to render a blank.
   *
   * The supplier's stock count and when it was last seen ride along on the
   * owner's row (#105). The customer catalog strips both on purpose (R16),
   * so resolving the tire against it left the owner approving a quote with
   * no idea whether the supplier still had the tire, and refreshes are
   * monthly. This is the same audience line t44 drew for the request: the
   * owner's row carries what the owner's decision needs, and the customer's
   * row, which has no tire object at all, keeps carrying none of it. A tire
   * that is not a supplier row (a seed or generated one) reads null for all
   * three, which is the honest answer: nobody has looked.
   */
  listForOwner() {
    const catalog = this.catalog()
    const supplierRow = this.db.prepare('SELECT payload, last_seen, active FROM supplier WHERE id=?')
    return this.db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all().map(row => {
      const shaped = this.shapeRow(row, 'owner')
      const tire = catalog.find(item => item.id === shaped.request.tireSelection) ?? null
      const supplier = supplierRow.get(shaped.request.tireSelection)
      const supplierStock = supplier ? (JSON.parse(supplier.payload).source?.stock ?? null) : null
      return {
        ...shaped,
        tire: {
          ...(tire
            ? { id: tire.id, name: tire.name, size: tire.size, price: tire.price }
            : { id: shaped.request.tireSelection, name: null, size: null, price: null }),
          supplierStock,
          supplierLastSeen: supplier ? supplier.last_seen : null,
          supplierActive: supplier ? Boolean(supplier.active) : null,
        },
      }
    })
  }

  /**
   * The owner's screen: one view of the list, and the size of every view.
   *
   * The counts are for all five views, not just the one asked for, because the
   * screen shows them on the filters themselves -- an owner should be able to
   * see that three requests need a decision without first switching to the tab
   * that would tell them. That costs one pass over rows already in memory.
   *
   * An unknown view is the default rather than an error. This is a query
   * parameter on a screen an owner may have bookmarked, and a stale bookmark
   * should show them their open requests, not a failure.
   */
  viewForOwner(view) {
    const all = this.listForOwner()
    const chosen = Object.prototype.hasOwnProperty.call(QUOTE_VIEWS, view) ? view : 'open'

    const counts = {}
    for (const [name, statuses] of Object.entries(QUOTE_VIEWS)) {
      counts[name] = all.filter(row => statuses.includes(row.quote?.status)).length
    }

    return {
      view: chosen,
      counts,
      requests: all.filter(row => QUOTE_VIEWS[chosen].includes(row.quote?.status)),
    }
  }

  /**
   * Approve or reject a draft.
   *
   * The version check is the one PUT /api/owner/offers/:id already makes, for
   * the same reason: two owner windows, or a phone and a laptop, and the second
   * save would otherwise silently overwrite a decision made in the first. A
   * stale version is a 409 and the caller reloads.
   *
   * Only a draft can be decided. Re-approving an approved quote, or rejecting
   * one the customer has already paid, is not a decision -- it is a screen that
   * was looking at something out of date, which is what the version says.
   *
   * `reason` only ever reaches the row on a decline: sending a quote has
   * nothing to explain, and `moveTo`'s COALESCE would otherwise let a stray
   * value overwrite whatever a later close wrote.
   */
  decide(id, decision, version, reason = null) {
    if (decision !== 'sent' && decision !== 'rejected') {
      throw new InputError('A quote is either sent to the customer or rejected.')
    }
    return this.moveTo(id, version, {
      to: decision,
      from: ['draft'],
      reason: decision === 'rejected' ? cleanReason(reason) : null,
      refused: status => `This quote is already ${status}, so there is nothing to decide.`,
      audience: 'owner',
    })
  }

  /**
   * Save the owner's current version without changing the immutable draft.
   *
   * subtotal/tax/total are recomputed from the adjusted lineItems with
   * computeQuoteTotals -- the same function the initial draft uses -- rather
   * than trusting anything the client sent or leaving the draft's stale
   * numbers in place. `tax` is set explicitly (`undefined` when tax is off)
   * so JSON.stringify drops it from the stored payload instead of leaving a
   * pre-adjustment tax figure sitting beside a total that has moved on.
   *
   * computeQuoteTotals takes a resolved `taxable` per line rather than
   * classifying one itself (#354's correction to this seam): an owner's
   * hand-typed adjustment line carries no category the way the tire or a
   * catalogue entry does, so it is taxed only when tax applies to
   * everything (`appliesTo: 'all'`) and excluded otherwise -- undertaxed
   * rather than guessed at, the same rule `calculateDraftQuote` follows for
   * a catalogue line it cannot classify.
   */
  adjust(id, input) {
    const version = input?.version
    if (!Number.isInteger(version) || version < 0) {
      throw new InputError('Send the version you were shown, so a stale screen cannot overwrite a newer adjustment.')
    }
    const adjustment = cleanQuoteAdjustment(input)
    const settings = normalizePricingSettings(this.inventory.getPricingSettings())
    const taxableLines = adjustment.lineItems.map(line => ({ ...line, taxable: Boolean(settings.tax) && settings.tax.appliesTo === 'all' }))
    const totals = computeQuoteTotals(taxableLines, settings)

    return this.transaction(() => {
      const found = this.get(id)
      if (!found?.quote) throw new InputError('No such request.', 404)
      if (found.quote.version !== version) {
        throw new InputError('This quote changed in another window. Reload the list before saving.', 409)
      }
      if (found.quote.status !== 'draft') {
        throw new InputError(`This quote is already ${found.quote.status}, so it cannot be adjusted.`, 409)
      }
      const payload = { ...found.quote, ...adjustment, subtotal: totals.subtotal, tax: totals.tax, total: totals.total }
      for (const field of ['id', 'requestId', 'status', 'version', 'reason', 'draftLineItems', 'draftTotal', 'createdAt', 'updatedAt']) delete payload[field]
      this.db.prepare('UPDATE quotes SET payload=?, version=version+1, updated_at=? WHERE id=?')
        .run(JSON.stringify(payload), now(), found.quote.id)
      return this.get(id, 'owner')
    })
  }

  /**
   * Move one quote to a new status, with the version check every caller makes.
   *
   * The check is the one PUT /api/owner/offers/:id already makes, for the same
   * reason: two owner windows, or a phone and a laptop, and the second save
   * would otherwise silently overwrite a decision made in the first. A stale
   * version is a 409 and the caller reloads.
   *
   * The transitions themselves stay in the named methods below rather than
   * becoming arguments to `decide`. Approving, finishing and cancelling are
   * different acts with different rules about where they may be done from, and
   * folding them into one entry point would mean every one of those rules read
   * as a branch inside a method whose name says it does something else. What
   * they share is only this: a version, the statuses the move is legal from,
   * and a sentence for when it is not.
   */
  moveTo(id, version, { to, from, reason = null, refused, audience = 'customer', actor = null }) {
    if (!Number.isInteger(version) || version < 0) {
      throw new InputError('Send the version you were shown, so a stale screen cannot overwrite a newer decision.')
    }

    return this.transaction(() => {
      const found = this.get(id)
      if (!found?.quote) throw new InputError('No such request.', 404)
      if (found.quote.version !== version) {
        throw new InputError('This quote changed in another window. Reload the list before deciding.', 409)
      }
      if (!from.includes(found.quote.status)) {
        throw new InputError(refused(found.quote.status), 409)
      }

      // A reason is only ever added, never cleared: a row that carries why it
      // was closed should not lose that to a later write which had none.
      //
      // `decided_by` follows the same COALESCE rule, and for a sharper reason:
      // a quote goes draft -> sent (owner) -> paid (customer) -> done (owner),
      // and this is one column holding one value. Writing it on every
      // transition would let the customer's payment overwrite who sent the
      // quote -- destroying the exact fact the column exists to keep. So only
      // an owner decision writes it, and only when it has an actor to write.
      // `audience` already tells us which this is: `decide`, `finish` and
      // `cancel` pass 'owner', while the customer's own cancel does not.
      const decidedBy = audience === 'owner' ? (actor ?? SHARED_PASSWORD_ACTOR) : null
      this.db.prepare(`UPDATE quotes
          SET status=?, reason=COALESCE(?, reason), decided_by=COALESCE(?, decided_by),
              version=version+1, updated_at=?
          WHERE id=?`)
        .run(to, reason, decidedBy, now(), found.quote.id)
      return this.get(id, audience)
    })
  }

  /**
   * Close a paid request once the work is done.
   *
   * Only from `paid`, and it is the only way out of `paid`. Payment is still
   * the fake step that always succeeds, but the row it writes stands for money
   * having changed hands, and nothing here can undo that -- see the roadmap.
   */
  finish(id, version) {
    return this.moveTo(id, version, {
      to: 'done',
      from: ['paid'],
      refused: status => status === 'done'
        ? 'This request is already closed.'
        : `This request is ${status}, and only a paid request can be marked done.`,
      audience: 'owner',
    })
  }

  /**
   * The owner calling a request off, before it is paid.
   *
   * A reason is optional and travels with the row, because a customer who opens
   * their link and finds it cancelled should be told why rather than left to
   * guess. Nothing is deleted: the request stays, in the closed view.
   */
  cancel(id, version, reason) {
    return this.moveTo(id, version, {
      to: 'cancelled',
      from: CANCELLABLE,
      reason: cleanReason(reason),
      refused: status => status === 'paid'
        ? 'This request has been paid, so it cannot be cancelled. Mark it done when the work is finished.'
        : `This request is already ${status}.`,
      audience: 'owner',
    })
  }

  /**
   * The customer calling their own request off, before they pay for it.
   *
   * Authorised by `id` alone, the same as reading it (R19: holding the id is
   * the access) -- not by a `customerKey` match. That match was a real
   * write-side second factor, not nothing: the id is deliberately shareable
   * (the /status link exists to be shown to people, R19), so the key is what
   * separated "can read" from "can write" for a token designed to be
   * forwarded. Removing it means anyone the customer forwards the link to can
   * now pay or cancel on their behalf, and that is accepted deliberately, not
   * because the id was ever a secret.
   *
   * The trade is bounded, not free: a browser with no key yet (a different
   * device, a private window, or iOS's seven-day localStorage clear -- #97)
   * generates a fresh one that was never going to match anything, so the
   * check refused every legitimate customer opening the emailed link from a
   * new device (#284) -- and the writes it now exposes are non-financial,
   * idempotent, owner-gated, and (for cancel) reversible: paying charges
   * nothing extra and cannot be repeated for a second charge; cancelling
   * before payment deletes nothing and is reversible by texting Ken. No
   * version either, for the same reason pay() takes none -- the customer has
   * one screen showing one request of their own, and there is no second
   * window of theirs for a stale view to come from.
   *
   * One consequence found in review, accepted with its bound stated rather
   * than left undiscovered: someone holding the shared link can call pay()
   * on a sent quote specifically to block the customer's own cancel (this
   * method refuses once `paid`) and trigger a false "payment received"
   * email. No money moves and nothing is deleted, so the bound holds; filed
   * separately rather than fixed here.
   */
  cancelByCustomer(id, reason) {
    const found = this.get(id)
    if (!found?.quote) throw new InputError('No such request.', 404)
    if (found.quote.status === 'cancelled') return found
    if (found.quote.status === 'paid' || found.quote.status === 'done') {
      throw new InputError("This request has been paid for. Text me and I'll sort it out.", 409)
    }
    return this.moveTo(id, found.quote.version, {
      to: 'cancelled',
      from: CANCELLABLE,
      reason: cleanReason(reason),
      refused: status => `This request is already ${status}.`,
    })
  }

  /**
   * Mark an approved quote paid.
   *
   * Authorised by `id` alone, the same reasoning and the same bounded trade
   * as `cancelByCustomer` above (#284, #97): the `customerKey` match was a
   * real second factor for a deliberately shareable token, removed anyway
   * because the amount is fixed and already quoted, so someone else paying
   * it is not an attack worth guarding against.
   *
   * Unlike cancel, there is no reversal here at all, not even the owner's:
   * `CANCELLABLE` excludes `paid`, and `paid` moves only to `done`. A mistaken
   * or induced payment is not "text Ken and he sorts it out" the way a
   * cancellation is -- it needs a manual database edit. That gap is real and
   * is filed as its own issue rather than fixed in this change.
   *
   * Payment is still the fake step that always succeeds, but the result is
   * recorded here so both sides see it from their own devices. A draft cannot
   * be paid: that would be a customer paying a price the owner has not agreed
   * to.
   */
  pay(id) {
    const found = this.get(id)
    if (!found?.quote) throw new InputError('No such request.', 404)
    if (found.quote.status === 'paid') return found
    if (!PAYABLE.includes(found.quote.status)) {
      throw new InputError(found.quote.status === 'draft'
        ? 'This quote has not been approved yet, so there is nothing to pay.'
        : `This request is ${found.quote.status}, so there is nothing to pay.`, 409)
    }

    return this.transaction(() => {
      this.db.prepare('UPDATE quotes SET status=?, version=version+1, updated_at=? WHERE id=?')
        .run('paid', now(), found.quote.id)
      return this.get(id)
    })
  }
}
