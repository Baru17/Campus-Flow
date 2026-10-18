/*
 * The From Date / To Date arithmetic, with no DOM and no Worker.
 *
 * Everything the range picker does to a request -- the day count the student is shown,
 * the days written into `od_dates`, the line the approvers read -- comes out of this
 * one module, so this is where the interesting cases belong.
 *
 * The cases that matter are not the happy path. They are the boundaries: a single day, a
 * range that runs off the end of a month, a leap day, and -- the one that is easy to get
 * wrong and impossible to see -- a range whose arithmetic happens in the reader's own
 * timezone rather than UTC.
 */

import { describe, expect, it } from 'vitest'
import {
  countDaysInclusive,
  expandDateRange,
  formatOdDates,
  isIsoDateString,
} from '../src/utils/odDateRange'
import { MAX_OD_DAYS } from '../src/utils/odValidation'

describe('isIsoDateString', () => {
  it('accepts a real date', () => {
    expect(isIsoDateString('2026-10-18')).toBe(true)
    expect(isIsoDateString('2028-02-29')).toBe(true)
  })

  it('rejects a day that only looks like one exists', () => {
    // The shape matches and the day does not, which is what a regex alone would let
    // through into `od_dates` as a string that never means anything.
    expect(isIsoDateString('2026-02-31')).toBe(false)
    expect(isIsoDateString('2026-13-01')).toBe(false)
    expect(isIsoDateString('2026-00-10')).toBe(false)
  })

  it('rejects other shapes and non-strings', () => {
    expect(isIsoDateString('18-10-2026')).toBe(false)
    expect(isIsoDateString('2026/10/18')).toBe(false)
    expect(isIsoDateString('2026-10-18T00:00:00Z')).toBe(false)
    expect(isIsoDateString('')).toBe(false)
    expect(isIsoDateString(20261018)).toBe(false)
    expect(isIsoDateString(null)).toBe(false)
    expect(isIsoDateString(undefined)).toBe(false)
  })
})

describe('countDaysInclusive', () => {
  it('counts a single day as one', () => {
    // From and To the same day is the degenerate range, and it has to be one day and
    // not zero -- otherwise a one-day OD cannot be filed at all.
    expect(countDaysInclusive('2026-10-18', '2026-10-18')).toBe(1)
  })

  it('counts both ends of a multi-day range', () => {
    // The 18th to the 20th is the 18th, the 19th and the 20th: three days, not two.
    expect(countDaysInclusive('2026-10-18', '2026-10-20')).toBe(3)
    expect(countDaysInclusive('2026-10-18', '2026-10-19')).toBe(2)
  })

  it('counts inclusively right up to the day cap', () => {
    // 18 October plus 14 days is 1 November: the last range `MAX_OD_DAYS` permits.
    expect(countDaysInclusive('2026-10-18', '2026-11-01')).toBe(MAX_OD_DAYS)
    // One day further, and the cap is breached -- which is what the form refuses.
    expect(countDaysInclusive('2026-10-18', '2026-11-02')).toBe(MAX_OD_DAYS + 1)
  })

  it('crosses a month boundary', () => {
    expect(countDaysInclusive('2026-10-30', '2026-11-02')).toBe(4)
  })

  it('crosses a year boundary', () => {
    expect(countDaysInclusive('2026-12-30', '2027-01-02')).toBe(4)
  })

  it('crosses a leap day', () => {
    // 2028 is a leap year, so the 29th exists and must be counted.
    expect(countDaysInclusive('2028-02-28', '2028-03-01')).toBe(3)
    expect(expandDateRange('2028-02-28', '2028-03-01')).toContain('2028-02-29')
  })

  it('rejects a reversed range', () => {
    expect(countDaysInclusive('2026-10-20', '2026-10-18')).toBeNull()
    expect(countDaysInclusive('2026-10-19', '2026-10-18')).toBeNull()
  })

  it('rejects a missing or malformed end', () => {
    expect(countDaysInclusive('', '2026-10-18')).toBeNull()
    expect(countDaysInclusive('2026-10-18', '')).toBeNull()
    expect(countDaysInclusive('2026-10-18', 'soon')).toBeNull()
    expect(countDaysInclusive(null, null)).toBeNull()
  })
})

