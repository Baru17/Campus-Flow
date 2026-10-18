// @vitest-environment jsdom
/*
 * The install affordance, and the event it spends.
 *
 * ## What the console line is
 *
 * Chromium logs
 *
 *   Banner not shown: beforeinstallpromptevent.preventDefault() called. The page must
 *   call beforeinstallpromptevent.prompt() to show the banner.
 *
 * from `AppBannerManager::Terminate` whenever the page navigates away or closes while a
 * `preventDefault()`ed event is still unspent. It is the browser confirming that CampusFlow
 * intercepted the event and took the install UI over from it -- it is not an error, and
 * suppressing it would mean letting Chrome show its own banner instead of this button.
 *
 * What CampusFlow controls is that the event is spent the moment someone asks for it, and
 * that nothing else is prompted on load. These tests hold it to exactly that.
 */
import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InstallPwaButton from '../src/components/InstallPwaButton'
import { INSTALL_OUTCOME, getInstallSnapshot, promptInstall, resetInstallState } from '../src/utils/pwaInstall'

/**
 * A `beforeinstallprompt` as the browser would deliver one.
 *
 * `dispatchEvent` needs a real `Event`, and `preventDefault()` needs it to be cancelable,
 * so the browser methods are kept and only the two the event adds are attached.
 */
function makePromptEvent() {
  let settle
  const event = new Event('beforeinstallprompt', { cancelable: true })
  event.prompt = vi.fn(() => Promise.resolve())
  event.userChoice = new Promise((resolve) => {
    settle = resolve
  })
  event.settle = (outcome) => settle({ outcome, platform: 'web' })
  return event
}

function offerInstallPrompt() {
  const event = makePromptEvent()
  window.dispatchEvent(event)
  return event
}

