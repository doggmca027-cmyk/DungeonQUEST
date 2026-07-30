import { Headset } from 'lucide-react'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL

function handleSupportClick() {
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(SUPPORT_URL)
  } else {
    window.open(SUPPORT_URL, '_blank')
  }
}

function SupportButton() {
  return (
    <button
      type="button"
      onClick={handleSupportClick}
      className="shrink-0 flex items-center gap-1.5 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-card border border-theme-card-border text-theme-accent"
    >
      <Headset size={18} />
      Поддержка
    </button>
  )
}

export default SupportButton
