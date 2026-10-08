import React from 'react'
import ReactDOM from 'react-dom/client'
/*
 * Imported before anything is rendered, on purpose. Importing this module is what attaches
 * the `beforeinstallprompt` listener, and it has to happen once, up front: the browser
 * decides when to offer the install prompt, which can be before any component mounts, so
 * capturing it later would miss the event that only ever fires a single time per page load.
 */
import './utils/pwaInstall'
import './index.css'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
