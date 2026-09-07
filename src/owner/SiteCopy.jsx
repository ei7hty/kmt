import { useCallback, useEffect, useMemo, useState } from 'react'
import './SiteCopy.css'
import SignIn from './SignIn.jsx'
import { useNoIndex } from '../noindex.js'
import { NeedsSignIn, ownerSiteCopy, saveSiteCopy, undoSiteCopy } from '../store'
import { signOut } from './session.js'
import { PrivacyFooter } from '../routes/Privacy.jsx'

/**
 * Where Ken changes the words on his own site.
 *
 * The screen holds no list of fields. It renders whatever
 * `GET /api/owner/site-copy` sends, which comes from `src/site-copy.js` --
 * so a field added there appears here with no second edit, and a field this
 * screen offered that the server had never heard of could not happen.
 *
 * Three things this screen has to get right, and they are not decoration:
 *
 * **It says what will happen before it happens.** The voice rule sits beside
 * the fields rather than in a document, because Ken is one man and the site
 * says "I", never "we" -- and three customer emails have already gone out
 * saying "we". A rule nobody reads at the moment of writing is not a rule.
 *
 * **A refusal explains itself.** The server warns rather than blocks when copy
 * promises something the booking form will refuse, and the whole point of
 * warning is that Ken sees which words and why, then decides. A message alone
 * cannot do that, so the conflict comes back as data and renders as a list he
 * ticks.
 *
 * **Undo is one tap, and there are two of them.** Per field, resetting to the
 * wording that ships; and one step back over the whole last save. A mistake
 * you can take back is not a mistake that needs preventing, which is why this
 * matters more than any of the guards.
 */

/** The order sections appear in, and what to call them to Ken. */
const SECTIONS = [
  { prefix: 'hero.', title: 'The top of the page', note: 'The first thing anyone sees.' },
  { prefix: 'strip.', title: 'The three things you offer', note: 'The row under the hero. Always three; the layout has room for three.' },
  { prefix: 'order.', title: 'Above the order form', note: 'Where people start choosing tires.' },
  { prefix: 'footer.', title: 'The footer', note: null },
  { prefix: 'inquiry.', title: 'The "more than tires" page', note: 'What someone reads when they need something other than tires.' },
  { prefix: 'notFound.', title: 'The page-not-found page', note: 'Rare, but people do land on it from old links.' },
]

function sectionOf(fields, prefix) {
  return fields.filter(field => field.key.startsWith(prefix))
}

