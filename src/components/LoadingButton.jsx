export default function LoadingButton({
  children,
  loading = false,
  loadingText = 'Please wait…',
  variant = 'primary',
  disabled = false,
  className = '',
  ...rest
}) {
  return (
    <button
      type="button"
      className={`btn-cf-${variant} ${className}`.trim()}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <>
          <span
            className="cf-spinner me-2"
            role="status"
            aria-hidden="true"
          />
          {loadingText}
        </>
      ) : (
        children
      )}
    </button>
  )
}