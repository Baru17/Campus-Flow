import GlassCard from './GlassCard'
import { ActivityIcon, CheckIcon, LogoIcon } from './Icons'

export default function BrandPanel() {
  return (
    <aside className="relative flex flex-col items-center justify-center overflow-hidden bg-linear-to-br from-[#172554] via-[#312e81] to-[#4c1d95] animate-gradient px-8 py-10 text-center lg:px-12 lg:py-16">
      {/* Soft blurred orbs */}
      <div
        className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-blue-500/30 blur-3xl animate-drift"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-32 -right-20 h-[28rem] w-[28rem] rounded-full bg-violet-500/30 blur-3xl animate-drift-2"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute right-10 top-1/3 h-72 w-72 rounded-full bg-indigo-400/25 blur-3xl animate-drift"
        aria-hidden="true"
      />

      {/* Subtle dot grid */}
      <div className="pointer-events-none absolute inset-0 brand-dots opacity-60" aria-hidden="true" />

      {/* Center branding */}
      <div className="relative z-10 flex items-center gap-4 lg:flex-col lg:gap-5 lg:text-center">
        <div className="glass-tile">
          <LogoIcon size={32} />
        </div>
        <div>
          <h2 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl lg:text-4xl">
            Campus-Flow
          </h2>
          <p className="mt-1 text-sm font-medium text-blue-200 lg:text-base">
            Smart Attendance. Simple. Secure. Automated.
          </p>
        </div>
      </div>

      <p className="relative z-10 mt-4 hidden max-w-xs text-sm leading-relaxed text-blue-200/70 lg:block">
        A smarter way to manage classroom attendance using secure OTP-based verification.
      </p>

      {/* Floating attendance cards — contained inside the panel with safe insets */}
      <div className="brand-panel-cards pointer-events-none absolute z-10 hidden inset-x-5 inset-y-8 lg:block lg:inset-x-6 lg:inset-y-9 xl:inset-x-7 xl:inset-y-10 2xl:inset-x-8 2xl:inset-y-11">
        <GlassCard className="left-0 top-0 w-[205px] p-4 text-left animate-float">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-blue-100/70">
              Attendance
            </span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-300/30 bg-emerald-400/20 text-emerald-200">
              <ActivityIcon size={15} />
            </span>
          </div>
          <div className="text-sm font-bold text-white">Present</div>
          <div className="mt-0.5 text-xs font-semibold text-blue-100/80">58 / 60 Students</div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-[96%] rounded-full bg-linear-to-r from-emerald-300 to-emerald-400" />
          </div>
        </GlassCard>

        <GlassCard className="right-0 top-0 w-[220px] p-4 text-left animate-float-slow">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-blue-100/70">
              Live Session
            </span>
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </span>
          </div>
          <div className="text-base font-bold text-white">IT • III Year • A</div>
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-300/30 bg-emerald-400/15 px-2.5 py-1 text-[11px] font-bold text-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-glow" />
            OTP Active
          </div>
        </GlassCard>

        <GlassCard className="bottom-0 left-0 w-[185px] p-4 text-left animate-float-slower">
          <div className="mb-2 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-300/30 bg-blue-400/20 text-blue-200">
              <CheckIcon size={15} />
            </span>
            <span className="text-[11px] font-bold uppercase tracking-wider text-blue-100/70">
              Student Verified
            </span>
          </div>
          <div className="text-sm font-bold tracking-wide text-white">2K24IT001</div>
          <div className="mt-0.5 text-xs font-semibold text-blue-100/80">Attendance marked</div>
        </GlassCard>

        <GlassCard className="bottom-0 right-0 flex w-[185px] items-center gap-3 p-4 animate-float">
          <div className="relative h-14 w-14 shrink-0">
            <svg viewBox="0 0 36 36" className="h-14 w-14 -rotate-90">
              <circle cx="18" cy="18" r="15.9" fill="none" className="stroke-white/15" strokeWidth="3.5" />
              <circle
                cx="18"
                cy="18"
                r="15.9"
                fill="none"
                stroke="#a78bfa"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeDasharray="100"
                strokeDashoffset="4"
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-sm font-extrabold text-white">
              96%
            </span>
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-wider text-blue-100/70">
              Attendance Rate
            </div>
            <div className="mt-0.5 text-base font-bold text-white">Excellent</div>
          </div>
        </GlassCard>
      </div>
    </aside>
  )
}