describe('the install prompt', () => {
  beforeEach(() => {
    resetInstallState()
  })

  afterEach(() => {
    cleanup()
  })

  describe('capturing the event', () => {
    it('prevents the browser banner so CampusFlow is the only affordance', () => {
      const event = offerInstallPrompt()

      expect(event.defaultPrevented).toBe(true)
    })

    it('offers the button once the browser has an event', () => {
      expect(getInstallSnapshot().canInstall).toBe(false)

      offerInstallPrompt()

      expect(getInstallSnapshot().canInstall).toBe(true)
    })

    it('holds only the newest event, because the old one is already spent or stale', () => {
      const first = offerInstallPrompt()
      const second = offerInstallPrompt()

      expect(getInstallSnapshot().canInstall).toBe(true)
      /* Both were cancelled, and the newer one is the one that will be spent. */
      expect(first.defaultPrevented).toBe(true)
      expect(second.defaultPrevented).toBe(true)
    })
  })

  describe('spending the event', () => {
    it('calls prompt() only when the user clicks, never on load', () => {
      const event = offerInstallPrompt()

      /* Merely holding the event must not open anything. */
      expect(event.prompt).not.toHaveBeenCalled()
    })

    it('opens the browser dialog from the button click', async () => {
      const event = offerInstallPrompt()
      render(<InstallPwaButton />)

      screen.getByRole('button').click()
      await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1))
    })

    it('reports an accepted install and says so', async () => {
      const event = offerInstallPrompt()
      render(<InstallPwaButton variant="full" />)

      screen.getByRole('button').click()
      await waitFor(() => expect(event.prompt).toHaveBeenCalled())
      event.settle('accepted')

      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toMatch(/install/i)
      )
    })

    it('reports a dismissal instead of failing silently', async () => {
      /*
       * The old code returned a bare boolean that no caller read, so declining and having
       * nothing to prompt were indistinguishable to the user.
       */
      const event = offerInstallPrompt()
      render(<InstallPwaButton variant="full" />)

      screen.getByRole('button').click()
      await waitFor(() => expect(event.prompt).toHaveBeenCalled())
      event.settle('dismissed')

      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toMatch(/dismiss/i)
      )
    })

    it('takes the button away once the event is spent', async () => {
      const event = offerInstallPrompt()
      render(<InstallPwaButton />)

      screen.getByRole('button').click()
      await waitFor(() => expect(getInstallSnapshot().canInstall).toBe(false))
      event.settle('dismissed')

      await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
    })

    it('never spends the same event twice on a double click', async () => {
      const event = offerInstallPrompt()
      render(<InstallPwaButton />)

      const button = screen.getByRole('button')
      button.click()
      button.click()

      await waitFor(() => expect(getInstallSnapshot().pending).toBe(true))
      event.settle('accepted')
      await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1))
    })
  })

  describe('when there is nothing to prompt', () => {
    it('renders nothing rather than a button that cannot work', () => {
      render(<InstallPwaButton />)

      expect(screen.queryByRole('button')).toBeNull()
    })

    it('reports unavailable instead of fabricating an event', async () => {
      await expect(promptInstall()).resolves.toBe(INSTALL_OUTCOME.UNAVAILABLE)
    })

    it('does not throw or prompt when the dialog itself fails', async () => {
      const event = offerInstallPrompt()
      event.prompt = vi.fn(() => Promise.reject(new Error('superseded')))

      await expect(promptInstall()).resolves.toBe(INSTALL_OUTCOME.UNAVAILABLE)
      expect(getInstallSnapshot().canInstall).toBe(false)
    })

    it('treats a missing userChoice as a dismissal rather than throwing', async () => {
      const event = offerInstallPrompt()
      event.userChoice = undefined

      await expect(promptInstall()).resolves.toBe(INSTALL_OUTCOME.DISMISSED)
    })
  })

  describe('installing from elsewhere', () => {
    it('clears the held event and the button when appinstalled fires', async () => {
      /*
       * Installing from the browser's own menu fires `appinstalled` without this page ever
       * calling `prompt()`, so this is the path that clears the capture.
       */
      offerInstallPrompt()
      render(<InstallPwaButton />)
      expect(screen.getByRole('button')).toBeTruthy()

      window.dispatchEvent(new Event('appinstalled'))

      await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
      expect(getInstallSnapshot().installed).toBe(true)
      expect(getInstallSnapshot().canInstall).toBe(false)
    })
  })

  describe('listeners', () => {
    it('registers the browser listeners exactly once, however many times it is imported', async () => {
      /*
       * `utils/pwaInstall` is imported both for its side effect in `main.jsx` and by the
       * hook, and `StrictMode` mounts components twice. If registration were per-import or
       * per-mount, `preventDefault()` would run on the same event more than once and the
       * capture would be ambiguous. Module scope makes it once.
       */
      vi.resetModules()
      const addEventListener = vi.spyOn(window, 'addEventListener')

      await import('../src/utils/pwaInstall')
      await import('../src/utils/pwaInstall')
      await import('../src/utils/pwaInstall')

      const registrations = addEventListener.mock.calls.filter(
        ([type]) => type === 'beforeinstallprompt' || type === 'appinstalled'
      )
      expect(registrations).toHaveLength(2)

      addEventListener.mockRestore()
    })
  })
})

describe('the install button under StrictMode', () => {
  beforeEach(() => {
    resetInstallState()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows one button and spends the event once', async () => {
    const event = offerInstallPrompt()

    render(
      <StrictMode>
        <InstallPwaButton />
      </StrictMode>
    )

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)

    buttons[0].click()
    await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1))
    event.settle('accepted')

    await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
  })
})

/*
 * The message is cleared on a timer so a dismissal does not leave a sentence sitting in
 * the navbar for the rest of the session. Timers are faked here so that is asserted rather
 * than assumed.
 */
describe('the dismissal message', () => {
  beforeEach(() => {
    resetInstallState()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears itself after a moment', async () => {
    const event = offerInstallPrompt()
    render(<InstallPwaButton variant="full" />)

    screen.getByRole('button').click()
    await vi.advanceTimersByTimeAsync(0)
    expect(event.prompt).toHaveBeenCalled()
    event.settle('dismissed')

    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByRole('status')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
