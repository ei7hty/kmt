import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getAllTires } from '../data/catalog'
import { loadCatalogForSize } from '../data/liveCatalog'
import { FITMENT_DIAMETERS, FITMENT_RATIOS, FITMENT_WIDTHS } from '../data/fitment'
import { previewRequestPrice, submitRequest } from '../store'
import { VehicleDetails, ServiceDetails } from '../components/RequestDetails'
import TireProductImage from '../components/TireProductImage.jsx'
import TireFilters from '../components/TireFilters.jsx'
import TireDetails from '../components/TireDetails.jsx'
import { applyFilters, NO_FILTERS } from '../tire-filters.js'
import { MIN_LEAD_DAYS, serviceDay } from '../components/serviceDay'
import { TEXT_HREF, TEXT_LABEL, URGENT_TEXT_HREF } from '../contact.js'
import { siteCopy } from '../site-copy.js'
import SocialProof from '../components/SocialProof.jsx'

/**
 * The words on this page, as Ken has them.
 *
 * Read once at module scope rather than per render: the server puts the copy
 * in the HTML, so it cannot change while the page is open, and a new value
 * arrives with a new document. Every key falls back to the wording that ships
 * in `src/site-copy.js`, so a missing block, malformed JSON, or a backend that
 * was never reachable renders exactly what it rendered before this existed --
 * which is what R15 and R22 require of the customer flow.
 */
const COPY = siteCopy()

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
/** How many more tires each press of the control reveals: a page, not the rest. */
const TIRE_PAGE_SIZE = 24

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
  return `Still checking today's prices for ${size}. One moment.`
}

/**
 * What a customer typed into the size search, read as the numbers on the
 * sidewall. "225/35R19", "225 35 19" and "2253519" read the same, and so does
 * any prefix of them. Only the digits count: the slash and the R are how the
 * app prints a size back, and the app has to accept what it prints. Each
 * step of the selector asks for one of the three numbers, so each step is
 * narrowed by its own part of what was typed.
 */
function readSizeQuery(text) {
  const digits = text.replace(/\D/g, '')
  return {
    digits,
    width: digits.slice(0, 3),
    ratio: digits.slice(3, 5),
    diameter: digits.slice(5, 7),
    complete: digits.length >= 7,
  }
}

/** Offered at the tire step. A full set by default -- most jobs are. */
const QUANTITY_OPTIONS = [1, 2, 4]
const DEFAULT_QUANTITY = 4
const money = amount => `$${Number(amount).toFixed(2)}`

