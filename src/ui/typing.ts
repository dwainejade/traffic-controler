/**
 * Input types you actually type into. A focused checkbox or slider is still an
 * `<input>`, but it has no use for the letter keys — treating those as typing
 * silently disables every keyboard shortcut for as long as the layers menu is
 * open, which is exactly when you want them.
 */
const TEXT_INPUT = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

/**
 * True while the keyboard belongs to a HUD field. Every global key handler
 * checks this first so typing a junction name never drives the camera.
 */
export function typing(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement) return TEXT_INPUT.has(el.type);
  return (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}
