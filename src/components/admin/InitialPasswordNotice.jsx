/**
 * The "your new accounts use password 1234" notice.
 *
 * Shown by the student and staff import modals. It is rendered in two places on
 * purpose: once above the form, so the admin knows the password before they commit
 * to an import, and again as part of the success panel, because that is the moment
 * they need to write it down and pass it on.
 *
 * The value comes from `INITIAL_PASSWORD` rather than the API response when the
 * request has not run yet, and from the response when it has, so the message
 * reflects what the server actually used.
 */
import { KeyIcon } from '../Icons'
import { INITIAL_PASSWORD } from '../../utils/initialPassword'

export default function InitialPasswordNotice({ password = INITIAL_PASSWORD, tone = 'info', className = '' }) {
  const tones = {
    info: 'border-blue-200 bg-blue-50 text-blue-900',
    success: 'border-amber-300 bg-amber-50 text-amber-900',
  }
  const styles = tones[tone] || tones.info

  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${styles} ${className}`}
    >
      <KeyIcon size={16} className="mt-0.5 shrink-0" />
      <p>
        Newly created accounts can sign in with the password{' '}
        <span className="font-bold tracking-wide">{password}</span>. Share it with the person, and
        ask them to change it after their first sign-in. The password is stored only as a
        one-way hash.
      </p>
    </div>
  )
}
