import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRightIcon, SearchIcon } from './Icons'

/*
 * A dropdown with the search field inside it.
 *
 * A native <select> cannot host an <input>, so the search either has to live
 * outside the control - which is what this replaced, and which reads as two
 * separate fields - or the control has to be built. This is that control: one
 * widget that shows the chosen value when closed and reveals a filter box plus
 * the option list when opened.
 *
 * Options are filtered in the browser against both the value and the label, so a
 * subject matches on its code and on its name, case-insensitively. The caller
 * passes the whole list once; typing never refetches anything.
 *
 * Keyboard behaviour follows the usual combobox conventions: the arrow keys move
 * the active option, Enter commits it, Escape closes without changing anything,
 * and focus stays in the search box while the list is open so the typed filter
 * survives a reopen.
 */
export default function SearchableSelect({
  label,
  name,
  value,
  options,
  onChange,
  placeholder = 'Select',
  disabled = false,
  icon,
  loading = false,
  loadingText = 'Loading options…',
  error = null,
  searchPlaceholder = 'Search…',
  emptyText = 'No matches found.',
}) {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const wrapRef = useRef(null)
  const searchRef = useRef(null)
  const activeOptionRef = useRef(null)
  const listId = `${name || label || 'searchable'}-listbox`

  const selected = options.find((option) => option.value === value) || null

  /*
   * Filtering runs against a deferred copy of the term. React renders the
   * deferred value at a lower priority, so on a long subject list the keystroke
   * that is typing the character is never blocked waiting for the list to be
   * re-filtered. The input stays the thing you are typing into at full speed and
   * the results catch up a frame later, which is what stops fast typing from
   * feeling sticky.
   */
  const deferredTerm = useDeferredValue(term)

  const visible = useMemo(() => {
    const query = deferredTerm.trim().toLowerCase()
    if (!query) return options
    return options.filter((option) =>
      `${option.value} ${option.label}`.toLowerCase().includes(query),
    )
  }, [options, deferredTerm])

  // A new query starts the highlight over, keyed off the deferred term so the
  // reset happens with the list the user is actually looking at.
  useEffect(() => {
    setActiveIndex(0)
  }, [deferredTerm])

  // The highlight is never allowed to point past the end of a list that has
  // since shrunk under filtering.
  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(visible.length - 1, 0)))
  }, [visible.length])

  // A control that becomes unavailable must not stay open with a stale list.
  useEffect(() => {
    if (disabled || loading) setOpen(false)
  }, [disabled, loading])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (open && searchRef.current) searchRef.current.focus()
  }, [open])

  /*
   * Arrow-key navigation must not walk the highlight out of sight in a scrolled
   * list. 'nearest' moves the container by the minimum amount needed, so a row
   * that is already visible does not jump, and it also leaves the horizontal and
   * outer-page scroll alone.
   */
  useEffect(() => {
    if (!open) return
    activeOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, deferredTerm])

  const choose = (option) => {
    onChange(option)
    setOpen(false)
  }

  const onSearchKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, visible.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = visible[activeIndex]
      if (option) choose(option)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className="cf-selectable">
      <label className="cf-form-label" htmlFor={name}>
        {icon && (
          <span aria-hidden="true" className="text-muted-2">
            {icon}
          </span>
        )}
        {label}
      </label>

      <button
        type="button"
        id={name}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="cf-select cf-selectable-trigger mt-1"
      >
        <span className={`cf-selectable-trigger-value${selected ? '' : ' text-muted-2'}`}>
          {selected ? selected.label : loading ? loadingText : placeholder}
        </span>
        <ChevronRightIcon
          size={16}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
      </button>

      {open && (
        <div className="cf-selectable-panel">
          {/*
            The icon and the left padding come from .cf-input-group-custom /
            .cf-input-icon, the same pairing the other search boxes use. A
            Tailwind padding utility here would lose the cascade against the
            .cf-input shorthand and the placeholder would run under the icon.
          */}
          <div className="cf-selectable-search">
            <div className="cf-input-group-custom">
              <span className="cf-input-icon" aria-hidden="true">
                <SearchIcon size={16} />
              </span>
              <input
                ref={searchRef}
                type="text"
                role="searchbox"
                aria-label={`Search ${label}`}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={
                  visible.length > 0 ? `${listId}-option-${activeIndex}` : undefined
                }
                className="cf-input"
                placeholder={searchPlaceholder}
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                onKeyDown={onSearchKeyDown}
                autoComplete="off"
                spellCheck="false"
              />
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="cf-selectable-empty">{emptyText}</p>
          ) : (
            <ul
              id={listId}
              role="listbox"
              aria-label={label}
              className="cf-selectable-list"
            >
              {visible.map((option, index) => {
                const isSelected = option.value === value
                const isActive = index === activeIndex
                return (
                  <li
                    key={`${option.value}`}
                    id={`${listId}-option-${index}`}
                    ref={isActive ? activeOptionRef : null}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option)}
                    className={`cf-selectable-option${isActive ? ' is-active' : ''}${
                      isSelected ? ' is-selected' : ''
                    }`}
                  >
                    {option.label}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {error && <div className="mt-2">{error}</div>}
    </div>
  )
}