function CustomerRequest({ navigate }) {
  const [formData, setFormData] = useState({
    tireSize: '',
    vehicleInfo: '',
    tireSelection: '',
    quantity: DEFAULT_QUANTITY,
    location: '',
    date: '', locationType: 'Home', serviceZip: '', locationNotes: '',
    customerName: '', customerEmail: '', customerPhone: '', disposeOldTires: false,
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
  // Pages of the tire list revealed past the preview, reset when the size changes.
  const [tirePages, setTirePages] = useState(0)
  // Narrowing state. Reset with the size, like tirePages -- the brands and
  // seasons in 225/50R17 are not the ones in 265/70R16.
  const [tireFilters, setTireFilters] = useState({ ...NO_FILTERS })
  const [tireSort, setTireSort] = useState('price')
  const [pricingPreviewState, setPricingPreviewState] = useState({ key: '', preview: null, error: '', status: 0 })
  const [pricingPreviewAttempt, setPricingPreviewAttempt] = useState(0)

  // The static catalog is the starting value rather than an empty list, so the
  // first paint is a working selector, and it is all the size step needs: the
  // fitment ranges are static. Nothing is fetched until a size is chosen.
  const [catalog, setCatalog] = useState(() => ({ tires: getAllTires(), source: 'static', disposalFee: null }))

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
        // Two names for one list, on purpose: the data layer answers 'static'
        // (the built-in catalog, its word for the code), and the step shows it
        // as 'standard' (the word a customer reads in the sentence above the
        // list). The DOM value, data-source="standard", is asserted by the gate
        // (QA's slow-network step), so renaming either side alone breaks a
        // check for a reason unrelated to what it tests.
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
  const pricingPreviewKey = [formData.tireSelection, formData.quantity, formData.serviceZip.trim(), formData.disposeOldTires].join('|')
  const canPreviewPrice = orderStep === 3 && Boolean(formData.tireSelection) && /^\d{5}(-\d{4})?$/.test(formData.serviceZip.trim())
  const pricingPreview = canPreviewPrice && pricingPreviewState.key === pricingPreviewKey ? pricingPreviewState.preview : null
  const pricingPreviewError = canPreviewPrice && pricingPreviewState.key === pricingPreviewKey ? pricingPreviewState.error : ''
  const pricingPreviewErrorStatus = canPreviewPrice && pricingPreviewState.key === pricingPreviewKey ? pricingPreviewState.status : 0
  const pricingPreviewLoading = canPreviewPrice && pricingPreviewState.key !== pricingPreviewKey

  // Every number shown before submit comes back from the same server method
  // that creates the stored draft. A late answer for an earlier ZIP, tire or
  // option is ignored so the card never labels stale arithmetic as current.
  useEffect(() => {
    if (!canPreviewPrice) return
    let current = true
    previewRequestPrice({
      tireSelection: formData.tireSelection,
      quantity: formData.quantity,
      serviceZip: formData.serviceZip,
      disposeOldTires: formData.disposeOldTires,
    }).then(preview => {
      if (current) setPricingPreviewState({ key: pricingPreviewKey, preview, error: '', status: 0 })
    }).catch(error => {
      if (current) setPricingPreviewState({ key: pricingPreviewKey, preview: null, error: error.message, status: error.status || 0 })
    })
    return () => { current = false }
  }, [canPreviewPrice, pricingPreviewKey, pricingPreviewAttempt, formData.tireSelection, formData.quantity, formData.serviceZip, formData.disposeOldTires])

  const retryPricingPreview = () => {
    setPricingPreviewState({ key: '', preview: null, error: '', status: 0 })
    setPricingPreviewAttempt(attempt => attempt + 1)
  }

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

  // The search, read as a size. A short entry narrows this step by itself; a
  // longer one, as when the whole size is typed, narrows this step by the
  // part that belongs to it, so "225/35R19" at the width step shows 225.
  const sizeQuery = fitmentSearch.trim()
  const typedSize = readSizeQuery(sizeQuery)
  const stageOptions = fitmentStage === 'width' ? widthOptions : fitmentStage === 'ratio' ? ratioOptions : diameterOptions
  const stagePartLength = fitmentStage === 'width' ? 3 : 2
  const stagePart = fitmentStage === 'width' ? typedSize.width : fitmentStage === 'ratio' ? typedSize.ratio : typedSize.diameter
  const sizeNeedle = typedSize.digits.length === 0 ? sizeQuery
    : typedSize.digits.length <= stagePartLength ? typedSize.digits
    : stagePart
  const shownSizeOptions = stageOptions.filter(value => value.includes(sizeNeedle))
  const typedWholeSize = typedSize.complete ? `${typedSize.width}/${typedSize.ratio}R${typedSize.diameter}` : ''

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
    setTirePages(0)
    // A brand or season chosen for the previous size means nothing for this
    // one, and a stale filter would silently hide most of the new list.
    setTireFilters({ ...NO_FILTERS })
    setTireSort('price')
    setListNote(null)
    setStepError('')
  }

  /**
   * The card a customer just tapped, and where it was when they tapped it.
   *
   * Choosing a tire closes the previous tire's detail panel, and when that
   * panel sat ABOVE the new card, everything below it moves up. Measured at
   * 375px: tapping the card under an open panel pulled it 365px up the screen
   * -- nearly half a phone -- while the browser's own scroll anchoring did
   * nothing, because the anchor it picked was still on screen and had not
   * moved. The effect below puts the card back under the finger that chose it.
   */
  const tireAnchor = useRef(null)

  const chooseTire = (tire, element) => {
    tireAnchor.current = element ? { element, top: element.getBoundingClientRect().top } : null
    setFormData(previous => ({ ...previous, tireSelection: tire.id }))
    setListNote(null)
    setStepError('')
  }

  // Layout, not effect: this has to run after React has written the DOM and
  // before the browser paints, or the jump is visible on the way to being
  // corrected. The element reference survives the re-render because the card's
  // key is stable, and `isConnected` covers the case where it does not.
  useLayoutEffect(() => {
    const anchor = tireAnchor.current
    tireAnchor.current = null
    if (!anchor?.element?.isConnected) return
    const delta = anchor.element.getBoundingClientRect().top - anchor.top
    if (delta) window.scrollBy(0, delta)
  }, [formData.tireSelection])

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

  /**
   * A whole size typed into the search is the customer telling us the answer
   * to all three steps at once, so it is applied at once: the three parts are
   * set and the selector moves on, exactly as tapping them would have.
   */
  const applyWholeSize = (typed) => {
    const size = `${typed.width}/${typed.ratio}R${typed.diameter}`
    setFitment(previous => ({ ...previous, width: typed.width, ratio: typed.ratio, diameter: typed.diameter }))
    setFitmentStage('zip')
    handleSizeSelect(size)
    setFitmentSearch('')
  }

  const searchSize = (text) => {
    setFitmentSearch(text)
    const typed = readSizeQuery(text)
    if (typed.complete && parsedSizes.some(item => item.width === typed.width && item.ratio === typed.ratio && item.diameter === typed.diameter)) {
      applyWholeSize(typed)
    }
  }

  const searchKey = (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (shownSizeOptions.length === 1) selectFitmentPart(fitmentStage, shownSizeOptions[0])
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
    setFormData(previous => ({ ...previous, serviceZip: fitment.zip || previous.serviceZip }))
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
    setStepError('')
    setOrderStep(3)
  }

  const changeServiceZip = () => {
    setFitment(previous => ({ ...previous, zip: formData.serviceZip }))
    setFitmentStage('zip')
    setFitmentSearch('')
    setStepError('')
    setOrderStep(1)
  }

  const handleFormSubmit = async (event) => {
    event.preventDefault()
    const errors = {}
    if (!formData.tireSelection) errors.tireSelection = 'Please select a tire'
    if (!formData.location.trim()) errors.location = 'Service location is required'
    // The server requires both of these (t48); saying so here saves the
    // customer a refused submit after filling everything else in.
    if (!/^\d{5}(-\d{4})?$/.test((formData.serviceZip || '').trim())) errors.serviceZip = 'Enter the five-digit ZIP code where we will meet you.'
    if (!formData.date) errors.date = 'Preferred date is required'
    else if (formData.date < serviceDay(MIN_LEAD_DAYS)) errors.date = 'I need a week’s notice for that day.'
    if (!formData.customerName.trim()) errors.customerName = 'Your name is required'
    if (!formData.customerEmail.trim()) errors.customerEmail = 'An email address is required'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.customerEmail.trim())) errors.customerEmail = 'Enter a valid email address'
    if (!pricingPreview) errors.pricingPreview = pricingPreviewError || 'Wait for the current price total before submitting.'

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
      setFormData({ tireSize: '', vehicleInfo: '', tireSelection: '', quantity: DEFAULT_QUANTITY, location: '', date: '', locationType: 'Home', serviceZip: '', locationNotes: '', customerName: '', customerEmail: '', customerPhone: '', disposeOldTires: false })
      setVehicle({ year: '', make: '', model: '' })
      setFitment({ width: '', ratio: '', diameter: '', zip: '' })
      setFitmentStage('width')
      setFitmentSearch('')
      setTirePages(0)
      setTireFilters({ ...NO_FILTERS })
      setTireSort('price')
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
  // Narrow, then order. In-stock first and cheapest first are unchanged and
  // still the default -- `sortTires` keeps both. What is new is that a size
  // holding 323 tires can be cut down before anyone scrolls.
  //
  // A chosen tire is never filtered away underneath the person who chose it:
  // it is added back if the current selection would have hidden it, and the
  // note below says so, rather than silently emptying their choice.
  const filteredTires = applyFilters(matchingTires, tireFilters, tireSort)
  const orderedTires = selectedTire && !filteredTires.includes(selectedTire)
    ? [selectedTire, ...filteredTires]
    : filteredTires
  // The preview, plus a page of 24 for each press of the control: a real size
  // holds well over a hundred supplier tires, and revealing them all at once
  // made a list thirty thousand pixels tall. A tire already chosen is never
  // hidden behind the control, whatever the list does after a refresh.
  const revealedCount = TIRE_PREVIEW_COUNT + tirePages * TIRE_PAGE_SIZE
  const chosenIndex = selectedTire ? orderedTires.indexOf(selectedTire) : -1
  const visibleTires = orderedTires.slice(0, Math.max(revealedCount, chosenIndex + 1))
  const hiddenTireCount = orderedTires.length - visibleTires.length
  const nextPageCount = Math.min(TIRE_PAGE_SIZE, hiddenTireCount)
  return (
    <div className="min-h-screen customer-shell">
      <nav className="site-nav"><button className="brand-mark" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/kens-dark-600.webp?v=2" alt="Ken's Mobile Tire" width="600" height="514" /></button><div className="site-links"><button className="active" onClick={() => document.getElementById('order')?.scrollIntoView({ behavior: 'smooth' })}>Order Tires</button><button onClick={() => document.getElementById('services')?.scrollIntoView({ behavior: 'smooth' })}>Services</button><button onClick={() => navigate('/status')}>My Quote</button></div><a className="phone-link" href={TEXT_HREF}>{TEXT_LABEL}</a></nav>
      <section className="hero-section"><div className="hero-copy"><p className="eyebrow" data-testid="copy-hero-eyebrow">{COPY['hero.eyebrow']}</p><h1 data-testid="hero-heading"><span data-testid="copy-hero-heading-top">{COPY['hero.headingTop']}</span><br /><span data-testid="copy-hero-heading-accent">{COPY['hero.headingAccent']}</span></h1><p className="hero-lede"><span data-testid="copy-hero-lede1">{COPY['hero.lede1']}</span><br /><span data-testid="copy-hero-lede2">{COPY['hero.lede2']}</span></p><button className="hero-cta" onClick={() => document.getElementById('order')?.scrollIntoView({ behavior: 'smooth' })}>Order Tires <span>→</span></button></div><div className="hero-visual" aria-label="Ken's Mobile Tire brand"><img className="hero-logo" src="/brand/kens-dark-1200.webp?v=2" srcSet="/brand/kens-dark-600.webp?v=2 600w, /brand/kens-dark-1200.webp?v=2 1200w" sizes="(max-width: 760px) 72vw, 420px" width="1200" height="1028" alt="Ken's Mobile Tire logo" /><span className="hero-visual-label" data-testid="copy-hero-visual-label">{COPY['hero.visualLabel']}</span></div></section>
      <section className="service-strip" id="services"><div><strong>◉</strong><span><b data-testid="copy-strip-1-title">{COPY['strip.1.title']}</b>{COPY['strip.1.body']}</span></div><div><strong>≡</strong><span><b data-testid="copy-strip-2-title">{COPY['strip.2.title']}</b>{COPY['strip.2.body']}</span></div><div><strong>✓</strong><span><b data-testid="copy-strip-3-title">{COPY['strip.3.title']}</b>{COPY['strip.3.body']}</span></div><a className="btn btn-neutral service-urgent" href={URGENT_TEXT_HREF}>{TEXT_LABEL}</a><button className="btn btn-neutral" onClick={() => navigate('/inquiry')}>More than tires? Tell me</button></section>
      <main className="order-section" id="order"><div className="section-heading"><p className="eyebrow" data-testid="copy-order-eyebrow">{COPY['order.eyebrow']}</p><h2 data-testid="copy-order-heading">{COPY['order.heading']}</h2><p data-testid="copy-order-lede">{COPY['order.lede']}</p></div><div className="order-steps" aria-label="Order progress">{['Tire size', 'Your vehicle', 'Mobile service'].map((label, index) => <div className={orderStep === index + 1 ? 'order-step current' : orderStep > index + 1 ? 'order-step complete' : 'order-step'} key={label}><span>{index + 1}</span><b>{label}</b></div>)}</div>
        <form noValidate onSubmit={handleFormSubmit} className="order-form">
          {orderStep === 1 && <div className="fitment-modal"><div className="fitment-heading"><span className="fitment-wheel">◉</span><h3>Select your tire size</h3></div><div className="fitment-progress"><div className={fitmentStage === 'width' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Width</b><span /></div><div className={fitmentStage === 'ratio' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Ratio</b><span /></div><div className={fitmentStage === 'diameter' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Diameter</b><span /></div><div className={fitmentStage === 'zip' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Zip code</b><span /></div></div><div className="fitment-visual"><img className="fitment-guide" src={(FITMENT_GUIDES[fitmentStage] ?? FITMENT_GUIDES.width).src} alt={(FITMENT_GUIDES[fitmentStage] ?? FITMENT_GUIDES.width).alt} /></div><button type="button" className="fitment-back" onClick={goBackFitment} disabled={fitmentStage === 'width'}>← Back</button><div className="fitment-controls">{fitmentStage === 'zip' ? <div className="fitment-zip"><label htmlFor="fitmentZip">Where do you need me?</label><input id="fitmentZip" value={fitment.zip} onChange={event => setFitment(previous => ({ ...previous, zip: event.target.value }))} placeholder="ZIP code, like 02149" inputMode="numeric" /></div> : <><div className="fitment-search"><span>⌕</span><input value={fitmentSearch} onChange={event => searchSize(event.target.value)} onKeyDown={searchKey} placeholder="Search, or type the whole size" aria-label="Search tire size" inputMode="numeric" autoComplete="off" /></div><div className="fitment-options">{shownSizeOptions.map(value => <button type="button" className="fitment-option" data-testid={`fitment-option-${value}`} key={value} onClick={() => selectFitmentPart(fitmentStage, value)}>{value}</button>)}</div>{sizeQuery && shownSizeOptions.length === 0 && <div className="fitment-empty" role="status"><p>{typedWholeSize ? `${typedWholeSize} isn't a size I list here.` : `No sizes match “${sizeQuery}”.`} {typedWholeSize ? (widthOptions.includes(typedSize.width) ? 'Try the width on its own, like ' + typedSize.width + ', and pick from there.' : 'Check the width on the sidewall; it is the first number, like 225.') : 'Sizes read width, ratio, rim, like 225/35R19.'}</p><button type="button" className="fitment-clear" onClick={() => setFitmentSearch('')}>Clear search</button></div>}</>}</div><div className="fitment-footer"><span>{formData.tireSize ? `Selected: ${formData.tireSize}` : 'Select width, ratio, and diameter'}</span><button type="button" className="primary-action" data-testid="continue-to-tires" disabled={!formData.tireSize} onClick={continueFromSize}>Continue to tires <span>→</span></button></div></div>}
          {orderStep === 2 && <div className="step-panel"><button type="button" className="back-action" onClick={() => setOrderStep(1)}>← Change size</button><p className="panel-kicker">STEP 02 / YOUR TIRES</p><h3>Tires in your size.</h3><p className="panel-note">Every tire I sell in <strong>{formData.tireSize}</strong>. Telling me what you drive is optional &mdash; it helps, but your size comes off the sidewall either way.</p><h4 className="tire-list-heading">Choose your tire</h4>{shownList.tires === null ? <div className="tire-loading" role="status"><span className="tire-loading-mark" aria-hidden="true" /><p>Checking today&apos;s prices for <strong>{formData.tireSize}</strong>…</p></div> : matchingTires.length === 0 ? <div className="tire-empty"><p className="tire-empty-title">I don&apos;t sell {formData.tireSize} online yet.</p><p className="tire-empty-body">I can still get it. Text me and I&apos;ll sort it out, or pick a different size.</p><div className="tire-empty-actions"><a className="btn btn-primary" href={TEXT_HREF}>{TEXT_LABEL}</a><button type="button" className="btn btn-neutral" onClick={() => { setOrderStep(1); setFitmentStage('width'); setFitment({ width: '', ratio: '', diameter: '', zip: '' }); setFormData(previous => ({ ...previous, tireSize: '', tireSelection: '' })); setStepError('') }}>Choose another size</button></div></div> : <>{shownList.source === 'standard' && <p className="tire-list-note" role="status">Showing my standard list; today&apos;s stock and prices are confirmed when I review your request.</p>}{shownList.pending && <button type="button" className="btn btn-neutral tire-refresh" onClick={refreshTireList}>Today&apos;s prices are in. Refresh the list</button>}{matchingTires.length > TIRE_PREVIEW_COUNT && <TireFilters tires={matchingTires} filters={tireFilters} sort={tireSort} onFiltersChange={next => { setTireFilters(next); setTirePages(0) }} onSortChange={next => { setTireSort(next); setTirePages(0) }} results={filteredTires} />}{filteredTires.length === 0 ? <p className="tire-list-note" role="status">No tire in {formData.tireSize} matches those filters. <button type="button" className="tire-filters-clear" onClick={() => setTireFilters({ ...NO_FILTERS })}>Clear filters</button></p> : null}<div className="tire-options" data-source={shownList.source}>{visibleTires.map(tire => <Fragment key={tire.id}><button type="button" className={formData.tireSelection === tire.id ? 'tire-option selected' : 'tire-option'} data-testid={`tire-option-${tire.id}`} aria-pressed={formData.tireSelection === tire.id} onClick={event => chooseTire(tire, event.currentTarget)} disabled={!tire.inStock}><TireProductImage tire={tire} /><span className="tire-info"><strong>{tire.name}</strong><small>{tire.description}</small><small className="tire-stock" data-stock={tire.inStock ? 'in' : 'out'}>{tire.inStock ? 'In stock' : 'Currently unavailable'}</small></span><b>${tire.price.toFixed(2)}<i>per tire</i></b></button>{formData.tireSelection === tire.id && <TireDetails tire={tire} tires={orderedTires} />}</Fragment>)}</div></>}{listNote && <p className={listNote.outcome === 'cleared' ? 'tire-reselect-note status-note-bad' : 'tire-reselect-note'} role="status" data-outcome={listNote.outcome}>{listNote.text}</p>}{hiddenTireCount > 0 && <button type="button" className="btn btn-neutral tire-show-more" data-remaining={hiddenTireCount} onClick={() => setTirePages(pages => pages + 1)}>Show {nextPageCount} more<small>{hiddenTireCount} of {orderedTires.length} not shown</small></button>}{matchingTires.length > 0 && <div className="tire-quantity"><span className="tire-quantity-label">How many tires?</span><div className="quantity-options">{QUANTITY_OPTIONS.map(value => <button type="button" key={value} className={formData.quantity === value ? 'quantity-option selected' : 'quantity-option'} data-testid={`quantity-option-${value}`} aria-pressed={formData.quantity === value} onClick={() => setFormData(previous => ({ ...previous, quantity: value }))}>{value}</button>)}</div>{selectedTire && <p className="tire-quantity-total">{formData.quantity} × ${selectedTire.price.toFixed(2)} = <b>${(selectedTire.price * formData.quantity).toFixed(2)}</b></p>}</div>}{matchingTires.length > 0 && <VehicleDetails vehicle={vehicle} onVehicleChange={handleVehicleChange} value={formData.vehicleInfo} onChange={handleFormChange} />}<button type="button" className="primary-action" data-testid="continue-to-mobile-service" onClick={continueFromVehicle} disabled={mustChooseAgain}>Continue to mobile service <span>→</span></button></div>}
          {orderStep === 3 && <div className="step-panel"><button type="button" className="back-action" data-testid="back-to-tire-selection" onClick={() => setOrderStep(2)}>← Back to tire selection</button><p className="panel-kicker">STEP 03 / I COME TO YOU</p><h3>Let’s bring the shop to you.</h3><p className="panel-note">Tell me where to find your vehicle and when you’d prefer service.</p><div className="order-summary-line"><span>{formData.quantity} × {selectedTire?.name} · {formData.tireSize}</span>{formData.vehicleInfo && <b>{formData.vehicleInfo}</b>}</div><ServiceDetails formData={formData} onChange={handleFormChange} errors={validationErrors} disposalFee={catalog.disposalFee} /><section className="pricing-preview" aria-labelledby="pricing-preview-heading" data-testid="pricing-preview"><div className="pricing-preview-heading"><div><p className="panel-kicker">YOUR ESTIMATED CHARGES</p><h4 id="pricing-preview-heading">Everything included</h4></div><button type="button" className="link-action" data-testid="change-pricing-zip" onClick={changeServiceZip}>Change ZIP</button></div>{pricingPreviewLoading && <p className="pricing-preview-status" role="status">Calculating the current total…</p>}{pricingPreviewError && <div className="pricing-preview-status status-note-bad" role="alert"><p>{pricingPreviewError}</p>{pricingPreviewErrorStatus === 409 ? <button type="button" className="link-action" onClick={() => setOrderStep(2)}>Choose another tire</button> : <div className="tire-empty-actions"><button type="button" className="link-action" data-testid="retry-pricing-preview" onClick={retryPricingPreview}>Try pricing again</button><a className="link-action" href={TEXT_HREF}>{TEXT_LABEL}</a></div>}</div>}{pricingPreview && <><div className="pricing-preview-lines">{pricingPreview.lineItems.map((line, index) => <div className="pricing-preview-line" key={`${line.description}-${index}`}><span>{line.description}{line.serviceZip && <small>ZIP {line.serviceZip}</small>}<small>{line.quantity} × {money(line.unitPrice)}</small></span><b>{money(line.lineTotal)}</b></div>)}</div><div className="pricing-preview-totals"><p><span>Subtotal</span><b>{money(pricingPreview.subtotal)}</b></p>{pricingPreview.tax && <p><span>Tax ({(pricingPreview.tax.rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%)</span><b>{money(pricingPreview.tax.amount)}</b></p>}<p className="pricing-preview-total"><span>Estimated total</span><b data-testid="pricing-preview-total">{money(pricingPreview.total)}</b></p></div></>}</section><p className="quote-reassurance">No payment now. Ken reviews your request before you pay.</p><button type="submit" className="primary-action" data-testid="request-my-quote" disabled={submitting || !pricingPreview}>{submitting ? 'Sending…' : <>Request my quote <span>→</span></>}</button></div>}
          {stepError && <p className="step-error" role="alert">{stepError}</p>}
        </form>
        {submissionMessage && <div className="success-message" role="status">
          {submissionMessage}
          {submittedId && <button type="button" className="link-action" onClick={() => navigate(`/status?request=${encodeURIComponent(submittedId)}`)}>Track this quote →</button>}
          {submittedId && <p className="text-secondary">Save this link; it is how you find your quote again.</p>}
        </div>}
        {submitError && <div className="panel submit-failure" role="alert">
          <p className="status-note status-note-bad">{submitError}</p>
          <p className="text-secondary">Your details are still here. Try again, or text me and I&apos;ll take it down for you.</p>
          <div className="tire-empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => lastSubmission && sendRequest(lastSubmission)} disabled={submitting}>
              {submitting ? 'Sending…' : 'Try again'}
            </button>
            <a className="btn btn-neutral" href={TEXT_HREF}>{TEXT_LABEL}</a>
          </div>
        </div>}
      </main>
      <SocialProof /><footer className="site-footer"><span data-testid="copy-footer-brand">{COPY['footer.brand']}</span><span>Mobile tire service. Malden, MA.</span><a href="/privacy" className="privacy-link" onClick={event => { event.preventDefault(); navigate('/privacy') }}>Privacy</a></footer>
    </div>
  )
}

export default CustomerRequest
