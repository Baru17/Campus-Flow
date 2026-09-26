export default function GlassCard({ children, className = '' }) {
  return (
    <div
      className={`absolute z-20 rounded-2xl border border-white/15 bg-white/10 backdrop-blur-md shadow-[0_16px_40px_rgba(2,6,23,0.28)] ${className}`}
    >
      {children}
    </div>
  )
}
