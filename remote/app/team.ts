// The page an invitation to a team opens in a browser. The invitation is the part of the address
// after #, which never leaves the browser; all the page does with it is offer to copy the link.
import '@fontsource-variable/schibsted-grotesk'
import '@renderer/styles/tokens.css'
import './remote.css'
import { parseInvite } from '@shared/team'

const copy = document.getElementById('copy') as HTMLButtonElement | null
const none = document.getElementById('none')
const lede = document.getElementById('lede')

const COPY = 'Copy the link'
let back: ReturnType<typeof setTimeout> | undefined

/** Shows what fits the address: the way to copy an invitation, or that there is none in it. */
function show(): void {
  const invited = !!parseInvite(location.href)
  if (copy) {
    copy.hidden = !invited
    copy.textContent = COPY
  }
  if (lede) lede.hidden = !invited
  if (none) none.hidden = invited
}

copy?.addEventListener('click', () => {
  void navigator.clipboard.writeText(location.href).then(
    () => {
      copy.textContent = 'Copied. Paste it in Loom'
      clearTimeout(back)
      back = setTimeout(() => (copy.textContent = COPY), 4000)
    },
    () => {
      // No clipboard here: the address bar still has it.
      copy.textContent = 'Copy it from the address bar'
    }
  )
})

show()
// Another invitation pasted over this one in the address bar does not load the page again.
window.addEventListener('hashchange', show)

// "Skip to content" moves focus by script: the address after # is the invitation.
document.querySelector<HTMLAnchorElement>('.skip')?.addEventListener('click', (e) => {
  e.preventDefault()
  document.getElementById('main')?.focus()
})
