export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" aria-hidden="true" className={className}>
      <rect x="8" y="8" width="240" height="240" rx="56" fill="#0a0a0a" />
      <rect
        x="8.75"
        y="8.75"
        width="238.5"
        height="238.5"
        rx="55.25"
        fill="none"
        stroke="#2a2a2a"
        strokeWidth="1.5"
      />
      <circle
        cx="112"
        cy="128"
        r="54"
        fill="none"
        stroke="#fafafa"
        strokeWidth="24"
      />
      <circle cx="180" cy="128" r="41" fill="#0a0a0a" />
      <circle cx="180" cy="128" r="30" fill="#fafafa" />
    </svg>
  )
}
