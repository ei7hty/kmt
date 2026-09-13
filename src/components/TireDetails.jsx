import { tireDetail } from '../tire-detail.js'
import { TEXT_HREF, TEXT_LABEL } from '../contact.js'

/**
 * The product detail for the tire a customer has chosen, opened in place.
 *
 * WHY IN PLACE AND NOT A PAGE. Measured in the browser on 2026-09-12: the
 * whole order wizard is component state inside CustomerRequest.jsx -- the
 * size, the filters, the revealed pages, the selection -- with nothing in the
 * URL. Pushing a route and coming back took step 2 with one tire selected and
 * twelve cards on screen to step 1, zero selected, zero cards, size selector
 * open. A /tire/:id route would do that on every back press, so a customer
 * comparing three tires in a 323-tire size would re-pick their size three
 * times. Making the route survivable means lifting the whole wizard into the
 * URL, which is a rewrite of a file four other lanes are inside.
 *
 * The other half of the argument is that there is not a page of content here.
 * What a customer's browser is allowed to know about a tire is a name, a
 * size, a price, a stock flag, a category, the supplier's spec string, a brand
 * and sometimes a photo. A dedicated page for that is a page that reads as
 * broken, and it costs a navigation away from the comparison that is the
 * actual job.
 *
 * WHY IT IS TIED TO THE SELECTION and has no toggle of its own. The card is a
 * single `<button>`, so nothing interactive can be nested inside it -- a
 * disclosure control would have to sit outside the card, one per row, which in
 * a 323-tire list is 323 extra tap targets standing between a customer and the
 * next tire. Choosing a tire is already one tap, already reversible, and is
 * already the moment the question "is this the right one?" is being asked. So
 * the chosen tire explains itself, exactly one panel is ever open, and reading
 * about a tire costs the same gesture as considering it.
 *
 * It renders as its own item of the `.tire-options` grid rather than inside
 * the card for the same nesting reason, and spans every column so it reads as
 * attached to the card above it at any width.
 *
 * NOTHING HERE DECIDES ANYTHING. Every sentence comes from src/tire-detail.js,
 * which is where the tests drive it, and each block is drawn only when that
 * module has something honest to put in it: no spec list until a decoded field
 * crosses the catalog boundary, no stars until a tire really carries a rating,
 * no season note for a category nobody has written an honest sentence for.
 */
export default function TireDetails({ tire, tires = [] }) {
  const { season, spec, standing, rating } = tireDetail(tire, tires)

  return (
    <section className="product-detail" aria-label={`About ${tire.name}`}>
      <p className="product-detail-kicker">{tire.name}</p>

      {season && (
        <div className="product-detail-block">
          <h5>Listed as {season.label}</h5>
          <p>{season.body}</p>
        </div>
      )}

      {spec.length > 0 && (
        <div className="product-detail-block">
          <h5>What the numbers mean</h5>
          <ul className="product-detail-points">
            {spec.map(point => <li key={point}>{point}</li>)}
          </ul>
        </div>
      )}

      {rating !== null && (
        <p className="product-detail-rating">
          Rated <b>{rating}</b> out of 5
        </p>
      )}

      {standing && <p className="product-detail-standing">{standing.text}</p>}

      {/* The customer chose their size off the sidewall three steps ago, and
          the flow says in as many words that vehicle details do not verify
          fitment. Nothing above may be read as a fitment check -- a load index
          in plain English reads exactly like one -- so the panel closes by
          saying who actually checks, which is the same person who confirms
          every job. */}
      <div className="product-detail-close">
        <p>Your size is what decides the fit. I confirm the tire and the final price before anything is charged.</p>
        <a className="product-detail-text" href={TEXT_HREF}>Not sure? {TEXT_LABEL}</a>
      </div>
    </section>
  )
}
