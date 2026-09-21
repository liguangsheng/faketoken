/**
 * DOM driver.
 *
 * The lowest layer of the console: it knows about elements and events and
 * nothing about the application. Everything above builds its markup through
 * `el`, so no other module ever concatenates HTML strings — which is also what
 * keeps server-supplied text (channel names, error bodies) from being parsed
 * as markup.
 */

/** Attribute names that are not properties, or whose property name differs. */
const ATTRIBUTE_ONLY = new Set(['for', 'role', 'colspan', 'rowspan', 'list'])

/**
 * Creates an element.
 *
 *   el('button', { class: 'btn', onclick: run }, '刷新')
 *   el('div', { class: 'row' }, [left, right])
 *
 * Values that are null, undefined or false are skipped, so a caller can write
 * `condition && node` inline without guarding every branch.
 */
export function el(tag, props = null, children = null) {
  const node = document.createElement(tag)

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue

      if (key === 'class') node.className = value
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value)
      } else if (key.startsWith('aria-') || ATTRIBUTE_ONLY.has(key)) {
        node.setAttribute(key, value === true ? '' : String(value))
      } else if (key in node) node[key] = value
      else node.setAttribute(key, String(value))
    }
  }

  append(node, children)
  return node
}

/** Appends a child, a list of children, or text. Ignores empty values. */
export function append(parent, children) {
  if (children === null || children === undefined || children === false) return parent

  if (Array.isArray(children)) {
    for (const child of children) append(parent, child)
    return parent
  }

  parent.append(children instanceof Node ? children : document.createTextNode(String(children)))
  return parent
}

/** A detached fragment, for building a list before it touches the document. */
export function frag(children) {
  return append(document.createDocumentFragment(), children)
}

/** Replaces everything inside a node in one shot. */
export function replace(parent, children) {
  parent.replaceChildren()
  return append(parent, children)
}

/** Shorthand for a text node wrapped in a tag. */
export const text = (tag, className, value) => el(tag, { class: className }, value)

/** Adds a listener and returns the function that removes it. */
export function on(target, event, handler, options) {
  target.addEventListener(event, handler, options)
  return () => target.removeEventListener(event, handler, options)
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Ant Design draws on a 1024 grid, inset by 64 on every side. */
const DEFAULT_ICON_BOX = '64 64 896 896'

/**
 * Inline SVG icon.
 *
 * `glyph` is an entry from ui/icons.js: { paths, box? }. The glyphs are
 * filled shapes on Ant Design's grid, so the element is filled with the
 * current text colour and carries no stroke — which is what lets one glyph
 * follow whatever colour its button or tag has.
 */
export function icon(glyph, { size = 16 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', glyph.box ?? DEFAULT_ICON_BOX)
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'currentColor')
  svg.classList.add('icon')

  for (const d of glyph.paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** Matches a media query and reports changes until the returned stop is called. */
export function watchMedia(query, onChange) {
  const media = window.matchMedia(query)
  const listener = (event) => onChange(event.matches)
  media.addEventListener('change', listener)
  return { matches: () => media.matches, stop: () => media.removeEventListener('change', listener) }
}
