import { useContext } from 'react'
import { StaffAuthContext } from '../context/staffAuthContextValue'

export function useStaffAuth() {
  const context = useContext(StaffAuthContext)
  if (!context) {
    throw new Error('useStaffAuth must be used within a StaffAuthProvider')
  }
  return context
}