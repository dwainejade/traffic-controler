import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadSavedAreas } from './levels/registry.ts'

/*
 * Read the player's imported areas into the level list.
 *
 * Deliberately here and not in an effect: StrictMode would run it twice, and
 * the first paint must not wait on IndexedDB. The list starts as the levels
 * that ship and grows once this resolves, which is a few milliseconds later and
 * remounts nothing.
 */
void loadSavedAreas()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
