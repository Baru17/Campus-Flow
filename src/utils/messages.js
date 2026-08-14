import { ApiError } from '../api/attendanceApi'

export function notConfiguredMessage() {
  return {
    variant: 'warning',
    text: 'The attendance backend is not configured yet. Please add the Supabase project URL and anon key to your .env file.',
  }
}

export function generateOtpErrorMessage(error) {
  if (error instanceof ApiError && error.code === 'not-configured') return notConfiguredMessage()
  switch (error?.message) {
    case 'Missing required fields':
      return { variant: 'danger', text: 'Please fill in all the session details before generating an OTP.' }
    case 'Failed to create attendance session':
      return { variant: 'danger', text: 'Could not start the attendance session. Please try again.' }
    case 'Internal server error':
      return { variant: 'danger', text: 'Something went wrong. Please try again.' }
    default:
      return { variant: 'danger', text: 'Unable to start the attendance session. Please try again.' }
  }
}

export function verifyOtpErrorMessage(error) {
  if (error instanceof ApiError && error.code === 'not-configured') return notConfiguredMessage()
  switch (error?.message) {
    case 'Student not found':
      return { variant: 'warning', text: 'Student not found. Check your student ID and try again.' }
    case 'No active attendance session':
      return {
        variant: 'warning',
        text: 'No active attendance session is running right now. Please wait for your staff member to generate a new OTP.',
      }
    case 'Invalid OTP':
      return { variant: 'danger', text: 'Invalid OTP. Check the code and try again.' }
    case 'Invalid or expired OTP':
      return {
        variant: 'danger',
        text: 'This OTP is invalid or has expired. If the OTP is still showing on screen, check the digits and try again. Otherwise, please wait for a new OTP.',
      }
    case 'Attendance already marked':
      return {
        variant: 'info',
        text: 'Attendance already marked. Your attendance has already been recorded for this session.',
      }
    default:
      return { variant: 'danger', text: 'Unable to verify the OTP. Please try again.' }
  }
}
