/*
 * The CampusFlow brand logo, rendered from the prepared transparent PNG in
 * `public/` (the supplied source artwork, with its baked-in checkerboard
 * background removed). The badge is circular, so it is always `contain`-fitted
 * -- never cropped or stretched -- at its natural aspect ratio. Every usage
 * sits beside the Campus-Flow wordmark, so the image is decorative.
 */
export default function BrandLogo({ size = 24, className = '' }) {
  return (
    <img
      src="/campusflow-logo.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={`cf-brand-mark ${className}`}
    />
  )
}
