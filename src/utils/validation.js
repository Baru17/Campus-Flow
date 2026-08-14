import { OTP_LENGTH } from '../constants'

export const DIGITS_ONLY = /^\d+$/

export const ALPHANUMERIC = /^[A-Za-z0-9]+$/

export function isValidOTP(value) {
  return typeof value === 'string' && DIGITS_ONLY.test(value) && value.length === OTP_LENGTH
}

export function isCompleteOTP(value) {
  return typeof value === 'string' && DIGITS_ONLY.test(value)
}

export function isValidStudentId(value) {
  return (
    typeof value === 'string' &&
    value.trim().length >= 4 &&
    value.trim().length <= 20 &&
    ALPHANUMERIC.test(value.trim())
  )
}

export function normalizeStudentId(value) {
  return value.trim().toUpperCase()
}
