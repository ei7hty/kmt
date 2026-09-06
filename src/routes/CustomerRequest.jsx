import { useEffect, useState } from 'react'
import { getAllTires } from '../data/catalog'
import { loadCatalogForSize } from '../data/liveCatalog'
import { FITMENT_DIAMETERS, FITMENT_RATIOS, FITMENT_WIDTHS } from '../data/fitment'
import { submitRequest } from '../store'
import { VehicleDetails, ServiceDetails } from '../components/RequestDetails'

/**
 * Sidewall artwork for the size selector, one per stage.
 *
 * These replace a tire drawn in CSS with borders and radial gradients, which
 * could suggest a tire but could not point at the number being asked for. Each
 * asset highlights the digit the current stage wants, which is the whole job:
 * someone standing at their car needs to know which number to read off.
 */
const FITMENT_GUIDES = {
  width: {
    src: '/where-to-find.webp',
    alt: 'A tire sidewall showing where the size is printed, for example P 205 / 65 R 15.',
  },
  ratio: {
    src: '/tire-selector-ratio.webp',
    alt: 'A tire sidewall with the aspect ratio highlighted: the 65 in P 205 / 65 R 15.',
  },
  diameter: {
    src: '/tire-selector-diameter.webp',
    alt: 'A tire sidewall with the rim diameter highlighted: the 15 in P 205 / 65 R 15.',
  },
  zip: {
    src: '/where-to-find.webp',
    alt: 'A tire sidewall showing where the size is printed.',
  },
}

/**
 * How many tires the tire step shows before asking.
 *
 * A real size holds a hundred supplier tires, all offered at the markup price,
 * and a customer standing at their car is served by the cheap end of that list,
 * not the whole of it. Twelve is a screen or two on a phone. Nothing is taken
 * off the menu: the rest is one tap away, and every tire stays selectable.
 */
const TIRE_PREVIEW_COUNT = 12

/**
 * How long the tire step waits for today's prices before it shows the
 * standard list instead. On a slow connection the per-size answer lands in
 * about four and a half seconds, so this is the exception, not the wait.
 */
const LIVE_ANSWER_WAIT_MS = 8000

/** Nothing shown yet for the chosen size: the step is checking. */
const NO_TIRE_LIST = { size: '', tires: null, source: '', pending: null }

/**
 * The standard list for a size: the built-in catalog, shown only when the
 * live answer has failed or has not arrived in time. A quote built on one of
 * these reaches Ken for review before anything is charged, which is what the
 * sentence above the list says.
 */
function standardTiresFor(size) {
  return getAllTires().filter(tire => tire.size === size)
}

/** What Continue says while the step is still checking; cleared once a list is up. */
function stillCheckingMessage(size) {
  return `We are still checking today's prices for ${size}. One moment.`
}

/** Offered at the tire step. A full set by default -- most jobs are. */
const QUANTITY_OPTIONS = [1, 2, 4]
const DEFAULT_QUANTITY = 4