describe('expandDateRange', () => {
  it('returns the single day for a one-day range', () => {
    expect(expandDateRange('2026-10-18', '2026-10-18')).toEqual(['2026-10-18'])
  })

  it('returns every day of a multi-day range, both ends included', () => {
    expect(expandDateRange('2026-10-18', '2026-10-20')).toEqual([
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
    ])
  })

  it('produces exactly as many days as it counted', () => {
    for (const [from, to] of [
      ['2026-10-18', '2026-10-18'],
      ['2026-10-18', '2026-10-20'],
      ['2026-10-30', '2026-11-04'],
      ['2026-12-29', '2027-01-04'],
      ['2028-02-26', '2028-03-02'],
    ]) {
      expect(expandDateRange(from, to)).toHaveLength(countDaysInclusive(from, to))
    }
  })

  it('crosses a month boundary without skipping or repeating a day', () => {
    expect(expandDateRange('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ])
  })

  it('crosses a year boundary without skipping or repeating a day', () => {
    expect(expandDateRange('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ])
  })

  it('includes a leap day in the right place', () => {
    expect(expandDateRange('2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ])
    // 2026 is not a leap year, so the same window has one day fewer.
    expect(expandDateRange('2026-02-28', '2026-03-01')).toEqual(['2026-02-28', '2026-03-01'])
  })

  it('spans a leap day inside a longer range', () => {
    const days = expandDateRange('2028-02-27', '2028-03-02')
    expect(days).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
      '2028-03-02',
    ])
    expect(days).toHaveLength(5)
  })

  it('returns nothing for a range that covers nothing', () => {
    expect(expandDateRange('2026-10-20', '2026-10-18')).toEqual([])
    expect(expandDateRange('2026-10-18', '')).toEqual([])
  })

  it('serialises every day as a real YYYY-MM-DD string', () => {
    // What goes into `od_dates` is compared as a string by the approval screens and
    // matched against the session date by attendance, so the shape is load-bearing.
    for (const value of expandDateRange('2026-12-28', '2027-01-04')) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(isIsoDateString(value)).toBe(true)
    }
  })

  it('does not shift the range in a timezone west of UTC', () => {
    /*
     * The failure this guards against: `new Date("2026-10-18")` is UTC midnight, and
     * reading it back in any negative offset prints the 17th, so the range would lose
     * its first day for a student in the Americas. The module does no local-time
     * reading at all, so this holds whatever the host zone is -- which is what makes it
     * worth asserting rather than trusting.
     *
     * `globalThis.process` rather than `process`, because the linter reads this file
     * with browser globals and the suite runs under Node.
     */
    const original = globalThis.process.env.TZ
    try {
      globalThis.process.env.TZ = 'America/Los_Angeles'
      expect(expandDateRange('2026-10-18', '2026-10-20')).toEqual([
        '2026-10-18',
        '2026-10-19',
        '2026-10-20',
      ])
      expect(countDaysInclusive('2026-10-18', '2026-10-20')).toBe(3)
    } finally {
      globalThis.process.env.TZ = original
    }
  })

  it('does not lose a day across a daylight-saving boundary', () => {
    // Zones that shift their clocks in spring would drop 31 March from a local-time walk
    // of this exact range, which would silently shorten the OD a student was granted.
    const original = globalThis.process.env.TZ
    try {
      globalThis.process.env.TZ = 'Europe/Berlin'
      expect(expandDateRange('2026-03-30', '2026-04-01')).toEqual([
        '2026-03-30',
        '2026-03-31',
        '2026-04-01',
      ])
      expect(countDaysInclusive('2026-03-30', '2026-04-01')).toBe(3)
    } finally {
      globalThis.process.env.TZ = original
    }
  })
})

describe('formatOdDates', () => {
  it('leaves a single day alone', () => {
    expect(formatOdDates(['2026-10-18'])).toBe('2026-10-18')
  })

  it('collapses a contiguous run to its two ends', () => {
    expect(formatOdDates(expandDateRange('2026-10-18', '2026-10-20'))).toBe(
      '2026-10-18 \u2013 2026-10-20'
    )
  })

  it('lists a non-contiguous request day by day', () => {
    // What a record filed before the range picker existed looks like. It must keep
    // reading the way it always has, gaps and all.
    expect(formatOdDates(['2026-10-12', '2026-10-14'])).toBe('2026-10-12, 2026-10-14')
  })

  it('collapses each run in a mixed list', () => {
    expect(
      formatOdDates(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-20'])
    ).toBe('2026-10-12 \u2013 2026-10-14, 2026-10-20')
  })

  it('does not treat a month boundary as a gap', () => {
    expect(formatOdDates(expandDateRange('2026-10-30', '2026-11-02'))).toBe(
      '2026-10-30 \u2013 2026-11-02'
    )
  })

  it('does not treat a year boundary as a gap', () => {
    expect(formatOdDates(expandDateRange('2026-12-30', '2027-01-02'))).toBe(
      '2026-12-30 \u2013 2027-01-02'
    )
  })

  it('does not treat a leap day as a gap', () => {
    expect(formatOdDates(expandDateRange('2028-02-28', '2028-03-01'))).toBe(
      '2028-02-28 \u2013 2028-03-01'
    )
  })

  it('does not join two identical entries into a range', () => {
    expect(formatOdDates(['2026-10-18', '2026-10-18'])).toBe('2026-10-18, 2026-10-18')
  })

  it('has nothing to say about an empty or absent list', () => {
    expect(formatOdDates([])).toBe('')
    expect(formatOdDates(undefined)).toBe('')
    expect(formatOdDates(null)).toBe('')
  })
})
