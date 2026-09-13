import { useState } from 'react'
import { facetCounts, availableSorts, activeFilterCount, toggleFilter, visibleFacet, priceRange, NO_FILTERS } from '../tire-filters.js'

/** The element the toggle says it controls; a fixed id, one panel per page. */
const BODY_ID = 'tire-filter-controls'

/** Same shape as the price on a card, so the range and the cards agree. */
const money = amount => `$${Number(amount).toFixed(2)}`

/**
 * The narrowing controls above a size's tire list.
 *
 * Markup only -- every decision (what the facets are, what each count means,
 * which brands are shown before "show all", whether rating is offered at all)
 * lives in src/tire-filters.js, which is where the tests drive it. Same split
 * as inventory-grid.js / OwnerInventoryGrid.jsx.
 *
 * Four things here are deliberate and easy to undo by accident:
 *
 * The panel COLLAPSES ON A PHONE and nowhere else. Expanded at 375px it is
 * about 950px of filters standing above the first tire -- more than a screen
 * of controls before any product. Which widths collapse is decided in the
 * stylesheet, not here; see the note on `open` below for why.
 *
 * A zero-count option is rendered DISABLED, never removed. Dropping it would
 * make the panel reflow as boxes are ticked and move a control out from under
 * the cursor mid-press.
 *
 * The brand facet is CAPPED. 225/50R17 carries 107 brands, and drawing all of
 * them made this panel 4,010px tall -- four and a half screens of checkboxes
 * standing between a customer and the first tire. See BRAND_FACET_LIMIT.
 *
 * The rating sort appears only when some tire in THIS list carries one. The
 * feature is built and intentionally unpopulated -- there is no source for
 * ratings yet and inventing them was never on the table -- so it stays out of
 * sight rather than sorting nothing and teaching people it is broken.
 */
export default function TireFilters({ tires, filters = NO_FILTERS, sort = 'price', onFiltersChange, onSortChange, results = [] }) {
  const [allBrands, setAllBrands] = useState(false)
  // Collapsed to start, and it only means anything on a phone: the toggle is
  // display:none and the body is open at every other width, so this state
  // cannot travel to a desktop and hide the panel there. That is a stylesheet
  // decision rather than a matchMedia listener on purpose -- a listener has a
  // first paint before it has an answer, and resizing mid-session would strand
  // someone with filters they cannot see.
  const [open, setOpen] = useState(false)
  const { seasons, brands, bands } = facetCounts(tires, filters)
  const sorts = availableSorts(tires)
  const active = activeFilterCount(filters)
  const brandView = visibleFacet(brands, { selected: filters?.brands ?? [], expanded: allBrands })
  const resultCount = results.length
  // The range of what is ON SCREEN, not of the size: filter to winter and the
  // line has to agree with the list under it or it is just decoration.
  const range = priceRange(results)

  const option = (kind, item) => {
    const checked = (filters[kind] ?? []).includes(item.id)
    const empty = item.count === 0 && !checked
    return (
      <label key={item.id} className={empty ? 'tire-facet-option is-empty' : 'tire-facet-option'}>
        <input
          type="checkbox"
          checked={checked}
          disabled={empty}
          onChange={() => onFiltersChange(toggleFilter(filters, kind, item.id))}
        />
        <span className="tire-facet-label">{item.label}</span>
        <span className="tire-facet-count">{item.count}</span>
      </label>
    )
  }

  const group = (kind, options, legend, footer = null) => options.length === 0 ? null : (
    <fieldset className="tire-facet">
      <legend>{legend}</legend>
      {options.map(item => option(kind, item))}
      {footer}
    </fieldset>
  )

  const brandFooter = (brandView.hidden.length > 0 || allBrands) && (
    <button
      type="button"
      className="tire-facet-more"
      aria-expanded={allBrands}
      onClick={() => setAllBrands(shown => !shown)}
    >{allBrands ? 'Show fewer brands' : `Show all ${brandView.shown.length + brandView.hidden.length} brands`}</button>
  )

  return (
    <div className="tire-filters" data-active={active}>
      <div className="tire-filters-head">
        <p className="tire-filters-count" role="status">
          <strong>{resultCount}</strong> {resultCount === 1 ? 'tire' : 'tires'}
          {active > 0 && <> of {tires.length}</>}
          {range && <span className="tire-filters-range">
            {range.low === range.high ? money(range.low) : <>{money(range.low)} &ndash; {money(range.high)}</>} per tire
          </span>}
        </p>
        {active > 0 && (
          <button type="button" className="tire-filters-clear" onClick={() => onFiltersChange({ ...NO_FILTERS })}>
            Clear {active === 1 ? 'filter' : 'filters'}
          </button>
        )}
      </div>

      <button
        type="button"
        className="tire-filters-toggle"
        aria-expanded={open}
        aria-controls={BODY_ID}
        onClick={() => setOpen(shown => !shown)}
      >
        <span>Filter &amp; sort</span>
        {active > 0 && <span className="tire-filters-badge">{active}</span>}
        <span className="tire-filters-caret" aria-hidden="true" />
      </button>

      <div className="tire-filters-body" id={BODY_ID} data-open={open ? 'true' : 'false'}>
        <div className="tire-sorts" role="group" aria-label="Sort tires">
          <span className="tire-sorts-label">Sort</span>
          {sorts.map(item => (
            <button
              type="button"
              key={item.id}
              className={sort === item.id ? 'tire-sort selected' : 'tire-sort'}
              aria-pressed={sort === item.id}
              onClick={() => onSortChange(item.id)}
            >{item.label}</button>
          ))}
        </div>

        <div className="tire-facets">
          {group('seasons', seasons, 'Season')}
          {group('bands', bands, 'Price')}
          {group('brands', brandView.shown, 'Brand', brandFooter)}
        </div>
      </div>
    </div>
  )
}
