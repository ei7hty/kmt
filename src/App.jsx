import { useEffect, useState } from 'react'
import { calculateDraftQuote } from './pricing.js'
import { getAllTires } from './data/catalog'
import { getAllQuotes, getAllRequests, saveQuote, saveRequest, updateQuoteStatus } from './store'
import './App.css'

function App() {
  const [route, setRoute] = useState(() => window.location.pathname)
  const [formData, setFormData] = useState({
    tireSize: '',
    vehicleInfo: '',
    tireSelection: '',
    location: '',
    date: ''
  })
  const [validationErrors, setValidationErrors] = useState({})
  const [submissionMessage, setSubmissionMessage] = useState('')
  const [ownerVersion, setOwnerVersion] = useState(0)
  const [orderStep, setOrderStep] = useState(1)
  const [stepError, setStepError] = useState('')
  const [fitment, setFitment] = useState({ width: '', ratio: '', diameter: '', zip: '' })
  const [fitmentStage, setFitmentStage] = useState('width')
  const [fitmentSearch, setFitmentSearch] = useState('')
  const tires = getAllTires()
  const tireSizes = [...new Set(tires.map(tire => tire.size))]
  const parsedSizes = tireSizes.map(size => {
    const match = size.match(/^(\d+)\/(\d+)R(\d+)$/)
    return match ? { size, width: match[1], ratio: match[2], diameter: match[3] } : null
  }).filter(Boolean)
  const widthOptions = [...new Set(parsedSizes.map(item => item.width))]
  const ratioOptions = [...new Set(parsedSizes.filter(item => item.width === fitment.width).map(item => item.ratio))]
  const diameterOptions = [...new Set(parsedSizes.filter(item => item.width === fitment.width && item.ratio === fitment.ratio).map(item => item.diameter))]

  useEffect(() => {
    const handlePopState = () => setRoute(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handleStorageChange = (event) => {
      if (!event.key || event.key === 'kmt_store') setOwnerVersion(version => version + 1)
    }
    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  const navigate = (path) => {
    window.history.pushState({}, '', path)
    setRoute(window.location.pathname)
  }

  const handleFormChange = (event) => {
    const { name, value } = event.target
    setFormData(previous => ({ ...previous, [name]: value }))
    if (validationErrors[name]) setValidationErrors(previous => ({ ...previous, [name]: '' }))
    setStepError('')
  }

  const handleSizeSelect = (size) => {
    setFormData(previous => ({ ...previous, tireSize: size, tireSelection: '' }))
    setStepError('')
  }

  const selectFitmentPart = (part, value) => {
    const next = { ...fitment, [part]: value }
    if (part === 'width') { next.ratio = ''; next.diameter = '' }
    if (part === 'ratio') next.diameter = ''
    setFitment(next)
    setFitmentStage(part === 'width' ? 'ratio' : part === 'ratio' ? 'diameter' : 'zip')
    const matchingSize = parsedSizes.find(item => item.width === next.width && item.ratio === next.ratio && item.diameter === next.diameter)
    if (matchingSize) handleSizeSelect(matchingSize.size)
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
    setOrderStep(2)
  }

  const continueFromVehicle = () => {
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

  const handleFormSubmit = (event) => {
    event.preventDefault()
    const errors = {}
    if (!formData.vehicleInfo.trim()) errors.vehicleInfo = 'Vehicle information is required'
    if (!formData.tireSelection) errors.tireSelection = 'Please select a tire'
    if (!formData.location.trim()) errors.location = 'Service location is required'
    if (!formData.date) errors.date = 'Preferred date is required'

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors)
      setStepError('Complete the service details to request your quote')
      return
    }

    const savedRequest = saveRequest(formData)
    if (savedRequest) {
      const draftQuote = calculateDraftQuote(savedRequest, tires)
      const savedQuote = saveQuote(savedRequest.id, draftQuote)
      const quoteMessage = savedQuote ? ` Draft quote total: $${draftQuote.total.toFixed(2)}.` : ''
      setSubmissionMessage(`Quote request submitted. Request ID: ${savedRequest.id}.${quoteMessage}`)
      setFormData({ tireSize: '', vehicleInfo: '', tireSelection: '', location: '', date: '' })
      setFitment({ width: '', ratio: '', diameter: '', zip: '' })
      setFitmentStage('width')
      setFitmentSearch('')
      setValidationErrors({})
      setStepError('')
      setOrderStep(1)
    }
  }

  if (route === '/owner') {
    const requests = getAllRequests()
    const quotes = getAllQuotes()
    const handleQuoteStatus = (quoteId, status) => {
      if (updateQuoteStatus(quoteId, status)) setOwnerVersion(version => version + 1)
    }

    return (
      <div className="app-shell owner-shell">
        <nav className="internal-nav">
          <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home">KMT<span>.</span></button>
          <div className="internal-nav-links"><button className="btn btn-neutral" onClick={() => navigate('/')}>← Back to Customer Flow</button></div>
        </nav>
        <div className="owner-content">
          <p className="eyebrow">OWNER</p>
          <h1 className="owner-heading">Quote Requests</h1>
          <p className="text-secondary owner-subhead">{requests.length === 1 ? '1 request waiting on you.' : `${requests.length} requests waiting on you.`}</p>
          {requests.length === 0 ? <div className="panel"><p className="text-secondary">No requests yet. Go to the customer flow and submit a request.</p></div> : (
            <div className="owner-list">
              {requests.map(request => {
                const quote = quotes.find(item => item.requestId === request.id)
                // The owner thinks in vehicles and tire names, not record ids.
                const requestedTire = tires.find(tire => tire.id === request.tireSelection)
                return (
                  <div key={`${request.id}-${ownerVersion}`} className="panel owner-request">
                    <p className="owner-request-vehicle">{request.vehicleInfo}</p>
                    <dl className="owner-details">
                      <div><dt>Tire:</dt> <dd>{requestedTire ? `${requestedTire.name} · ${requestedTire.size}` : request.tireSelection}</dd></div>
                      <div><dt>Location:</dt> <dd>{request.location}</dd></div>
                      <div><dt>Preferred Date:</dt> <dd>{request.date}</dd></div>
                    </dl>
                    {quote && <div className={quote.exception ? 'owner-quote owner-quote-exception' : 'owner-quote'}>
                      <div className="owner-quote-summary"><div><p className="text-secondary">Draft Quote</p><p className="owner-quote-total">${quote.total.toFixed(2)}</p></div><span className="owner-quote-status">{quote.status}</span></div>
                      {quote.exception && <div className="owner-exception-note"><p>Owner review required</p><ul>{quote.exceptionReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
                      {quote.status === 'draft' && <div className="owner-actions"><button onClick={() => handleQuoteStatus(quote.id, 'approved')} className="btn btn-approve">Approve &amp; Send</button><button onClick={() => handleQuoteStatus(quote.id, 'rejected')} className="btn btn-reject">Reject</button></div>}
                    </div>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (route === '/confirmation') {
    const quoteId = new URLSearchParams(window.location.search).get('quoteId')
    const quote = getAllQuotes().find(item => item.id === quoteId)
    const request = quote ? getAllRequests().find(item => item.id === quote.requestId) : null
    return (
      <div className="min-h-screen confirmation-shell bg-gray-50 p-4 sm:p-6 flex items-center justify-center"><div className="max-w-md w-full mx-auto bg-white p-6 sm:p-8 rounded-lg shadow text-center">
        <div className="mx-auto mb-4 flex items-center justify-center w-16 h-16 rounded-full bg-green-100"><svg className="w-9 h-9 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg></div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">You&apos;re all set!</h1><p className="text-gray-600 mb-6" role="status">Payment confirmed. Your quote has been paid in full.</p>
        {quote && <div className="border border-gray-200 rounded bg-gray-50 p-4 text-left mb-6">{request && <p className="text-sm text-gray-600 mb-2">Vehicle: <span className="font-medium text-gray-800">{request.vehicleInfo}</span></p>}<p className="text-sm text-gray-600 mb-2">Amount paid</p><p className="text-2xl font-semibold text-gray-900">${quote.total.toFixed(2)}</p><p className="mt-2 text-xs uppercase font-medium text-green-700">Confirmed &amp; Paid</p></div>}
        <a href="/" onClick={(event) => { event.preventDefault(); navigate('/') }} className="inline-block w-full px-4 py-3 bg-blue-600 text-white font-medium rounded">Start a New Request</a>
      </div></div>
    )
  }

  if (route === '/status') {
    const requests = getAllRequests()
    const quotes = getAllQuotes()
    const handlePayment = (quoteId) => { if (updateQuoteStatus(quoteId, 'paid')) navigate(`/confirmation?quoteId=${quoteId}`) }
    return (
      <div className="min-h-screen status-shell bg-gray-50 p-4 sm:p-6"><nav className="mb-6 flex gap-3"><button onClick={() => navigate('/')} className="px-4 py-2 bg-blue-600 text-white rounded">← New Request</button><button onClick={() => navigate('/owner')} className="px-4 py-2 bg-gray-700 text-white rounded">Owner Review →</button></nav><div className="max-w-2xl mx-auto bg-white p-6 rounded-lg shadow">
        <h1 className="text-3xl font-bold mb-4">Quote Status</h1><p className="text-gray-600 mb-6">Track submitted requests and owner decisions.</p>
        {requests.length === 0 ? <div className="border-2 border-gray-200 p-4 rounded bg-gray-50"><p className="text-gray-500">No quote requests have been submitted yet.</p></div> : <div className="space-y-4">{[...requests].reverse().map(request => { const quote = quotes.find(item => item.requestId === request.id); return <div key={request.id} className="border border-gray-300 p-4 rounded bg-gray-50"><p className="text-sm text-gray-600">Request ID: {request.id}</p><p className="font-medium mt-2">{request.vehicleInfo}</p>{quote ? <div className="mt-3"><p className="text-lg font-semibold">${quote.total.toFixed(2)}</p><p className="text-sm uppercase font-medium">{quote.status}</p>{quote.exception && <p className="mt-2 text-amber-800">This quote is awaiting owner review.</p>}{quote.status === 'approved' && <button onClick={() => handlePayment(quote.id)} className="mt-3 px-4 py-2 bg-green-600 text-white rounded">Pay ${quote.total.toFixed(2)}</button>}{quote.status === 'paid' && <div className="mt-2"><p className="text-sm text-green-700">Payment received. Your service is confirmed.</p><button onClick={() => navigate(`/confirmation?quoteId=${quote.id}`)} className="mt-2 text-sm text-blue-700 underline">View confirmation →</button></div>}{quote.status === 'rejected' && <p className="mt-2 text-sm text-red-700">This quote was declined. Please submit a new request.</p>}</div> : <p className="mt-3 text-sm text-gray-600">Quote is being prepared.</p>}</div> })}</div>}
      </div></div>
    )
  }

  const matchingTires = tires.filter(tire => tire.size === formData.tireSize)
  const selectedTire = tires.find(tire => tire.id === formData.tireSelection)
  return (
    <div className="min-h-screen customer-shell">
      <nav className="site-nav"><button className="brand-mark" onClick={() => navigate('/')} aria-label="KMT home"><img src="/kmtlogo.jpg" alt="Ken's Mobile Tire" /></button><div className="site-links"><button className="active" onClick={() => document.getElementById('order')?.scrollIntoView({ behavior: 'smooth' })}>Order Tires</button><button onClick={() => document.getElementById('services')?.scrollIntoView({ behavior: 'smooth' })}>Services</button><button onClick={() => navigate('/status')}>My Quote</button></div><a className="phone-link" href="tel:6174108319">Call (617) 410-8319</a></nav>
      <section className="hero-section"><div className="hero-copy"><p className="eyebrow">WE COME TO YOU</p><h1>Mobile Tire<br /><span>Service</span></h1><p className="hero-lede">Tires. Repairs. Roadside assistance.<br />Fast, reliable &amp; always on the move.</p><button className="hero-cta" onClick={() => document.getElementById('order')?.scrollIntoView({ behavior: 'smooth' })}>Order Tires <span>→</span></button></div><div className="hero-visual" aria-label="Ken's Mobile Tire brand"><img className="hero-logo" src="/kmtlogo.jpg" alt="Ken's Mobile Tire logo" /><span className="hero-visual-label">REAL MOBILE SERVICE / BOSTON</span></div></section>
      <section className="service-strip" id="services"><div><strong>◉</strong><span><b>WE COME TO YOU</b>Home, work or roadside</span></div><div><strong>↯</strong><span><b>FAST &amp; RELIABLE</b>Quick response you can count on</span></div><div><strong>✓</strong><span><b>QUALITY SERVICE</b>Professional care every time</span></div></section>
      <main className="order-section" id="order"><div className="section-heading"><p className="eyebrow">SHOP KMT</p><h2>Order tires online</h2><p>Find the right fit for your vehicle and we&apos;ll handle the rest.</p></div><div className="order-steps" aria-label="Order progress">{['Tire size', 'Your vehicle', 'Mobile service'].map((label, index) => <div className={orderStep === index + 1 ? 'order-step current' : orderStep > index + 1 ? 'order-step complete' : 'order-step'} key={label}><span>{index + 1}</span><b>{label}</b></div>)}</div>
        <form onSubmit={handleFormSubmit} className="order-form">
          {orderStep === 1 && <div className="fitment-modal"><div className="fitment-heading"><span className="fitment-wheel">◉</span><h3>Select your tire size</h3><button type="button" className="fitment-close" aria-label="Close tire size selector">×</button></div><div className="fitment-progress"><div className={fitmentStage === 'width' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Width</b><span /></div><div className={fitmentStage === 'ratio' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Ratio</b><span /></div><div className={fitmentStage === 'diameter' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Diameter</b><span /></div><div className={fitmentStage === 'zip' ? 'fitment-progress-item active' : 'fitment-progress-item'}><b>Zip code</b><span /></div></div><div className="fitment-visual"><div className="fitment-tire-art"><span>{fitment.width || '205'}</span><b>/ {fitment.ratio || '65'} R {fitment.diameter || '15'}</b></div><div className="fitment-width-mark">← Section width →</div></div><button type="button" className="fitment-back" onClick={goBackFitment} disabled={fitmentStage === 'width'}>← Back</button><div className="fitment-controls">{fitmentStage === 'zip' ? <div className="fitment-zip"><label htmlFor="fitmentZip">Where will we service you?</label><input id="fitmentZip" value={fitment.zip} onChange={event => setFitment(previous => ({ ...previous, zip: event.target.value }))} placeholder="Enter ZIP code (optional)" inputMode="numeric" /></div> : <><div className="fitment-search"><span>⌕</span><input value={fitmentSearch} onChange={event => setFitmentSearch(event.target.value)} placeholder="Search" aria-label="Search tire size" /></div><div className="fitment-options">{(fitmentStage === 'width' ? widthOptions : fitmentStage === 'ratio' ? ratioOptions : diameterOptions).filter(value => value.includes(fitmentSearch.trim())).map(value => <button type="button" className="fitment-option" key={value} onClick={() => selectFitmentPart(fitmentStage, value)}>{value}</button>)}</div></>}</div><div className="fitment-footer"><span>{formData.tireSize ? `Selected: ${formData.tireSize}` : 'Select width, ratio, and diameter'}</span><button type="button" className="primary-action" disabled={!formData.tireSize} onClick={continueFromSize}>Continue to tires <span>→</span></button></div></div>}
          {orderStep === 2 && <div className="step-panel"><button type="button" className="back-action" onClick={() => setOrderStep(1)}>← Change size</button><p className="panel-kicker">STEP 02 / YOUR TIRES</p><h3>Choose a tire for {formData.tireSize}</h3><div className="tire-options">{matchingTires.map(tire => <button type="button" className={formData.tireSelection === tire.id ? 'tire-option selected' : 'tire-option'} onClick={() => { setFormData(previous => ({ ...previous, tireSelection: tire.id })); setStepError('') }} key={tire.id} disabled={!tire.inStock}><span className="tire-art">◉</span><span className="tire-info"><strong>{tire.name}</strong><small>{tire.description}</small><small>{tire.inStock ? 'In stock' : 'Currently unavailable'}</small></span><b>${tire.price.toFixed(2)}<i>per tire</i></b></button>)}</div><div className="vehicle-inline"><label htmlFor="vehicleInfo">What car are these going on?</label><input id="vehicleInfo" type="text" name="vehicleInfo" value={formData.vehicleInfo} onChange={handleFormChange} placeholder="e.g. 2020 Honda Civic" /></div><button type="button" className="primary-action" onClick={continueFromVehicle}>Continue to mobile service <span>→</span></button></div>}
          {orderStep === 3 && <div className="step-panel"><button type="button" className="back-action" onClick={() => setOrderStep(2)}>← Back to tire selection</button><p className="panel-kicker">STEP 03 / WE COME TO YOU</p><h3>Where should we bring your service?</h3><div className="order-summary-line"><span>{selectedTire?.name} · {formData.tireSize}</span><b>{formData.vehicleInfo}</b></div><div className="service-fields"><div><label htmlFor="location">Service location</label><input id="location" type="text" name="location" value={formData.location} onChange={handleFormChange} placeholder="Address, city or ZIP code" /></div><div><label htmlFor="date">Preferred date</label><input id="date" type="date" name="date" value={formData.date} onChange={handleFormChange} /></div></div><button type="submit" className="primary-action">Request my quote <span>→</span></button></div>}
          {stepError && <p className="step-error" role="alert">{stepError}</p>}
        </form>
        {submissionMessage && <div className="success-message" role="status">{submissionMessage}</div>}
      </main>
      <footer className="site-footer"><span>KMT / KEN&apos;S MOBILE TIRE</span><span>Fast. Reliable. Always on the move.</span><button onClick={() => navigate('/owner')}>Owner review →</button></footer>
    </div>
  )
}

export default App
