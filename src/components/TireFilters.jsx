import { facetCounts, availableSorts, activeFilterCount, toggleFilter, NO_FILTERS } from '../tire-filters.js'

/**
 * The narrowing controls above a size's tire list.
 *
 * Markup only -- every decision (what the facets are, what each count means,
 * whether rating is offered at all) lives in src/tire-filters.js, which is
 * where the tests drive it. Same split as inventory-grid.js / OwnerInventoryGrid.jsx.
 *
 * Two things here are deliberate and easy to undo by accident:
 *
 * A zero-count option is rendered DISABLED, never removed. Dropping it would
 * make the panel reflow as boxes are ticked and move a control out from under
 * the cursor mid-press.
 *
 * The rating sort appears only when some tire in THIS list carries one. The
 * feature is built and intentionally unpopulated -- there is no source for
 * ratings yet and inventing them was never on the table -- so it stays out of
 * sight rather than sorting nothing and teaching people it is broken.
 */
export default function TireFilters({ tires, filters = NO_FILTERS, sort = 'price', onFiltersChange, onSortChange, resultCount }) {
  const { seasons, brands, bands } = facetCounts(tires, filters)
  const sorts = availableSorts(tires)
  const active = activeFilterCount(filters)

  const group = (kind, options, legend) => options.length === 0 ? null : (
    <fieldset className="tire-facet">
      <legend>{legend}</legend>
      {options.map(option => {
        const checked = (filters[kind] ?? []).includes(option.id)
        const empty = option.count === 0 && !checked
        return (
          <label key={option.id} className={empty ? 'tire-facet-option is-empty' : 'tire-facet-option'}>
            <input
              type="checkbox"
              checked={checked}
              disabled={empty}
              onChange={() => onFiltersChange(toggleFilter(filters, kind, option.id))}
            />
            <span className="tire-facet-label">{option.label}</span>
            <span className="tire-facet-count">{option.count}</span>
          </label>
        )
      })}
    </fieldset>
  )

  return (
    <div className="tire-filters" data-active={active}>
      <div className="tire-filters-head">
        <p className="tire-filters-count" role="status">
          <strong>{resultCount}</strong> {resultCount === 1 ? 'tire' : 'tires'}
          {active > 0 && <> of {tires.length}</>}
        </p>
        {active > 0 && (
          <button type="button" className="tire-filters-clear" onClick={() => onFiltersChange({ ...NO_FILTERS })}>
            Clear {active === 1 ? 'filter' : 'filters'}
          </button>
        )}
      </div>

      <div className="tire-sorts" role="group" aria-label="Sort tires">
        <span className="tire-sorts-label">Sort</span>
        {sorts.map(option => (
          <button
            type="button"
            key={option.id}
            className={sort === option.id ? 'tire-sort selected' : 'tire-sort'}
            aria-pressed={sort === option.id}
            onClick={() => onSortChange(option.id)}
          >{option.label}</button>
        ))}
      </div>

      <div className="tire-facets">
        {group('seasons', seasons, 'Season')}
        {group('bands', bands, 'Price')}
        {group('brands', brands, 'Brand')}
      </div>
    </div>
  )
}
