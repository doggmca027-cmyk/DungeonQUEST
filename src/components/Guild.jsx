import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useLanguage } from '../i18n/LanguageContext.jsx'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME
const APP_SHORT_NAME = import.meta.env.VITE_TELEGRAM_APP_SHORT_NAME

const LEVELS = [
  { level: 1, rate: '10%' },
  { level: 2, rate: '5%' },
  { level: 3, rate: '2%' },
]

function displayName(person) {
  if (person.username) return `@${person.username}`
  if (person.first_name) return person.first_name
  return `#${person.user_id}`
}

function Guild() {
  const { t } = useLanguage()
  const [user] = useState(() => tg?.initDataUnsafe?.user ?? null)
  const [earnings, setEarnings] = useState(0)
  const [earningsByLevel, setEarningsByLevel] = useState({ 1: 0, 2: 0, 3: 0 })
  const [referrals, setReferrals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const referralLink = user
    ? `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=ref_${user.id}`
    : ''

  const refresh = useCallback(async () => {
    if (!user) return
    const [{ data: userData, error: userErr }, { data: statsData, error: statsErr }] = await Promise.all([
      supabase
        .from('users')
        .select('referral_earnings, referral_earnings_l1, referral_earnings_l2, referral_earnings_l3')
        .eq('id', user.id)
        .single(),
      supabase.rpc('get_referral_stats'),
    ])
    if (userErr) throw userErr
    if (statsErr) throw statsErr
    setEarnings(userData?.referral_earnings ?? 0)
    setEarningsByLevel({
      1: userData?.referral_earnings_l1 ?? 0,
      2: userData?.referral_earnings_l2 ?? 0,
      3: userData?.referral_earnings_l3 ?? 0,
    })
    setReferrals(statsData ?? [])
  }, [user])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        await refresh()
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [refresh])

  const countsByLevel = useMemo(() => {
    const counts = { 1: 0, 2: 0, 3: 0 }
    for (const ref of referrals) {
      counts[ref.level] = (counts[ref.level] ?? 0) + 1
    }
    return counts
  }, [referrals])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(referralLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError(t('guild.copyError'))
    }
  }

  if (!user) {
    return (
      <p className="text-sm text-theme-dark-text/70">{t('guild.openInTelegram')}</p>
    )
  }

  return (
    <div className="flex flex-col gap-4 text-left">
      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <h3 className="font-semibold text-base">{t('guild.referralLinkTitle')}</h3>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={referralLink}
            className="flex-1 min-w-0 rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-xs text-theme-dark-text/80"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 flex items-center gap-1 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? t('guild.copied') : t('guild.copy')}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-100 border border-red-300 rounded-2xl px-3 py-2">
          {error}
        </p>
      )}

      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-base">{t('guild.networkIncome')}</h3>
          <span className="text-xs font-medium text-theme-accent bg-theme-accent/10 px-2.5 py-1 rounded-full">
            {loading ? '…' : `${earnings} GRAM`}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {LEVELS.map(({ level, rate }) => (
            <div
              key={level}
              className="rounded-2xl border border-theme-card-border bg-white px-2 py-3 text-center flex flex-col gap-1"
            >
              <p className="text-xs text-theme-dark-text/60">{t('guild.levelLabel', { level })}</p>
              <p className="text-lg font-bold text-theme-dark-text">
                {loading ? '…' : countsByLevel[level] ?? 0}
              </p>
              <p className="text-xs text-theme-accent font-medium">{rate}</p>
              <p className="text-xs font-semibold text-theme-dark-text/80 border-t border-theme-card-border pt-1 mt-1">
                {loading ? '…' : `${earningsByLevel[level] ?? 0} GRAM`}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <h3 className="font-semibold text-base">{t('guild.invitedPlayers')}</h3>
        {loading ? (
          <p className="text-sm text-theme-dark-text/70">{t('guild.loading')}</p>
        ) : referrals.length === 0 ? (
          <p className="text-sm text-theme-dark-text/70">{t('guild.noInvites')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {referrals.map((ref) => (
              <li
                key={ref.user_id}
                className="flex items-center justify-between gap-2 rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm"
              >
                <span className="truncate">{displayName(ref)}</span>
                <span className="shrink-0 text-xs font-medium text-theme-accent bg-theme-accent/10 px-2 py-1 rounded-full">
                  {t('guild.levelShort', { level: ref.level })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default Guild
