/*
 * Runs before first paint as the first child of <head>, so a stored override never flashes the wrong theme
 * (design-system §8.3). It also marks Apple platforms, where the font stack resolves to SF Pro, which takes
 * its own tracking. Storage can throw (private mode, blocked site data); the page then follows the system
 * theme, which is the default. A Content Security Policy would need a nonce or hash for this script.
 */
const THEME_SCRIPT = `var d=document.documentElement;if(/Mac|iPhone|iPad|iPod/.test(navigator.platform))d.dataset.font="sf";try{var t=localStorage.getItem("fd-theme");if(t==="light"||t==="dark")d.dataset.theme=t}catch(e){}`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
