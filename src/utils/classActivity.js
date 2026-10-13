/*
 * How the class-activity card should present one response.
 *
 * These are decisions, not values, so they live here rather than inline in the card.
 * The card is the only caller, but the reason for extracting them is testability: there
 * is no DOM test runner in this project, and the alternative -- asserting on the
 * component's source text -- would pass on a string that happened to be present
 * somewhere unreachable and fail on a correct refactor.
 *
 * The rule the card has to follow is that it may only make a claim the counts support.
 * "0 / 0" and "everyone is signed in" are both true in the empty class, and both are
 * actively misleading: the first cannot be told apart from a roster that failed to
 * load, and the second is a reassurance about a class that does not exist. So both are
 * gated here, once, and the card renders what it is told.
 */

/**
 * @param {{activeStudents: number, totalStudents: number, missing: Array<{register_no: string, student_name: string}>, missingTruncated: boolean} | null} activity
 *   The response, or `null` before the server has answered.
 */
export function describeClassActivity(activity) {
  const hasActivity = activity !== null && activity !== undefined

  if (!hasActivity) {
    return {
      hasActivity: false,
      activeStudents: null,
      totalStudents: null,
      missing: [],
      missingCount: 0,
      isEmptyClass: false,
      allPresent: false,
      ratio: null,
      showMissingControl: false,
    }
  }

  const { activeStudents, totalStudents } = activity
  const missing = Array.isArray(activity.missing) ? activity.missing : []

  /*
   * A negative or non-integer total cannot come from the server -- it is validated
   * before it is ever sent -- but treating it as "not empty" keeps a malformed value
   * from taking the card down to an empty branch that claims there is nobody here.
   */
  const total = Number.isFinite(totalStudents) && totalStudents > 0 ? totalStudents : 0
  const active = Number.isFinite(activeStudents) ? activeStudents : 0

  const isEmptyClass = total === 0

  /*
   * "Everyone is signed in" is asserted, not inferred from an empty list.
   *
   * The server already guarantees `active + missing = total`, so an empty list over a
   * non-empty class does imply a full house -- but only while that guarantee holds.
   * Checking `active === total` directly means the sentence still cannot be printed
   * over a roster the card has not actually accounted for, which is the case that
   * matters: a staff member told everyone is present will not go and check.
   */
  const allPresent = !isEmptyClass && missing.length === 0 && active === total

  return {
    hasActivity: true,
    activeStudents: active,
    totalStudents: total,
    missing,
    missingCount: missing.length,
    isEmptyClass,
    allPresent,
    /*
     * `null` rather than "0 / 0". The card renders a sentence for an empty class, and a
     * zero pair here would be one line away from being rendered as a statistic again.
     */
    ratio: isEmptyClass ? null : `${active} / ${total}`,
    /*
     * No missing-student control for a class with nobody in it. There is nothing to
     * list and nothing to report, and an empty panel would read as a successful
     * all-clear rather than as "nothing to report".
     */
    showMissingControl: !isEmptyClass,
  }
}

/** The label on the missing-students toggle, given the presentation above. */
export function missingToggleLabel({ isEmptyClass, allPresent, missingCount }) {
  if (isEmptyClass) return null
  return allPresent ? 'Everyone is signed in' : `Missing Students (${missingCount})`
}