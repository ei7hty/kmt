import { MIN_LEAD_DAYS, serviceDay } from './serviceDay'

const MAKES = ['Acura', 'Audi', 'BMW', 'Buick', 'Cadillac', 'Chevrolet', 'Chrysler', 'Dodge', 'Ford', 'GMC', 'Honda', 'Hyundai', 'Jeep', 'Kia', 'Lexus', 'Lincoln', 'Mazda', 'Mercedes-Benz', 'Nissan', 'Ram', 'Subaru', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo']
const YEARS = Array.from({ length: 40 }, (_, index) => String(new Date().getFullYear() + 1 - index))

export function VehicleDetails({ vehicle, onVehicleChange, value, onChange }) {
  return <section className="request-details" aria-labelledby="vehicle-heading">
    <div className="detail-heading"><div><span className="detail-index">YOUR VEHICLE</span><h4 id="vehicle-heading">What do you drive?</h4></div><span className="detail-badge">No VIN needed</span></div>
    <p className="detail-help">Start with the year and make, then add your model. Unsure? Tell me what you know.</p>
    <div className="vehicle-fields">
      <div><label htmlFor="vehicleYear">Year</label><input id="vehicleYear" list="vehicle-years" inputMode="numeric" placeholder="2020" value={vehicle.year} onChange={event => onVehicleChange('year', event.target.value)} /><datalist id="vehicle-years">{YEARS.map(year => <option key={year} value={year} />)}</datalist></div>
      <div><label htmlFor="vehicleMake">Make</label><input id="vehicleMake" list="vehicle-makes" placeholder="Search or type a make" value={vehicle.make} onChange={event => onVehicleChange('make', event.target.value)} /><datalist id="vehicle-makes">{MAKES.map(make => <option key={make} value={make} />)}</datalist></div>
      <div><label htmlFor="vehicleModel">Model</label><input id="vehicleModel" placeholder="e.g. Civic or F-150 Pickup" value={vehicle.model} onChange={event => onVehicleChange('model', event.target.value)} /></div>
    </div>
    <details className="manual-vehicle"><summary>Prefer to type your vehicle in one line?</summary><label htmlFor="vehicleInfo">Vehicle description</label><input id="vehicleInfo" name="vehicleInfo" value={value} onChange={onChange} placeholder="e.g. 2020 Honda Civic" /></details>
    {value && <p className="vehicle-preview"><span aria-hidden="true">✓</span> {value}</p>}
    <p className="detail-help detail-footnote">Your tire size comes from the sidewall you selected. Vehicle details don’t verify fitment.</p>
  </section>
}

const dateOffset = serviceDay

export function ServiceDetails({ formData, onChange, errors }) {
  const update = (name, value) => onChange({ target: { name, value } })
  const roadside = formData.locationType === 'Roadside'
  return <section className="request-details service-details" aria-labelledby="location-heading">
    <div className="detail-heading"><div><span className="detail-index">SERVICE LOCATION</span><h4 id="location-heading">I’ll meet you there.</h4></div></div>
    <fieldset className="location-types"><legend>Where is your vehicle?</legend>{[['Home', 'Driveway or garage'], ['Work', 'Office or parking lot'], ['Roadside', 'Road or nearby landmark']].map(([type, hint]) => <button type="button" key={type} className="location-choice" aria-pressed={formData.locationType === type} onClick={() => update('locationType', type)}><strong>{type}</strong><small>{hint}</small></button>)}</fieldset>
    <div className="address-fields"><div><label htmlFor="location">{roadside ? 'Road, exit or nearby address' : 'Service location'}</label><input id="location" name="location" autoComplete={roadside ? 'off' : 'street-address'} value={formData.location} onChange={onChange} placeholder={roadside ? 'e.g. I-93 North, near Exit 20, Boston' : 'Street address, city and state'} aria-invalid={!!errors.location} aria-describedby="location-help" /><p id="location-help" className="detail-help">{errors.location || (roadside ? 'Include direction of travel and a landmark so I can find you.' : 'Use the address where the vehicle will be parked.')}</p></div><div className="zip-field"><label htmlFor="serviceZip">ZIP</label><input id="serviceZip" name="serviceZip" value={formData.serviceZip || ''} onChange={onChange} autoComplete="postal-code" inputMode="numeric" placeholder="02149" maxLength={10} aria-invalid={!!errors.serviceZip} aria-describedby="serviceZip-help" /><p id="serviceZip-help" className="detail-help">{errors.serviceZip || 'Five digits, where I will meet you.'}</p></div></div>
    <div className="access-notes"><label htmlFor="locationNotes">Finding your vehicle <span className="optional">optional</span></label><input id="locationNotes" name="locationNotes" value={formData.locationNotes || ''} onChange={onChange} placeholder={roadside ? 'Vehicle color, mile marker or landmark' : 'Apartment, lot name, parking space or gate instructions'} /></div>
    <div className="date-section"><div><label htmlFor="date">Preferred date</label><input id="date" type="date" name="date" value={formData.date} onChange={onChange} min={dateOffset(MIN_LEAD_DAYS)} aria-invalid={!!errors.date} aria-describedby="date-help" /></div><div className="date-shortcuts">{[['In a week', MIN_LEAD_DAYS], ['In two weeks', MIN_LEAD_DAYS * 2]].map(([label, offset]) => <button type="button" className="date-choice" key={label} aria-pressed={formData.date === dateOffset(offset)} onClick={() => update('date', dateOffset(offset))}>{label}</button>)}</div><p id="date-help" className="detail-help">{errors.date || 'I need a week’s notice, so the earliest I can come is a week out. Your preferred date is a request; timing is confirmed separately.'}</p></div>
    <div className="contact-fields"><h5 id="contact-heading">Where do I send your quote?</h5>
      <div><label htmlFor="customerName">Name</label><input id="customerName" name="customerName" autoComplete="name" value={formData.customerName || ''} onChange={onChange} placeholder="Your name" aria-invalid={!!errors.customerName} aria-describedby="customerName-help" /><p id="customerName-help" className="detail-help">{errors.customerName || ''}</p></div>
      <div><label htmlFor="customerEmail">Email</label><input id="customerEmail" name="customerEmail" type="email" autoComplete="email" value={formData.customerEmail || ''} onChange={onChange} placeholder="you@example.com" aria-invalid={!!errors.customerEmail} aria-describedby="customerEmail-help" /><p id="customerEmail-help" className="detail-help">{errors.customerEmail || 'The quote is sent to this address.'}</p></div>
      <p className="detail-help detail-footnote">Your details go to Ken and nobody else. <a href="/privacy" target="_blank" rel="noopener">How KMT handles them</a></p>
      <div><label htmlFor="customerPhone">Mobile <span className="optional">optional</span></label><input id="customerPhone" name="customerPhone" type="tel" autoComplete="tel" value={formData.customerPhone || ''} onChange={onChange} placeholder="(617) 555-0100" /></div>
    </div>
  </section>
}
