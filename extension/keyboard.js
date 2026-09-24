(() => {
  if (globalThis.__cosenseKeyboardGuard) return;
  globalThis.__cosenseKeyboardGuard = true;
  // Register before site shortcuts. Shadow DOM retargets input events to the host,
  // so the site's usual input/textarea exclusion does not protect our fields.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, event => {
      if (event.composedPath().some(node => node.localName === 'cosense-clip')) {
        event.stopImmediatePropagation();
        // Keep native typing, IME, Tab, Escape and clipboard shortcuts working.
      }
    }, true);
  }
})();
