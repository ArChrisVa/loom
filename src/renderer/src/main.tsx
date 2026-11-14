import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Popout } from './Popout'
import { POPOUT_TAB } from './store'
import { installTooltips } from './lib/tooltips'
import '@fontsource-variable/schibsted-grotesk'
import './styles/base.css'
import './styles/shell.css'
import './styles/chat.css'
import './styles/panels.css'
import './styles/hljs.css'

// Before anything is drawn: every title set from here on shows in Loom's own tooltip.
installTooltips()

createRoot(document.getElementById('root')!).render(POPOUT_TAB ? <Popout /> : <App />)