function SiteCopyScreen({ navigate }) {
  useNoIndex()
  const [fields, setFields] = useState([])
  const [defaults, setDefaults] = useState({})
  const [draft, setDraft] = useState({})
  const [savedValues, setSavedValues] = useState({})
  const [hasPrevious, setHasPrevious] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(false)
  // What the server refused, and what Ken has ticked to say he means it.
  const [conflicts, setConflicts] = useState([])
  const [composite, setComposite] = useState(null)
  const [accepted, setAccepted] = useState([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ownerSiteCopy()
      setFields(data.fields)
      setDefaults(data.defaults)
      setSavedValues(data.values)
      // The draft starts as what the page renders today -- an override where
      // there is one, the shipped wording otherwise -- so every box shows the
      // words that are live rather than an empty field meaning "unchanged".
      setDraft({ ...data.defaults, ...data.values })
      setHasPrevious(Boolean(data.previous))
      setError('')
      setNeedsSignIn(false)
    } catch (err) {
      if (err instanceof NeedsSignIn) { setNeedsSignIn(true); setError('') }
      else setError(err.message)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [load])

  /**
   * What to send: only the fields that differ from the shipped wording.
   *
   * A field Ken has put back to the default is sent as nothing at all rather
   * than as a copy of the default, so the override disappears and the field
   * follows the shipped wording again if it ever changes.
   */
  const overrides = useMemo(() => {
    const changed = {}
    for (const field of fields) {
      const value = (draft[field.key] ?? '').trim()
      if (value && value !== defaults[field.key]) changed[field.key] = value
    }
    return changed
  }, [fields, draft, defaults])

  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(overrides), ...Object.keys(savedValues)])
    return [...keys].some(key => (overrides[key] ?? null) !== (savedValues[key] ?? null))
  }, [overrides, savedValues])

  function edit(key, value) {
    setDraft(previous => ({ ...previous, [key]: value }))
    // Any edit invalidates an acknowledgement: it was given about words that
    // may no longer be there.
    setConflicts([])
    setComposite(null)
    setAccepted([])
    setNotice('')
  }

  function reset(key) {
    edit(key, defaults[key])
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      const data = await saveSiteCopy(overrides, accepted)
      setSavedValues(data.values ?? {})
      setHasPrevious(Boolean(data.previous))
      setConflicts([])
      setComposite(null)
      setAccepted([])
      setNotice('Saved. Your words are live on the next page load.')
    } catch (err) {
      if (err instanceof NeedsSignIn) { setNeedsSignIn(true); return }
      // A refusal carrying conflicts is not an error to report, it is a
      // question to ask. Anything else is an error.
      const carried = err.data
      if (carried?.conflicts?.length || carried?.composite) {
        setConflicts(carried.conflicts ?? [])
        setComposite(carried.composite ?? null)
        setError('')
      } else {
        setError(err.message)
      }
    } finally { setSaving(false) }
  }

  async function undo() {
    setSaving(true)
    try {
      const data = await undoSiteCopy()
      setSavedValues(data.values ?? {})
      setDraft({ ...defaults, ...(data.values ?? {}) })
      setHasPrevious(Boolean(data.previous))
      setNotice('Put back. Live on the next page load.')
      setError('')
    } catch (err) {
      if (err instanceof NeedsSignIn) setNeedsSignIn(true)
      else setError(err.message)
    } finally { setSaving(false) }
  }

  function toggle(term) {
    setAccepted(previous => previous.includes(term)
      ? previous.filter(item => item !== term)
      : [...previous, term])
  }

  if (needsSignIn) {
    return <SignIn onSignedIn={load} navigate={navigate} from="site-copy"
      what="This screen changes the words on your website." />
  }

  const leave = async () => {
    const { hosted } = await signOut()
    if (hosted) setNeedsSignIn(true); else navigate('/')
  }

  const outstanding = [...conflicts.map(conflict => conflict.term), ...(composite ? ['composite'] : [])]
    .filter(term => !accepted.includes(term))

  return (
    <div className="app-shell owner-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
        <div className="internal-nav-links">
          <button className="btn btn-neutral" onClick={() => navigate('/owner/quotes')}>← Quote Requests</button>
          <button className="btn btn-neutral" onClick={() => navigate('/')}>Back to Customer Flow</button>
          <button className="btn btn-neutral" onClick={leave}>Sign out</button>
        </div>
      </nav>

      <div className="owner-content">
        <header className="owner-heading">
          <p className="eyebrow">YOUR WORDS</p>
          <h1>The words on your site</h1>
          <p className="text-secondary">
            Change any of these and they go live on the next page load. Nothing here changes
            prices, tires, or how a customer books — only what the page says.
          </p>
          <p className="text-secondary">
            <strong>Write as yourself.</strong> The site is you, not a company: “I come to you”,
            never “we come to you”.
          </p>
        </header>

        {loading && <p className="status-note status-note-wait" role="status">Loading your words…</p>}
        {error && <p className="status-note status-note-bad" role="alert">{error}</p>}
        {notice && <p className="status-note status-note-ok" role="status">{notice}</p>}

        {(conflicts.length > 0 || composite) && (
          <div className="panel site-copy-conflicts" role="alert">
            <h2>Before this goes live</h2>
            <p className="text-secondary">
              Your booking form asks for at least a week&apos;s notice. These words promise sooner
              than that, so someone could decide to buy and then meet a wall. Change the wording,
              or tick to say you mean it.
            </p>
            {conflicts.map(conflict => (
              <label key={conflict.term} className="site-copy-ack">
                <input type="checkbox" checked={accepted.includes(conflict.term)} onChange={() => toggle(conflict.term)} />
                <span>
                  <strong>“{conflict.term}”</strong> in {conflict.label}. {conflict.constraint}
                </span>
              </label>
            ))}
            {composite && (
              <label className="site-copy-ack">
                <input type="checkbox" checked={accepted.includes('composite')} onChange={() => toggle('composite')} />
                <span>
                  <strong>Together these read as “fast”</strong> — {composite.terms.join(', ')}.
                  {' '}{composite.constraint}
                </span>
              </label>
            )}
          </div>
        )}

        {!loading && SECTIONS.map(section => {
          const sectionFields = sectionOf(fields, section.prefix)
          if (sectionFields.length === 0) return null
          return (
            <section className="panel site-copy-section" key={section.prefix}>
              <h2>{section.title}</h2>
              {section.note && <p className="text-secondary">{section.note}</p>}
              {sectionFields.map(field => {
                const value = draft[field.key] ?? ''
                const overridden = value.trim() !== defaults[field.key]
                const tooLong = value.trim().length > field.max
                return (
                  <div className="site-copy-field" key={field.key}>
                    <label htmlFor={`copy-${field.key}`}>{field.label}</label>
                    <input
                      id={`copy-${field.key}`}
                      data-testid={`edit-${field.testId}`}
                      value={value}
                      maxLength={field.max + 20}
                      onChange={event => edit(field.key, event.target.value)}
                    />
                    <div className="site-copy-meta">
                      <span className={tooLong ? 'status-note-bad' : 'text-secondary'}>
                        {value.trim().length} / {field.max}
                      </span>
                      {overridden && (
                        <button type="button" className="link-action" onClick={() => reset(field.key)}>
                          Put back “{defaults[field.key]}”
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </section>
          )
        })}

        {!loading && (
          <div className="site-copy-actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="site-copy-save"
              disabled={saving || !dirty || outstanding.length > 0}
              onClick={save}
            >
              {saving ? 'Saving…' : outstanding.length > 0 ? 'Tick the boxes above to save' : 'Save'}
            </button>
            {hasPrevious && (
              <button type="button" className="btn btn-neutral" disabled={saving} onClick={undo}>
                Undo my last save
              </button>
            )}
            {!dirty && <span className="text-secondary">Nothing changed yet.</span>}
          </div>
        )}
      </div>
      <PrivacyFooter navigate={navigate} />
    </div>
  )
}

export default SiteCopyScreen
