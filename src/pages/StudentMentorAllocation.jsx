import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import DashboardHero from '../components/DashboardHero'
import StatusMessage from '../components/StatusMessage'
import SearchableSelect from '../components/SearchableSelect'
import { assignMentor, fetchEligibleMentors } from '../api/odApi'
import { useAuth } from '../hooks/useAuth'
import {
  AlertIcon,
  CheckIcon,
  ChevronLeftIcon,
  InfoIcon,
  UsersIcon,
} from '../components/Icons'

/*
 * Choosing the staff member who will review this student's on-duty requests.
 *
 * The list is whatever `/api/student/mentors` returned, and that route has already
 * narrowed it to the student's own department using the department on their student
 * row. This page does not filter by department, and cannot be made to: there is no
 * department control here to widen the list with. An IT student sees IT staff because
 * the server decided that, not because the browser asked nicely.
 *
 * Only `staff_id` is ever sent. The address that ends up on the student's record is
 * the one on the `staff` row for that id, read by the server -- so a student cannot
 * store an address of their choosing against a colleague's name.
 *
 * Changing an existing mentor is a deliberate act rather than a side effect of picking
 * a different option: the server refuses to overwrite one without `confirmChange`, and
 * this form asks first. That is why the selection is a separate control from the
 * confirm button -- choosing something is not the same as agreeing to lose what is
 * already there.
 */
