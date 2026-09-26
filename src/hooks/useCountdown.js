import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Counts down from `initialSeconds`. Purely for user experience — the
 * backend is always the authority on OTP validity/expiry.
 */
export function useCountdown(initialSeconds, { running = true, onExpire } = {}) {
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds)
  const expiredFiredRef = useRef(false)
  const onExpireRef = useRef(onExpire)

  onExpireRef.current = onExpire

  useEffect(() => {
    setSecondsLeft(initialSeconds)
    expiredFiredRef.current = false
  }, [initialSeconds, running])

  useEffect(() => {
    if (!running) return undefined
    const id = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [running])

  const isExpired = running && secondsLeft === 0

  useEffect(() => {
    if (isExpired && !expiredFiredRef.current) {
      expiredFiredRef.current = true
      onExpireRef.current?.()
    }
  }, [isExpired])

  const reset = useCallback(() => {
    setSecondsLeft(initialSeconds)
    expiredFiredRef.current = false
  }, [initialSeconds])

  return { secondsLeft, isExpired, reset }
}
