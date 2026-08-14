import { useEffect, useState } from 'react'
import { useCountdown } from '../hooks/useCountdown'
import { OTP_VALIDITY_SECONDS } from '../constants'
import { FingerprintIcon, AlertIcon, ClockIcon } from './Icons'

const RADIUS = 52
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export default function OTPDisplay({
  otp,
  expiresAt,
  initialSeconds = OTP_VALIDITY_SECONDS,
  running = true,
  onExpire,
}) {
  const { secondsLeft, isExpired } = useCountdown(initialSeconds, { running, onExpire })
  const [ended, setEnded] = useState(false)
  const digits = typeof otp === 'string' ? otp.split('') : []
  const expiring = secondsLeft <= 5 && !ended
  const progress = Math.max(secondsLeft, 0) / initialSeconds
  const dashOffset = CIRCUMFERENCE * (1 - progress)

  useEffect(() => {
    setEnded(false)
  }, [otp])

  useEffect(() => {
    if (isExpired || !running) setEnded(true)
  }, [isExpired, running])

  return (
    <div className="otp-display p-3 md:p-4">
      <div className="otp-display-header">
        <FingerprintIcon size={16} />
        Attendance OTP
      </div>

      {ended ? (
        <div className="otp-expired-box bg-danger-soft border border-danger-subtle text-danger text-center p-3 md:p-4 rounded-2xl">
          <div className="flex items-center justify-center gap-2 font-bold text-3xl mb-1">
            <AlertIcon size={26} />
            OTP EXPIRED
          </div>
          <div className="text-sm opacity-75">This session has ended and is being finalized automatically.</div>
        </div>
      ) : (
        <>
          <div className="otp-digits" aria-label={`OTP ${otp}`}>
            {digits.map((digit, index) => (
              <span key={index} className="otp-digit">
                {digit}
              </span>
            ))}
          </div>

          <div className="otp-countdown">
            <div className="otp-countdown-label">Expires in</div>
            <div className={`countdown-ring${expiring ? ' expiring' : ''}`}>
              <svg viewBox="0 0 120 120" width="108" height="108" aria-hidden="true">
                <defs>
                  <linearGradient id="countdownGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#2563eb" />
                    <stop offset="100%" stopColor="#7c3aed" />
                  </linearGradient>
                </defs>
                <circle className="countdown-ring-track" cx="60" cy="60" r={RADIUS} />
                <circle
                  className="countdown-ring-progress"
                  cx="60"
                  cy="60"
                  r={RADIUS}
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={dashOffset}
                />
              </svg>
              <div
                className={`countdown-number${expiring ? ' expiring' : ''}`}
                key={secondsLeft}
                aria-live="polite"
              >
                {secondsLeft}
                <span className="countdown-unit">sec</span>
              </div>
            </div>
          </div>
        </>
      )}

      {!ended && expiresAt && (
        <div className="flex items-center justify-center gap-1 w-full mt-3 text-center text-muted-2 text-sm">
          <ClockIcon size={14} />
          Session expires at {new Date(expiresAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}