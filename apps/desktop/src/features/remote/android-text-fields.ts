import { isTextField } from '@/features/remote/keys';
import { IS_ANDROID } from '@/lib/platform';

/** Marks a field made read-only here, so only those are given back. */
const LOCKED = 'data-tv-locked';

function textField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  return (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    isTextField(target)
    ? target
    : null;
}

/**
 * Android TV: focusing a text field opens the on-screen keyboard, which then
 * takes the D-pad, so focus can't move past the field (the search box in the
 * header traps it). A field reached with the keys stays read-only, with no
 * keyboard, until OK is pressed on it; then it takes typing as usual. Leaving
 * it gives it back as it was.
 */
export function installTvTextFields(): void {
  if (!IS_ANDROID) return;
  /** The field OK was pressed on, refocused to open the keyboard. */
  let opening: HTMLElement | null = null;
  // After the navigation's own focusin, which marks focus from the keys.
  document.addEventListener('focusin', (event) => {
    const field = textField(event.target);
    if (!field || field === opening || field.readOnly || !field.hasAttribute('data-nav-focus'))
      return;
    field.readOnly = true;
    field.setAttribute(LOCKED, '');
  });
  document.addEventListener('focusout', (event) => {
    const field = textField(event.target);
    if (!field?.hasAttribute(LOCKED)) return;
    field.readOnly = false;
    field.removeAttribute(LOCKED);
  });
  window.addEventListener(
    'keydown',
    (event) => {
      const field = textField(event.target);
      if (event.key !== 'Enter' || !field?.hasAttribute(LOCKED)) return;
      event.preventDefault();
      field.readOnly = false;
      field.removeAttribute(LOCKED);
      // The keyboard opens for an editable field that is focused by the
      // user: focus it afresh, within this key press.
      opening = field;
      field.blur();
      field.focus();
      opening = null;
    },
    true,
  );
}
