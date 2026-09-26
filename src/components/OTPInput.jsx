import { useRef } from 'react'
import { OTP_LENGTH } from '../constants'

export default function OtpInput({ value = '', onChange, disabled = false, error = false }) {
  const refs = useRef([])
  const digits = value.split('')

  const commit = (next) => {
    onChange(next)
  }

  const focusIndex = (index) => {
    const el = refs.current[index]
    if (el) {
      el.focus()
      el.select()
    }
  }

  const handleChange = (index, raw) => {
    const digit = raw.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[index] = digit
    commit(next.join(''))
    if (digit && index < OTP_LENGTH - 1) focusIndex(index + 1)
  }

  const handleKeyDown = (index, event) => {
    if (event.key === 'Backspace') {
      event.preventDefault()
      if (!digits[index] && index > 0) {
        const next = [...digits]
        next[index - 1] = ''
        commit(next.join(''))
        focusIndex(index - 1)
      } else {
        const next = [...digits]
        next[index] = ''
        commit(next.join(''))
      }
    } else if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      focusIndex(index - 1)
    } else if (event.key === 'ArrowRight' && index < OTP_LENGTH - 1) {
      event.preventDefault()
      focusIndex(index + 1)
    }
  }

  const handlePaste = (index, event) => {
    event.preventDefault()
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (!pasted) return
    const next = [...digits]
    pasted.split('').forEach((char, i) => {
      const target = index + i
      if (target < OTP_LENGTH) next[target] = char
    })
    commit(next.join(''))
    focusIndex(Math.min(index + pasted.length, OTP_LENGTH - 1))
  }

  return (
    <div className="flex flex-wrap justify-center gap-2 sm:gap-3" role="group" aria-label="OTP input">
      {Array.from({ length: OTP_LENGTH }).map((_, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el
          }}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          className={`otp-auth-box ${digits[index] ? 'otp-auth-box-filled' : ''} ${error ? 'otp-auth-box-error' : ''}`}
          value={digits[index] || ''}
          disabled={disabled}
          aria-label={`Digit ${index + 1}`}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={(e) => handlePaste(index, e)}
        />
      ))}
    </div>
  )
}