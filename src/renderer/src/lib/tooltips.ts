// Tooltips in Loom's own look. Everything in the app says what it is with a `title`; left alone,
// Windows draws those as its own pale boxes. Here a `title` never reaches the page: it is kept on
// the element as `data-tip`, and one tooltip of Loom's shows it, after a moment's rest of the
// pointer or when the keyboard lands on the element.
//
// A `title` also names a control for a screen reader, or describes it. That is kept: a control
// with no other name gets the text as its `aria-label`, anything else as its `aria-description`.

const SHOW_AFTER = 500
/** Moving from one tooltip to the next, there is no second wait */
const WARM_FOR = 400
const WARM_AFTER = 90
const HIDE_AFTER = 120

const setAttribute = Element.prototype.setAttribute
const removeAttribute = Element.prototype.removeAttribute
const getAttribute = Element.prototype.getAttribute

let tip: HTMLDivElement | null = null
/** The element whose tooltip is showing */
let shownFor: HTMLElement | null = null
/** The element the pointer or the keyboard is on, whether or not its tooltip is up yet */
let over: HTMLElement | null = null
let showTimer = 0
let hideTimer = 0
let hiddenAt = 0

const toName = new Set<HTMLElement>()
let naming = false

/** What `title` did for a screen reader: the name of a control that has no other, else its description. */
function nameAll(): void {
  naming = false
  for (const el of toName) {
    const text = getAttribute.call(el, 'data-tip')
    if (!text || !el.isConnected) continue
    const mine = getAttribute.call(el, 'data-tip-aria')
    const named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')
    const words = (el.textContent ?? '').trim()
    if (mine === 'label' || (!mine && !named && !words && !el.querySelector('img[alt]'))) {
      setAttribute.call(el, 'aria-label', text)
      setAttribute.call(el, 'data-tip-aria', 'label')
    } else if (mine === 'description' || (!mine && !el.hasAttribute('aria-description') && !el.hasAttribute('aria-describedby'))) {
      // Said once: a description that repeats the name would be read twice.
      if (text === words || text === getAttribute.call(el, 'aria-label')) removeAttribute.call(el, 'aria-description')
      else setAttribute.call(el, 'aria-description', text)
      setAttribute.call(el, 'data-tip-aria', 'description')
    }
  }
  toName.clear()
}

function put(el: HTMLElement, text: string): void {
  if (!text) return drop(el)
  setAttribute.call(el, 'data-tip', text)
  if (el === shownFor && tip) tip.textContent = text
  toName.add(el)
  // After the page has finished changing: whether the element has words of its own is known then.
  if (!naming) {
    naming = true
    queueMicrotask(nameAll)
  }
}

function drop(el: HTMLElement): void {
  const mine = getAttribute.call(el, 'data-tip-aria')
  if (mine === 'label') removeAttribute.call(el, 'aria-label')
  if (mine === 'description') removeAttribute.call(el, 'aria-description')
  removeAttribute.call(el, 'data-tip-aria')
  removeAttribute.call(el, 'data-tip')
  if (el === shownFor) hide()
}

/** `title` is kept as `data-tip` from the moment it is set, so the system's tooltip has nothing to show. */
function takeOverTitles(): void {
  Element.prototype.setAttribute = function (this: Element, name: string, value: string): void {
    if (name === 'title' && this instanceof HTMLElement) return put(this, String(value))
    // A name or a description given by the app itself wins over the one made from the tooltip.
    if ((name === 'aria-label' || name === 'aria-description') && this.hasAttribute('data-tip-aria')) removeAttribute.call(this, 'data-tip-aria')
    setAttribute.call(this, name, value)
  }
  Element.prototype.removeAttribute = function (this: Element, name: string): void {
    if (name === 'title' && this instanceof HTMLElement) return drop(this)
    removeAttribute.call(this, name)
  }
  Element.prototype.getAttribute = function (this: Element, name: string): string | null {
    return getAttribute.call(this, name === 'title' && this instanceof HTMLElement ? 'data-tip' : name)
  }
  Object.defineProperty(HTMLElement.prototype, 'title', {
    configurable: true,
    get(this: HTMLElement): string {
      return getAttribute.call(this, 'data-tip') ?? ''
    },
    set(this: HTMLElement, value: string) {
      put(this, String(value ?? ''))
    }
  })
}