function CustomerRequest({ navigate }) {
  const [formData, setFormData] = useState({
    tireSize: '',
    vehicleInfo: '',
    tireSelection: '',
    quantity: DEFAULT_QUANTITY,
    location: '',
    date: '', locationType: 'Home', serviceZip: '', locationNotes: '',
    customerName: '', customerEmail: '', customerPhone: '',
  })
  const [vehicle, setVehicle] = useState({ year: '', make: '', model: '' })
  const [validationErrors, setValidationErrors] = useState({})
  const [submissionMessage, setSubmissionMessage] = useState('')
  // A failed submit is shown, not worked around: a quote drafted in this
  // browser is one no owner will ever see, and the customer would wait for a
  // reply that cannot come (R21).
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [lastSubmission, setLastSubmission] = useState(null)
  const [submittedId, setSubmittedId] = useState('')
  const [orderStep, setOrderStep] = useState(1)
  const [stepError, setStepError] = useState('')
  const [fitment, setFitment] = useState({ width: '', ratio: '', diameter: '', zip: '' })
  const [fitmentStage, setFitmentStage] = useState('width')
  const [fitmentSearch, setFitmentSearch] = useState('')
  const [showAllTires, setShowAllTires] = useState(false)

  // The static catalog is the starting value rather than an empty list, so the
  // first paint is a working selector, and it is all the size step needs: the
  // fitment ranges are static. Nothing is fetched until a size is chosen.
  const [catalog, setCatalog] = useState(() => ({ tires: getAllTires(), source: 'static' }))

  // The list the tire step shows for the chosen size, and the live answer held
  // back behind it. A choice never changes under the person making it: until
  // today's prices arrive the step shows no tire at all; if they are late or
  // never come, the standard list is shown and says so; and a live answer that
  // lands after that is offered as a refresh the customer chooses, never a
  // swap. The size is part of the value so a list for the previous size is
  // never shown for the next one.
  const [tireList, setTireList] = useState(NO_TIRE_LIST)
  // What a refresh did to the customer's choice, said in one line.
  const [listNote, setListNote] = useState(null)

  // One size, fetched when it is chosen (#154). Choosing another size aborts
  // the previous fetch and its timer.
  const chosenSize = formData.tireSize
  useEffect(() => {
    if (!chosenSize) return
    const controller = new AbortController()
    let live = true
    const update = (change) => {
      setTireList(previous => change(previous.size === chosenSize ? previous : { ...NO_TIRE_LIST, size: chosenSize }))
      setStepError(previous => previous === stillCheckingMessage(chosenSize) ? '' : previous)
    }
    loadCatalogForSize(chosenSize, controller.signal)
      .then(result => {
        if (!live) return
        setCatalog(result)
        const rows = result.tires.filter(tire => tire.size === chosenSize)
        update(current => {
          // A failed answer is the standard list, unless the wait already showed it.
          if (result.source !== 'live') return current.tires ? current : { ...current, tires: rows, source: 'standard' }
          // Live prices after the standard list is up: offered, not swapped in.
          if (current.tires) return { ...current, pending: rows }
          return { ...current, tires: rows, source: 'live' }
        })
      })
      .catch(() => {})
    const timer = setTimeout(() => {
      if (live) update(current => current.tires ? current : { ...current, tires: standardTiresFor(chosenSize), source: 'standard' })
    }, LIVE_ANSWER_WAIT_MS)
    return () => { live = false; controller.abort(); clearTimeout(timer) }
  }, [chosenSize])
  const shownList = tireList.size === chosenSize ? tireList : NO_TIRE_LIST

  const tires = catalog.tires
  // Each stage offers only choices that lead somewhere. The catalog is generated
  // across the full standard fitment ranges (see data/fitment.js and the
  // plausibility rule in data/catalog.js), so narrowing here is not a shortage
  // of stock -- it is the selector refusing to build a size no tire comes in.
  const parsedSizes = [...new Set(tires.map(tire => tire.size))]
    .map(size => {
      const match = size.match(/^(\d+)\/(\d+)R(\d+)$/)
      return match ? { size, width: match[1], ratio: match[2], diameter: match[3] } : null
    })
    .filter(Boolean)
  const widthOptions = FITMENT_WIDTHS.filter(width => parsedSizes.some(item => item.width === width))
  const ratioOptions = FITMENT_RATIOS.filter(ratio =>
    parsedSizes.some(item => item.width === fitment.width && item.ratio === ratio))
  const diameterOptions = FITMENT_DIAMETERS.filter(diameter =>
    parsedSizes.some(item => item.width === fitment.width && item.ratio === fitment.ratio && item.diameter === diameter))

  const handleFormChange = (event) => {
    const { name, value } = event.target
    setFormData(previous => ({ ...previous, [name]: value }))
    if (name === 'vehicleInfo') setVehicle({ year: '', make: '', model: '' })
    if (validationErrors[name]) setValidationErrors(previous => ({ ...previous, [name]: '' }))
    setStepError('')
  }

  const handleVehicleChange = (part, value) => {
    const next = { ...vehicle, [part]: value }
    if (part === 'make') next.model = ''
    setVehicle(next)
    setFormData(previous => ({ ...previous, vehicleInfo: [next.year, next.make, next.model].filter(Boolean).join(' ') }))
    setStepError('')
  }

  const handleSizeSelect = (size) => {
    setFormData(previous => ({ ...previous, tireSize: size, tireSelection: '' }))
    setShowAllTires(false)
    setListNote(null)
    setStepError('')
  }

  const chooseTire = (tire) => {
    setFormData(previous => ({ ...previous, tireSelection: tire.id }))
    setListNote(null)
    setStepError('')
  }

  /**
   * Bring in today's prices after the standard list was shown, and carry the
   * customer's choice across. The choice is held by id, and ids differ between
   * the two lists, so it is found again by size and name: the same tire moves
   * to its live id and price, with a line saying so; a tire that is not in
   * today's list (or cannot be chosen from it) clears the choice, says so, and
   * holds the step until a new one is made.
   */
  const refreshTireList = () => {
    const next = shownList.pending
    if (!next) return
    const chosen = shownList.tires.find(tire => tire.id === formData.tireSelection)
    const same = chosen && next.find(tire => tire.size === chosen.size && tire.name === chosen.name)
    setTireList({ size: chosenSize, tires: next, source: 'live', pending: null })
    if (!chosen) {
      setListNote(null)
    } else if (same && same.inStock) {
      setFormData(previous => ({ ...previous, tireSelection: same.id }))
      const priceChange = same.price === chosen.price ? '' : `, was $${chosen.price.toFixed(2)}`
      setListNote({ outcome: 'moved', text: `${same.name} is in today's list at $${same.price.toFixed(2)} per tire${priceChange}.` })
    } else {
      setFormData(previous => ({ ...previous, tireSelection: '' }))
      setListNote({ outcome: 'cleared', text: 'That tire is not in today\'s list; please choose again.' })
    }
    setStepError('')
  }
  const mustChooseAgain = listNote?.outcome === 'cleared' && !formData.tireSelection

  const selectFitmentPart = (part, value) => {
    const next = { ...fitment, [part]: value }
    if (part === 'width') { next.ratio = ''; next.diameter = '' }
    if (part === 'ratio') next.diameter = ''
    setFitment(next)
    setFitmentStage(part === 'width' ? 'ratio' : part === 'ratio' ? 'diameter' : 'zip')
    // A size is just the three numbers formatted. Whether we stock it is a
    // different question, answered at the tire step rather than by refusing to
    // let the customer enter what is on their car.
    if (next.width && next.ratio && next.diameter) {
      handleSizeSelect(`${next.width}/${next.ratio}R${next.diameter}`)
    }
    setFitmentSearch('')
    setStepError('')
  }

  const goBackFitment = () => {
    const previousStage = fitmentStage === 'zip' ? 'diameter' : fitmentStage === 'diameter' ? 'ratio' : 'width'
    setFitmentStage(previousStage)
    setFitmentSearch('')
    if (previousStage === 'width') {
      setFitment(previous => ({ ...previous, ratio: '', diameter: '' }))
      setFormData(previous => ({ ...previous, tireSize: '', tireSelection: '' }))
    } else if (previousStage === 'ratio') {
      setFitment(previous => ({ ...previous, diameter: '' }))
      setFormData(previous => ({ ...previous, tireSize: '', tireSelection: '' }))
    } else {
      setFitment(previous => ({ ...previous, zip: '' }))
    }
  }

  const continueFromSize = () => {
    if (!formData.tireSize) {
      setStepError('Choose your tire size to continue')
      return
    }
    setStepError('')
    setFormData(previous => ({ ...previous, serviceZip: previous.serviceZip || fitment.zip }))
    setOrderStep(2)
  }

  const continueFromVehicle = () => {
    if (shownList.tires === null) {
      setStepError(stillCheckingMessage(formData.tireSize))
      return
    }
    if (!formData.tireSelection) {
      setStepError('Choose a tire for your vehicle')
      return
    }
    if (!formData.vehicleInfo.trim()) {
      setStepError('Tell us what vehicle the tires are going on')
      return
    }
    setStepError('')
    setOrderStep(3)
  }

  const handleFormSubmit = async (event) => {
    event.preventDefault()
    const errors = {}
    if (!formData.vehicleInfo.trim()) errors.vehicleInfo = 'Vehicle information is required'
    if (!formData.tireSelection) errors.tireSelection = 'Please select a tire'
    if (!formData.location.trim()) errors.location = 'Service location is required'
    if (!formData.date) errors.date = 'Preferred date is required'
    if (!formData.customerName.trim()) errors.customerName = 'Your name is required'
    if (!formData.customerEmail.trim()) errors.customerEmail = 'An email address is required'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.customerEmail.trim())) errors.customerEmail = 'Enter a valid email address'

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors)
      setStepError('Complete the service details to request your quote')
      return
    }

    const location = [formData.location.trim(), formData.serviceZip?.trim() && !formData.location.includes(formData.serviceZip.trim()) ? formData.serviceZip.trim() : '', formData.locationNotes?.trim()].filter(Boolean).join(' · ')
    // Everything the request is made of, in one place, so the fields t34 adds
    // are added here rather than threaded through a call signature.
    const submission = { ...formData, location }
    setLastSubmission(submission)
    await sendRequest(submission)
  }

  /**
   * Send a request and say what happened.
   *
   * The server drafts the quote -- this browser no longer prices anything, so
   * there is one pricing implementation and the customer is told the number the
   * owner will see.
   */
  async function sendRequest(submission) {
    setSubmitting(true)
    setSubmitError('')
    try {
      const { request, quote } = await submitRequest(submission)
      setSubmissionMessage(`Quote request submitted. Draft quote total: $${quote.total.toFixed(2)}. Ken reviews it before anything is charged.`)
      setLastSubmission(null)
      setFormData({ tireSize: '', vehicleInfo: '', tireSelection: '', quantity: DEFAULT_QUANTITY, location: '', date: '', locationType: 'Home', serviceZip: '', locationNotes: '', customerName: '', customerEmail: '', customerPhone: '' })
      setVehicle({ year: '', make: '', model: '' })
      setFitment({ width: '', ratio: '', diameter: '', zip: '' })
      setFitmentStage('width')
      setFitmentSearch('')
      setShowAllTires(false)
      setValidationErrors({})
      setStepError('')
      setOrderStep(1)
      // Acknowledged here rather than by navigating away. The customer asked
      // for a quote and gets told what it is; "My Quote" in the nav is how they
      // follow it. Redirecting on submit would also take the confirmation off
      // the screen the audits check it on.
      setSubmittedId(request.id)
    } catch (error) {
      setSubmissionMessage('')
      setSubmitError(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  const matchingTires = shownList.tires ?? []
  const selectedTire = matchingTires.find(tire => tire.id === formData.tireSelection)
  // In-stock first, cheapest first; out-of-stock tires trail, since they are
  // shown but cannot be chosen. Only order and initial visibility change here
  // -- what is selectable does not.
  const orderedTires = [...matchingTires].sort((a, b) =>
    a.inStock === b.inStock ? a.price - b.price : a.inStock ? -1 : 1)
  const previewTires = orderedTires.slice(0, TIRE_PREVIEW_COUNT)
  // A tire already chosen is never hidden behind the control, whatever the list
  // does after the live catalog answers.
  const tireListExpanded = showAllTires || (selectedTire !== undefined && !previewTires.includes(selectedTire))
  const visibleTires = tireListExpanded ? orderedTires : previewTires
  const hiddenTireCount = orderedTires.length - visibleTires.length
  return (
    <div className="min-h-screen customer-shell">
      <nav className="site-nav"><button className="brand-mark" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/kens-dark-600.webp" alt="Ken's Mobile Tire" width="600" height="514" /></button><div className="site-links"><button className="active" onClick={() => document.getElementById('order')?.scrollIntoView({ behavior: 'smooth' })}>Order Tires</button><button onClick={() => document.getElementById('services')?.scrollIntoView({ behavior: 'smooth' })}>Services</button><button onClick={() => navigate('/status')}>My Quote</button></div><a className="phone-link" href="tel:6174108319">Call (617) 410-8319</a></nav>
      <section className="hero-section"><div className="hero-copy"><p className="eyebrow">WE COME TO YOU</p><h1>Mobile Tire<br /><span>Service</span></h1><p className="hero-lede">Tires. Repairs. Roadside assistance.<br />Fast, reliable &amp; always on the move.</p><button className="hero-cta" onClick={() => document.getElementById('order')?.scrollIntoView({ behavior: 'smooth' })}>Order Tires <span>→</span></button></div><div className="hero-visual" aria-label="Ken's Mobile Tire brand"><img className="hero-logo" src="/brand/kens-dark-1200.webp" srcSet="/brand/kens-dark-600.webp 600w, /brand/kens-dark-1200.webp 1200w" sizes="(max-width: 760px) 72vw, 420px" width="1200" height="1028" alt="Ken's Mobile Tire logo" /><span className="hero-visual-label">REAL MOBILE SERVICE / BOSTON</span></div></section>
      <section className="service-strip" id="services"><div><strong>◉</strong><span><b>WE COME TO YOU</b>Home, work or roadside</span></div><div><strong>↯</strong><span><b>FAST &amp; RELIABLE</b>Quick response you can count on</span></div><div><strong>✓</strong><span><b>QUALITY SERVICE</b>Professional care every time</span></div></section>
      <main className="order-section" id="order"><div className="section-heading"><p className="eyebrow">SHOP KMT</p><h2>Order tires online</h2><p>Find the right fit for your vehicle and we&apos;ll handle the rest.</p></div><div className="order-steps" aria-label="Order progress">{['Tire size', 'Your vehicle', 'Mobile service'].map((label, index) => <div className={orderStep === index + 1 ? 'order-step current' : orderStep > index + 1 ? 'order-step complete' : 'order-step'} key={label}><span>{index + 1}</span><b>{label}</b></div>)}</div>
        <form noValidate onSubmit={handleFormSubmit} className="order-form">
          {orderStep === 1 && <div className="fitment-modal"><div className="fitment-heading"><span className="fitment-wheel">◉</span><h3>Select your tire size</h3></div><div className="fitment-progress"><div className={fitmentStage === 'width' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Width</b><span /></div><div className={fitmentStage === 'ratio' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Ratio</b><span /></div><div className={fitmentStage === 'diameter' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Diameter</b><span /></div><div className={fitmentStage === 'zip' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Zip code</b><span /></div></div><div className="fitment-visual"><img className="fitment-guide" src={(FITMENT_GUIDES[fitmentStage] ?? FITMENT_GUIDES.width).src} alt={(FITMENT_GUIDES[fitmentStage] ?? FITMENT_GUIDES.width).alt} /></div><button type="button" className="fitment-back" onClick={goBackFitment} disabled={fitmentStage === 'width'}>← Back</button><div className="fitment-controls">{fitmentStage === 'zip' ? <div className="fitment-zip"><label htmlFor="fitmentZip">Where will we service you?</label><input id="fitmentZip" value={fitment.zip} onChange={event => setFitment(previous => ({ ...previous, zip: event.target.value }))} placeholder="Enter ZIP code (optional)" inputMode="numeric" /></div> : <><div className="fitment-search"><span>⌕</span><input value={fitmentSearch} onChange={event => setFitmentSearch(event.target.value)} placeholder="Search" aria-label="Search tire size" /></div><div className="fitment-options">{(fitmentStage === 'width' ? widthOptions : fitmentStage === 'ratio' ? ratioOptions : diameterOptions).filter(value => value.includes(fitmentSearch.trim())).map(value => <button type="button" className="fitment-option" key={value} onClick={() => selectFitmentPart(fitmentStage, value)}>{value}</button>)}</div></>}</div><div className="fitment-footer"><span>{formData.tireSize ? `Selected: ${formData.tireSize}` : 'Select width, ratio, and diameter'}</span><button type="button" className="primary-action" disabled={!formData.tireSize} onClick={continueFromSize}>Continue to tires <span>→</span></button></div></div>}
          {orderStep === 2 && <div className="step-panel"><button type="button" className="back-action" onClick={() => setOrderStep(1)}>← Change size</button><p className="panel-kicker">STEP 02 / YOUR TIRES</p><h3>Your tires. Your vehicle.</h3><p className="panel-note">Choose from tires in size <strong>{formData.tireSize}</strong>, then tell us what you drive.</p><VehicleDetails vehicle={vehicle} onVehicleChange={handleVehicleChange} value={formData.vehicleInfo} onChange={handleFormChange} /><h4 className="tire-list-heading">Choose your tire</h4>{shownList.tires === null ? <div className="tire-loading" role="status"><span className="tire-loading-mark" aria-hidden="true" /><p>Checking today&apos;s prices for <strong>{formData.tireSize}</strong>…</p></div> : matchingTires.length === 0 ? <div className="tire-empty"><p className="tire-empty-title">We don&apos;t stock {formData.tireSize} for online ordering.</p><p className="tire-empty-body">We can still source it. Call us and we&apos;ll sort it out, or pick a different size.</p><div className="tire-empty-actions"><a className="btn btn-primary" href="tel:6174108319">Call (617) 410-8319</a><button type="button" className="btn btn-neutral" onClick={() => { setOrderStep(1); setFitmentStage('width'); setFitment({ width: '', ratio: '', diameter: '', zip: '' }); setFormData(previous => ({ ...previous, tireSize: '', tireSelection: '' })); setStepError('') }}>Choose another size</button></div></div> : <>{shownList.source === 'standard' && <p className="tire-list-note" role="status">Showing our standard list; today&apos;s stock and prices are confirmed when Ken reviews your request.</p>}{shownList.pending && <button type="button" className="btn btn-neutral tire-refresh" onClick={refreshTireList}>Today&apos;s prices are in. Refresh the list</button>}<div className="tire-options" data-source={shownList.source}>{visibleTires.map(tire => <button type="button" className={formData.tireSelection === tire.id ? 'tire-option selected' : 'tire-option'} aria-pressed={formData.tireSelection === tire.id} onClick={() => chooseTire(tire)} key={tire.id} disabled={!tire.inStock}><span className="tire-art">◉</span><span className="tire-info"><strong>{tire.name}</strong><small>{tire.description}</small><small>{tire.inStock ? 'In stock' : 'Currently unavailable'}</small></span><b>${tire.price.toFixed(2)}<i>per tire</i></b></button>)}</div></>}{listNote && <p className={listNote.outcome === 'cleared' ? 'tire-reselect-note status-note-bad' : 'tire-reselect-note'} role="status" data-outcome={listNote.outcome}>{listNote.text}</p>}{hiddenTireCount > 0 && <button type="button" className="btn btn-neutral tire-show-all" onClick={() => setShowAllTires(true)}>Show all {orderedTires.length} tires</button>}{matchingTires.length > 0 && <div className="tire-quantity"><span className="tire-quantity-label">How many tires?</span><div className="quantity-options">{QUANTITY_OPTIONS.map(value => <button type="button" key={value} className={formData.quantity === value ? 'quantity-option selected' : 'quantity-option'} aria-pressed={formData.quantity === value} onClick={() => setFormData(previous => ({ ...previous, quantity: value }))}>{value}</button>)}</div>{selectedTire && <p className="tire-quantity-total">{formData.quantity} × ${selectedTire.price.toFixed(2)} = <b>${(selectedTire.price * formData.quantity).toFixed(2)}</b></p>}</div>}<button type="button" className="primary-action" onClick={continueFromVehicle} disabled={mustChooseAgain}>Continue to mobile service <span>→</span></button></div>}
          {orderStep === 3 && <div className="step-panel"><button type="button" className="back-action" onClick={() => setOrderStep(2)}>← Back to tire selection</button><p className="panel-kicker">STEP 03 / WE COME TO YOU</p><h3>Let’s bring the shop to you.</h3><p className="panel-note">Tell us where to find your vehicle and when you’d prefer service.</p><div className="order-summary-line"><span>{formData.quantity} × {selectedTire?.name} · {formData.tireSize}</span><b>{formData.vehicleInfo}</b></div><ServiceDetails formData={formData} onChange={handleFormChange} errors={validationErrors} /><p className="quote-reassurance">No payment now. Ken reviews your request before you pay.</p><button type="submit" className="primary-action" disabled={submitting}>{submitting ? 'Sending…' : <>Request my quote <span>→</span></>}</button></div>}
          {stepError && <p className="step-error" role="alert">{stepError}</p>}
        </form>
        {submissionMessage && <div className="success-message" role="status">
          {submissionMessage}
          {submittedId && <button type="button" className="link-action" onClick={() => navigate(`/status?request=${encodeURIComponent(submittedId)}`)}>Track this quote →</button>}
          {submittedId && <p className="text-secondary">Save this link; it is how you find your quote again.</p>}
        </div>}
        {submitError && <div className="panel submit-failure" role="alert">
          <p className="status-note status-note-bad">{submitError}</p>
          <p className="text-secondary">Your details are still here. Try again, or call the shop and we will take it down for you.</p>
          <div className="tire-empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => lastSubmission && sendRequest(lastSubmission)} disabled={submitting}>
              {submitting ? 'Sending…' : 'Try again'}
            </button>
            <a className="btn btn-neutral" href="tel:6174108319">Call (617) 410-8319</a>
          </div>
        </div>}
      </main>
      <footer className="site-footer"><span>KMT / KEN&apos;S MOBILE TIRE</span><span>Fast. Reliable. Always on the move.</span><button onClick={() => navigate('/owner')}>Owner review →</button></footer>
    </div>
  )
}

export default CustomerRequest
