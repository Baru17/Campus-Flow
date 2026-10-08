import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { APP_ACCESS_URL } from '../constants'
import InstallPwaButton from './InstallPwaButton'
import { CheckIcon, CopyIcon, DownloadIcon, LogoIcon } from './Icons'

/*
 * Rendered large enough to survive being photographed off a notice board, and re-encoded
 * at this width for the download so a poster gets a crisp file rather than an upscaled
 * screenshot.
 */
const QR_RENDER_WIDTH = 720

const APP_HOST = new URL(APP_ACCESS_URL).host

/**
 * The "Access CampusFlow" card: the deployed site's address, and the three ways to get
 * at it from a phone -- install the app, copy the link, or download the QR code.
 *
 * ## Why the code is generated but not shown
 *
 * The QR is built here and handed straight to the browser as a download. It is
 * deliberately not rendered on the page: its purpose is print and presentation -- a
 * notice board, a poster, a slide -- and on screen it was a large block of visual weight
 * on the landing screen for something nobody can scan from the same device. The button
 * that produces it is the feature, so generation and the `qrcode` dependency stay.
 *
 * ## What the code contains
 *
 * One thing: `APP_ACCESS_URL`, the bare site root. There is no role, no student ID, no
 * OTP and no OD reference in it, and there is nowhere in this component to put one. That is
 * deliberate, and it is the reason the scan grants nothing at all -- scanning it opens the
 * public landing page and then follows exactly the same `/role-selection` and sign-in
 * path as a visitor who typed the address. Every later authorization decision is still
 * made by the backend from the session cookie it issued.
 *
 * ## Why it lives here
 *
 * The role-selection screen is the one page every visitor reaches without signing in and
 * the one page that is not somebody's working dashboard. Putting it here keeps it out of
 * the Student, Staff, Class Advisor, Coordinator, HOD and Admin views, where a permanent
 * panel would be in the way, while still being two clicks away during a demonstration.
 */
export default function AccessCampusFlow() {
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef(null)

  useEffect(() => {
    let active = true

    QRCode.toDataURL(APP_ACCESS_URL, {
      width: QR_RENDER_WIDTH,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172aff', light: '#ffffffff' },
    })
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl)
      })
      .catch(() => {
        if (active) setQrDataUrl('')
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(APP_ACCESS_URL)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      /*
       * Clipboard writes need a secure context and can be refused outright. The URL is
       * printed underneath the code precisely so it can be typed by hand when this fails,
       * so there is nothing to recover here.
       */
      setCopied(false)
    }
  }

  const handleDownload = () => {
    if (!qrDataUrl) return
    const link = document.createElement('a')
    link.href = qrDataUrl
    link.download = 'campusflow-qr.png'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  return (
    <section
      className="mt-8 rounded-3xl border border-slate-200 bg-linear-to-br from-blue-50/70 to-violet-50/70 p-4 text-center sm:p-5 sm:text-left"
      aria-labelledby="cf-access-heading"
    >
      <h2
        id="cf-access-heading"
        className="flex items-center justify-center gap-2 text-lg font-extrabold tracking-tight text-slate-900 sm:justify-start"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-blue-600 to-violet-600 text-white">
          <LogoIcon size={15} />
        </span>
        Scan to access CampusFlow
      </h2>

      <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
        Download the QR code below for a notice board, poster or presentation. Anyone who
        scans it opens CampusFlow on their phone and can add it to their home screen.
        Signing in is unchanged — the code is only a link.
      </p>

      <p className="mt-2 text-[11px] font-semibold text-slate-500 sm:text-xs">
        <span className="text-slate-400">Scan to open:</span>{' '}
        <span className="select-all whitespace-nowrap text-slate-700">{APP_HOST}</span>
      </p>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
        <InstallPwaButton variant="full" />

        <button
          type="button"
          className="auth-btn-secondary px-4 py-2 text-sm"
          onClick={handleCopy}
        >
          {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          {copied ? 'Copied' : 'Copy link'}
        </button>

        <button
          type="button"
          className="auth-btn-secondary px-4 py-2 text-sm"
          onClick={handleDownload}
          disabled={!qrDataUrl}
        >
          <DownloadIcon size={15} />
          Download QR
        </button>
      </div>
    </section>
  )
}