export default function StudentMentorAllocation() {
  const navigate = useNavigate()
  const { logout, student: authStudent, loading: authLoading } = useAuth()

  const [mentors, setMentors] = useState([])
  const [currentMentorEmail, setCurrentMentorEmail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [selectedStaffId, setSelectedStaffId] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [pendingConfirmation, setPendingConfirmation] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await fetchEligibleMentors()
      setMentors(data.mentors || [])
      setCurrentMentorEmail(data.current_mentor_email || null)
    } catch (err) {
      setLoadError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  /*
   * The third student page that was firing an authenticated request before the session had
   * settled. `/api/student/mentors` is behind the same `requireAuth, requireStudent` gate
   * as `/api/student/me`, so it gets the same treatment: wait for `AuthProvider`, redirect
   * a genuinely signed-out visitor, and only then ask.
   */
  useEffect(() => {
    if (authLoading) return
    if (!authStudent) {
      navigate('/role-selection', { replace: true })
      return
    }
    load()
  }, [authLoading, authStudent, load, navigate])

  const options = useMemo(
    () =>
      mentors.map((mentor) => ({
        value: mentor.staff_id,
        label: `${mentor.staff_name} · ${mentor.email}`,
      })),
    [mentors]
  )

  const currentMentor = useMemo(
    () => mentors.find((mentor) => mentor.email === currentMentorEmail) || null,
    [mentors, currentMentorEmail]
  )

  const chosen = useMemo(
    () => mentors.find((mentor) => mentor.staff_id === selectedStaffId) || null,
    [mentors, selectedStaffId]
  )

  /*
   * True only when the choice would actually change something. Re-confirming the
   * mentor the student already has is not a change, and should not be described as
   * one in a dialog.
   */
  const isChanging =
    Boolean(chosen) && Boolean(currentMentorEmail) && chosen.email !== currentMentorEmail

  const handleConfirm = async (confirmChange) => {
    if (!chosen || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await assignMentor(chosen.staff_id, { confirmChange })
      setPendingConfirmation(false)
      setSelectedStaffId('')
      setCurrentMentorEmail(result.mentor_email)
      await load()
      /*
       * The assignment is stored whether or not the mail went. The server says which
       * happened, and the difference is worth repeating here rather than letting a
       * failed notification look like a failed assignment.
       */
      setNotice(
        result.notification_sent
          ? `${result.mentor.staff_name} is now your mentor. They have been notified.`
          : `${result.mentor.staff_name} is now your mentor, but the mentor notification could not be sent.`
      )
    } catch (err) {
      setSaveError(err)
      setPendingConfirmation(false)
    } finally {
      setSaving(false)
    }
  }

  const handleLogout = async () => {
    await logout()
    navigate('/role-selection', { replace: true })
  }

  return (
    <div className="app-shell">
      <Navbar title="Allocate Mentor" subtitle="Campus-Flow" onLogout={handleLogout} />
      <main className="container-cf py-4 lg:py-5">
        <button
          type="button"
          onClick={() => navigate('/student/entry')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-blue-600"
        >
          <ChevronLeftIcon size={16} />
          Back
        </button>

        <DashboardHero
          icon={<UsersIcon size={26} />}
          title="Allocate Mentor"
          subtitle="Your mentor reviews your on-duty requests before they go any further."
        />

        {loadError && <StatusMessage variant="danger">{loadError}</StatusMessage>}

        {notice && (
          <StatusMessage variant="success" dismissible onDismiss={() => setNotice(null)}>
            {notice}
          </StatusMessage>
        )}

        {/*
          Centred by the wrapper itself, not by a grid.

          This was `grid grid-cols-12` + `col-span-8` + `justify-items-center`, on the
          reasoning that `justify-items` would centre the card "within the twelve columns".
          Measured in a browser at 1440x1000, it did not: the card's centre sat at 483px
          against a container centre of 720px, a 237px offset, with 16px of space on the
          left and 489px on the right.

          The cause is that `justify-items` aligns an item within *its own grid area*, and
          the grid area of a `col-span-8` item is columns 1-8. Twelve equal tracks already
          fill the row, so `justify-content` had no free space to distribute either. Either
          way the card is anchored to the left of the container, and neither property can
          move it, because both act on the tracks or the area rather than on the container.

          It only looked right on a narrow screen because below `lg` the card is
          `col-span-12`, fills the row, and padding makes the edges look even. The
          measurement is what caught it; the mobile layout hid it.

          So the centring is the wrapper's own job: a `max-w` and `mx-auto` constrain the
          card and centre it in the container, with no grid and no column count to keep in
          step with it. `max-w-2xl` is also very close to the ~631px the card used to
          occupy, so the layout reads the same and is now actually centred.
        */}
        <div className="page-enter mt-4 mx-auto w-full max-w-2xl">
          <div className="cf-card cf-card-hover p-3 md:p-4">
            <div className="cf-card-header">
              <div>
                <h2 className="section-title">Your mentor</h2>
                <p className="text-muted-2 text-sm mb-0">
                  {loading
                    ? 'Loading your options…'
                    : 'Choose from the staff in your own department.'}
                </p>
              </div>
              <span className="cf-icon-badge violet">
                <UsersIcon size={22} />
              </span>
            </div>

            {currentMentor && (
              <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <div className="flex items-center gap-2 font-bold">
                  <CheckIcon size={16} />
                  Current mentor
                </div>
                <p className="mt-1">
                  {currentMentor.staff_name} · {currentMentor.email}
                </p>
              </div>
            )}

            {!loading && !currentMentor && (
              <div
                role="status"
                className="mt-3 flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-900"
              >
                <InfoIcon size={16} className="mt-0.5 shrink-0" />
                You have not allocated a mentor yet. Pick one below.
              </div>
            )}

            <div className="mt-4">
              <SearchableSelect
                label="Search mentors"
                name="mentor"
                value={selectedStaffId}
                options={options}
                onChange={(option) => {
                  setSelectedStaffId(option.value)
                  setSaveError(null)
                }}
                placeholder={loading ? 'Loading mentors…' : 'Select a mentor'}
                loading={loading}
                searchPlaceholder="Search by name or email…"
                emptyText="No mentors match your search."
                icon={<UsersIcon size={14} />}
              />
            </div>

            {chosen && (
              <p className="mt-3 text-xs text-slate-500">
                {isChanging
                  ? `This will replace ${currentMentor?.staff_name || 'your current mentor'}.`
                  : 'Confirm to allocate this mentor.'}
              </p>
            )}

            {saveError && (
              <div className="mt-3">
                <StatusMessage variant="danger">{saveError.message}</StatusMessage>
              </div>
            )}

            <div className="mt-4">
              <button
                type="button"
                /*
                 * Replacing a mentor opens the confirmation panel rather than saving
                 * straight away. `handleConfirm(false)` would be refused by the
                 * server anyway -- that is the point of it being refused -- so the
                 * question is asked here rather than answered with an error.
                 */
                onClick={() => (isChanging ? setPendingConfirmation(true) : handleConfirm(false))}
                disabled={!chosen || saving}
                className="btn-cf-primary inline-flex w-full items-center justify-center gap-2 px-4 py-2 text-sm"
              >
                {saving && <span className="cf-spinner" role="status" aria-hidden="true" />}
                {saving
                  ? 'Saving…'
                  : isChanging
                    ? 'Change mentor'
                    : currentMentorEmail
                      ? 'Keep this mentor'
                      : 'Allocate mentor'}
              </button>
            </div>
          </div>

          {/*
            The confirmation is a real gate rather than a `window.confirm`, because
            a native dialog gives no room to say who is being replaced and why that
            matters: an OD request already filed keeps pointing at the old mentor, so
            this is not a retraction of anything they have approved.
          */}
          {pendingConfirmation && chosen && (
            <div
              className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              role="alert"
            >
              <div className="flex items-start gap-2 font-bold">
                <AlertIcon size={16} className="mt-0.5 shrink-0" />
                Change your mentor to {chosen.staff_name}?
              </div>
              <p className="mt-1">
                Requests you have already submitted keep their original mentor. Only future
                requests will go to {chosen.staff_name}.
              </p>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingConfirmation(false)}
                  className="btn-cf-outline px-3 py-1.5 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleConfirm(true)}
                  disabled={saving}
                  className="btn-cf-primary px-3 py-1.5 text-sm"
                >
                  Yes, change mentor
                </button>
              </div>
            </div>
          )}
          </div>
      </main>
    </div>
  )
}