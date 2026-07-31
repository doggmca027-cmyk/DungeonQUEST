import { useCallback, useEffect, useState } from 'react'
import { Swords, Check } from 'lucide-react'
import { supabase } from '../supabaseClient'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

const DAILY_REWARDS = [0.01, 0.02, 0.03, 0.05, 0.1, 0.15, 0.25]

function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}

function yesterdayUtc() {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function formatDuration(ms) {
  if (ms <= 0) return 'Сезон завершён'
  const totalMinutes = Math.floor(ms / 60000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  return `${days}д ${hours}ч ${minutes}м`
}

function Home({ onNavigateToExpedition }) {
  const [user] = useState(() => tg?.initDataUnsafe?.user ?? null)
  const [balance, setBalance] = useState(0)
  const [activeExpeditions, setActiveExpeditions] = useState([])
  const [dungeonNames, setDungeonNames] = useState({})
  const [checkin, setCheckin] = useState(null)
  const [seasonEndAt, setSeasonEndAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])

  const refresh = useCallback(async () => {
    if (!user) return
    const [
      { data: userData, error: userErr },
      { data: expeditionsData, error: expErr },
      { data: dungeonsData, error: dungeonsErr },
      { data: checkinData, error: checkinErr },
      { data: settingsData, error: settingsErr },
    ] = await Promise.all([
      supabase.from('users').select('gram_balance').eq('id', user.id).single(),
      supabase.from('expeditions').select('*').eq('user_id', user.id).eq('is_claimed', false),
      supabase.from('dungeons').select('id, name'),
      supabase.from('daily_checkins').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'season_end_at').maybeSingle(),
    ])
    if (userErr) throw userErr
    if (expErr) throw expErr
    if (dungeonsErr) throw dungeonsErr
    if (checkinErr) throw checkinErr
    if (settingsErr) throw settingsErr

    setBalance(userData?.gram_balance ?? 0)
    setActiveExpeditions(expeditionsData ?? [])
    setDungeonNames(Object.fromEntries((dungeonsData ?? []).map((d) => [d.id, d.name])))
    setCheckin(checkinData ?? null)
    setSeasonEndAt(settingsData?.value ?? null)
  }, [user])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        await refresh()
      } catch (err) {
        console.error('Failed to load dashboard:', err)
        if (!cancelled) setError(err.message ?? 'Не удалось загрузить данные профиля')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [refresh])

  async function handleClaimBonus() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { data, error: rpcErr } = await supabase.rpc('claim_daily_bonus')
      if (rpcErr) throw rpcErr
      if (!data?.success) throw new Error(data?.message ?? 'Не удалось получить бонус')

      setNotice(`День ${data.day}: +${data.reward} GRAM`)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!user) {
    return (
      <p className="text-sm text-theme-dark-text/70">
        Откройте приложение через Telegram, чтобы увидеть профиль.
      </p>
    )
  }

  const nearestExpedition = activeExpeditions[0] ?? null
  const claimedToday = checkin?.last_claim_date === todayUtc()
  const isStreakContinuing = checkin?.last_claim_date === yesterdayUtc()
  const currentStreakDay = claimedToday
    ? checkin.streak_day
    : isStreakContinuing
      ? Math.min(checkin.streak_day + 1, 7)
      : 1
  const seasonMsLeft = seasonEndAt ? new Date(seasonEndAt).getTime() - now : null

  return (
    <div className="flex flex-col gap-3 text-left">
      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex items-center gap-3">
        {user.photo_url ? (
          <img src={user.photo_url} alt="" className="w-12 h-12 rounded-full object-cover" />
        ) : (
          <div className="w-12 h-12 shrink-0 rounded-full bg-theme-accent/10 flex items-center justify-center text-theme-accent font-bold text-lg">
            {user.first_name?.[0]?.toUpperCase() ?? '?'}
          </div>
        )}
        <div className="min-w-0">
          <p className="font-semibold text-base truncate">
            {user.first_name}
            {user.username ? ` (@${user.username})` : ''}
          </p>
          <p className="text-xs text-theme-dark-text/60">Telegram ID: {user.id}</p>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-100 border border-red-300 rounded-2xl px-3 py-2">
          {error}
        </p>
      )}
      {notice && (
        <p className="text-sm text-theme-accent bg-theme-accent/10 border border-theme-card-border rounded-2xl px-3 py-2">
          {notice}
        </p>
      )}

      {seasonMsLeft !== null && (
        <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex items-center justify-between">
          <span className="text-sm text-theme-dark-text/70">До конца сезона</span>
          <span className="text-sm font-bold text-theme-accent">{formatDuration(seasonMsLeft)}</span>
        </div>
      )}

      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <span className="text-sm text-theme-dark-text/70">Ежедневный бонус</span>
        <div className="grid grid-cols-7 gap-1">
          {DAILY_REWARDS.map((reward, index) => {
            const day = index + 1
            const isClaimed = day < currentStreakDay || (day === currentStreakDay && claimedToday)
            const isCurrent = day === currentStreakDay && !claimedToday
            return (
              <div
                key={day}
                className={`rounded-xl border px-1 py-2 text-center ${
                  isClaimed
                    ? 'bg-theme-accent/10 border-theme-accent text-theme-accent'
                    : isCurrent
                      ? 'border-theme-accent text-theme-dark-text'
                      : 'border-theme-card-border text-theme-dark-text/50'
                }`}
              >
                {isClaimed ? <Check size={14} className="mx-auto" /> : <p className="text-[10px]">{day}</p>}
                <p className="text-[10px] mt-0.5">{reward}</p>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={handleClaimBonus}
          disabled={busy || claimedToday}
          className="rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {claimedToday ? 'Уже получено сегодня' : busy ? 'Получение…' : 'Забрать бонус'}
        </button>
      </div>

      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex items-center justify-between">
        <span className="text-sm text-theme-dark-text/70">Баланс</span>
        <span className="text-lg font-bold text-theme-accent">
          {loading ? '…' : `${balance} GRAM`}
        </span>
      </div>

      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-2">
        <span className="text-sm text-theme-dark-text/70">Статус похода</span>
        {loading ? (
          <p className="text-sm text-theme-dark-text/70">Загрузка…</p>
        ) : nearestExpedition ? (
          <p className="text-sm font-medium">
            {dungeonNames[nearestExpedition.dungeon_id] ?? 'Подземелье'} · активных походов: {activeExpeditions.length}
          </p>
        ) : (
          <p className="text-sm text-theme-dark-text/70">Сейчас нет активных походов</p>
        )}
      </div>

      <button
        type="button"
        onClick={onNavigateToExpedition}
        className="flex items-center justify-center gap-2 rounded-2xl px-3 py-3 text-sm font-semibold bg-theme-accent text-white"
      >
        <Swords size={18} />
        Перейти к подземельям
      </button>
    </div>
  )
}

export default Home
