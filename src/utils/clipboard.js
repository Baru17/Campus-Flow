/*
 * Clipboard helper.
 *
 * The Class Advisor dashboard writes its report straight through
 * `navigator.clipboard.writeText`. That is the right first choice, but it is only
 * defined in a secure context and can reject (permission denied, document not
 * focused, older mobile browsers), so this wraps it and falls back to the classic
 * hidden-textarea trick before giving up. Callers get a resolved promise on success
 * and a thrown Error on failure, so they never report "copied" when nothing was
 * copied.
 */
export async function copyTextToClipboard(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('There is nothing to copy.')
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy path rather than failing outright.
    }
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    throw new Error('Clipboard access is not available in this browser.')
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  try {
    textarea.select()
    const copied = document.execCommand('copy')
    if (!copied) throw new Error('The browser rejected the copy request.')
    return true
  } finally {
    document.body.removeChild(textarea)
  }
}