/** The element with a tooltip that something is in. One written into the page as HTML still has a real `title`: taken now. */
function tipOwner(target: EventTarget | null): HTMLElement | null {
  const el = (target as Element | null)?.closest?.('[data-tip], [title]') as HTMLElement | null
  if (!el) return null
  const real = getAttribute.call(el, 'title')
  if (real != null) {
    removeAttribute.call(el, 'title')
    if (real) put(el, real)
  }
  return el.hasAttribute('data-tip') ? el : null
}

function hide(): void {
  window.clearTimeout(showTimer)
  window.clearTimeout(hideTimer)
  if (!shownFor || !tip) return
  shownFor = null
  hiddenAt = Date.now()
  try {
    tip.hidePopover()
  } catch {
    // already closed
  }
}

function show(el: HTMLElement): void {
  const text = getAttribute.call(el, 'data-tip')
  if (!tip || !text || !el.isConnected || over !== el) return
  if (shownFor) {
    try {
      tip.hidePopover()
    } catch {
      // already closed
    }
  }
  tip.textContent = text
  // Coming straight from another tooltip: no entrance, it is simply there.
  tip.toggleAttribute('data-warm', Date.now() - hiddenAt < WARM_FOR)
  try {
    // The element it is for becomes its anchor: the stylesheet places it under (or over) that.
    ;(tip as unknown as { showPopover: (o: { source: HTMLElement }) => void }).showPopover({ source: el })
    shownFor = el
  } catch {
    shownFor = null
  }
}

function rest(el: HTMLElement | null): void {
  if (el === over) return
  over = el
  window.clearTimeout(showTimer)
  window.clearTimeout(hideTimer)
  if (!el) {
    // A moment's grace, so the pointer can cross onto the tooltip itself to read it.
    if (shownFor) hideTimer = window.setTimeout(hide, HIDE_AFTER)
    return
  }
  const warm = !!shownFor || Date.now() - hiddenAt < WARM_FOR
  if (shownFor && shownFor !== el) hide()
  showTimer = window.setTimeout(() => show(el), warm ? WARM_AFTER : SHOW_AFTER)
}

/** Call once, before the app draws anything. */
export function installTooltips(): void {
  if (tip) return
  takeOverTitles()
  tip = document.createElement('div')
  tip.className = 'tip'
  tip.setAttribute('popover', 'hint')
  tip.setAttribute('role', 'tooltip')
  document.body.append(tip)

  document.addEventListener(
    'mouseover',
    (e) => {
      // On the tooltip itself: it stays while it is being read.
      if (tip!.contains(e.target as Node)) {
        window.clearTimeout(hideTimer)
        return
      }
      rest(tipOwner(e.target))
    },
    true
  )
  document.documentElement.addEventListener('mouseleave', () => rest(null))
  // Doing something puts it away: a press, a key, a scroll, a drag, leaving the window.
  const away = (): void => {
    window.clearTimeout(showTimer)
    hide()
  }
  for (const name of ['mousedown', 'keydown', 'wheel', 'dragstart'] as const) document.addEventListener(name, away, true)
  document.addEventListener('scroll', away, true)
  window.addEventListener('blur', away)
  // With the keyboard: the control it lands on says what it is.
  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement
    if (!el.matches?.(':focus-visible') || el.matches('input, textarea, select, [contenteditable="true"]')) return
    const owner = tipOwner(el)
    if (owner === el) rest(el)
  })
  document.addEventListener('focusout', () => rest(null))
}
