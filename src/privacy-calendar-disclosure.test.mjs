/**
 * The privacy notice's calendar promise, and the code that has to keep it.
 *
 * Phase A of the scheduling work (#535, `.forge/decisions.md`) sends a paid
 * job's **name, service address, mobile number and notes** to Google
 * Calendar. Before it, the notice's honest answer to "who sees it" was "Ken,
 * and nobody else" -- the tire supplier only ever hears sizes. That answer
 * stops being whole the moment an event is written, and `.forge/decisions.md`
 * records the notice as a release blocker rather than a follow-up.
 *
 * WHAT THIS GUARDS, which is not the wording. Copy is Ken's and he may change
 * it. What must not drift is the PROMISE against the CODE:
 *
 *   - the notice tells a customer their details go to Google, and
 *   - it tells them a removal request deletes the calendar entry too.
 *
 * The second is a claim about behaviour. It is true today because
 * `scripts/redact.mjs` calls `calendar.forget(requestId)` -- read off the
 * code, not assumed. If that call is ever removed while the notice still
 * promises it, the page lies to a customer about their own data, and nothing
 * else in this tree would notice.
 *
 * WHY THE SECOND CHECK IS CONDITIONAL. The calendar module ships with #535
 * and is not on `main` yet, so this file has to run green before it exists
 * and arm itself the moment it does. A conditional check that nobody proved
 * can fail is worth nothing, so the control below runs the reader against
 * text that does and does not contain the call.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const has = path => existsSync(fileURLToPath(new URL(path, root)))

const privacy = read('src/routes/Privacy.jsx')
const policy = read('docs/data-policy.md')

/** Does this source call `forget(...)` on something calendar-ish? */
function deletesTheEvent(source) {
  return /calendar\s*\.\s*forget\s*\(/.test(source)
}

/** Everything under one `<h2>` heading, up to the next one. */
function section(source, heading) {
  const found = new RegExp(`<h2>${heading}</h2>([\\s\\S]*?)(?=<h2>|</div>)`).exec(source)
  return found ? found[1] : null
}

test('the notice says the details reach Google, under "Who sees it"', () => {
  // SCOPED TO THE SECTION, and that is not fussiness. Asserting `/Google/`
  // against the whole page passed with the disclosure stripped out, because
  // the Analytics section further down also says "Google" -- the test was
  // reading a sentence about visit counting and reporting it as a sentence
  // about a customer's address. Found by mutation, not by reading.
  const whoSeesIt = section(privacy, 'Who sees it')
  assert.ok(whoSeesIt, 'the "Who sees it" section is gone or restructured')

  assert.match(whoSeesIt, /Google/,
    '"Who sees it" never names Google; a customer reading "Ken does, the supplier never does" is told something untrue')
  assert.match(whoSeesIt, /calendar/i, '"Who sees it" does not mention the calendar')

  // The pre-existing promise it sits beside has to survive the addition --
  // the supplier genuinely still never sees any of this.
  assert.match(whoSeesIt, /tire supplier never does/,
    'the supplier promise is gone from "Who sees it"; it is still true and still worth saying')

  // The control for the scoping itself: the Analytics section is a different
  // section and really does mention Google, so "scoped" means something here.
  const analytics = section(privacy, 'Analytics')
  assert.ok(analytics && /Google/.test(analytics),
    'the Analytics section no longer names Google, so the scoping above is no longer distinguishing anything')
})

test('the notice promises removal reaches the calendar entry', () => {
  const removal = /<h2>Removing your details<\/h2>\s*<p>([\s\S]*?)<\/p>/.exec(privacy)
  assert.ok(removal, 'the "Removing your details" paragraph is gone or restructured')
  assert.match(removal[1], /calendar/i,
    'the removal paragraph does not mention the calendar entry, so a customer is told their details are removed while the event stays')
})

test('and the code keeps that promise -- armed the moment the calendar ships', () => {
  // The control FIRST, so a vacuous pass below is impossible to mistake for
  // a real one: the reader really can tell the two apart.
  assert.equal(deletesTheEvent('const gone = await calendar.forget(options.request)'), true)
  assert.equal(deletesTheEvent('const gone = await calendar.archive(options.request)'), false)
  assert.equal(deletesTheEvent('nothing here mentions it at all'), false)

  // A commented-out call still reads as present. That is a known limit of a
  // text reader and it is the right way round: this errs towards a false
  // alarm, which costs a second look, rather than towards a miss, which
  // costs a promise to a customer about their own data.
  assert.equal(deletesTheEvent('// await calendar.forget(id) -- disabled for now'), true)

  if (!has('backend/calendar.mjs')) {
    // #535 has not landed. Say so out loud rather than passing silently: a
    // skip that looks like a pass is the failure this suite exists to avoid.
    console.log('  (calendar module not on this branch yet; the redaction check arms when #535 lands)')
    return
  }

  assert.ok(has('scripts/redact.mjs'), 'the calendar ships but there is no redaction script to delete its events')
  assert.ok(deletesTheEvent(read('scripts/redact.mjs')),
    'scripts/redact.mjs no longer deletes the Google event, but the privacy notice still promises a removal request does -- fix the code or change the promise, in this commit')
})

test('the policy the notice points at covers the calendar too', () => {
  // docs/data-policy.md says of itself: "what is written here is the thing
  // that makes that page's promises true ... the gap belongs on this page in
  // plain words, not left silent between the two." A notice that discloses
  // Google over a policy that never mentions it is exactly that gap.
  assert.match(policy, /Google Calendar/,
    'docs/data-policy.md does not mention Google Calendar, so the notice promises something the policy behind it never describes')
  assert.match(policy, /forget\(/,
    'the policy does not record that removal deletes the event, which is the mechanism the notice depends on')
})
