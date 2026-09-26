import { useEffect, useState } from 'react'
import { useCountdown } from '../hooks/useCountdown'
import { OTP_VALIDITY_SECONDS } from '../constants'

export default function CountdownTimer({
  initialSeconds = OTP_VALIDITY_SECONDS,
  running = true,
  onExpire,
  label,
}) {
  const { secondsLeft, isExpired } = useCountdown(initialSeconds, { running, onExpire })
  const [ended, setEnded] = useState(false)

  useEffect(() => {
    if (isExpired || !running) setEnded(true)
  }, [isExpired, running])

  return (
    <div className="text-center">
      {label && <div className="text-muted-2 text-sm uppercase font-semibold mb-1">{label}</div>}
      {ended ? (
        <div className="countdown-number text-danger" aria-live="polite">
          OTP EXPIRED
        </div>
      ) : (
        <div className="countdown-number" key={secondsLeft} aria-live="polite">
          {secondsLeft}
        </div>
      )}
    </div>
  )
}
