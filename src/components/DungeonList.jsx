import { useCallback, useEffect, useMemo, useState } from 'react'
import { Lock } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useLanguage } from '../i18n/LanguageContext.jsx'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

function formatCountdown(ms, t) {
  if (ms <= 0) return t('dungeonList.expeditionComplete')
  const totalSeconds = Math.floor(ms / 1000)
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function DungeonList() {
  const { t } = useLanguage()
  const [user] = useState(() => tg?.initDataUnsafe?.user ?? null)
  const [subTab, setSubTab] = useState('regular')
  const [dungeons, setDungeons] = useState([])
  const [expeditions, setExpeditions] = useState([])
  const [balance, setBalance] = useState(0)
  const [lifetimeDeposit, setLifetimeDeposit] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const refresh = useCallback(async () => {
    if (!user) return
    const [
      { data: expeditionsData, error: expErr },
      { data: userData, error: userErr },
      { data: lifetimeDepositData, error: lifetimeDepositErr },
    ] = await Promise.all([
      supabase.from('expeditions').select('*').eq('user_id', user.id).eq('is_claimed', false),
      supabase.from('users').select('gram_balance').eq('id', user.id).single(),
      supabase.rpc('get_lifetime_deposit_total'),
    ])
    if (expErr) throw expErr
    if (userErr) throw userErr
    if (lifetimeDepositErr) throw lifetimeDepositErr
    setExpeditions(expeditionsData ?? [])
    setBalance(userData?.gram_balance ?? 0)
    setLifetimeDeposit(lifetimeDepositData ?? 0)
  }, [user])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { data: dungeonsData, error: dungeonsErr } = await supabase
          .from('dungeons')
          .select('*')
          .order('entry_cost_gram', { ascending: true })
        if (dungeonsErr) throw dungeonsErr
        if (cancelled) return
        setDungeons(dungeonsData ?? [])

        await refresh()
      } catch (err) {
        console.error('Failed to load dungeons:', err)
        if (!cancelled) setError(err.message ?? t('dungeonList.loadError'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
    // t intentionally omitted -- re-running the load on language toggle would re-fire the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  const expeditionGroups = useMemo(() => {
    const map = {}
    for (const exp of expeditions) {
      if (!map[exp.dungeon_id]) map[exp.dungeon_id] = []
      map[exp.dungeon_id].push(exp)
    }
    return map
  }, [expeditions])

  const regularDungeons = useMemo(
    () => dungeons.filter((d) => !(d.min_lifetime_deposit_gram > 0)),
    [dungeons],
  )
  const exclusiveTiers = useMemo(() => {
    const byThreshold = new Map()
    for (const d of dungeons) {
      if (!(d.min_lifetime_deposit_gram > 0)) continue
      const key = d.min_lifetime_deposit_gram
      if (!byThreshold.has(key)) byThreshold.set(key, [])
      byThreshold.get(key).push(d)
    }
    return [...byThreshold.entries()].sort((a, b) => a[0] - b[0])
  }, [dungeons])

  async function handleEnter(dungeon) {
    if (!user) return
    const group = expeditionGroups[dungeon.id] ?? []
    const inProgress = group.find((e) => new Date(e.end_time).getTime() > Date.now())
    const readyToClaim = group.length > 0 && !inProgress

    if (readyToClaim || balance < dungeon.entry_cost_gram) return

    setBusyId(dungeon.id)
    setError(null)
    try {
      const { data, error: rpcErr } = await supabase.rpc('enter_dungeon', {
        p_dungeon_id: dungeon.id,
        p_count: 1,
      })
      if (rpcErr) throw rpcErr
      if (!data?.success) throw new Error(data?.message ?? t('dungeonList.enterError'))

      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleClaim(dungeonId, group) {
    setBusyId(dungeonId)
    setError(null)
    try {
      for (const expedition of group) {
        const { data, error: rpcErr } = await supabase.rpc('claim_expedition', {
          p_expedition_id: expedition.id,
        })
        if (rpcErr) throw rpcErr
        if (!data?.success) throw new Error(data?.message ?? t('dungeonList.claimError'))
      }

      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  if (!user) {
    return (
      <p className="text-sm text-theme-dark-text/70">{t('dungeonList.openInTelegram')}</p>
    )
  }

  function renderDungeonCard(dungeon) {
    const group = expeditionGroups[dungeon.id] ?? []
    const activeCount = group.reduce((sum, e) => sum + e.active_count, 0)
    const inProgress = group.find((e) => new Date(e.end_time).getTime() > now)
    const readyToClaim = group.length > 0 && !inProgress
    const totalReward = group.reduce((sum, e) => sum + e.reward_per_unit * e.active_count, 0)
    const msLeft = inProgress ? new Date(inProgress.end_time).getTime() - now : 0
    const isBusy = busyId === dungeon.id
    const isLocked = dungeon.min_lifetime_deposit_gram > 0 && lifetimeDeposit < dungeon.min_lifetime_deposit_gram
    const canEnter = !readyToClaim && !isLocked && balance >= dungeon.entry_cost_gram && !isBusy
    const canClaim = readyToClaim && !isBusy
    const profitPercent = Math.round((dungeon.reward_multiplier - 1) * 100)

    return (
      <div
        key={dungeon.id}
        className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-base">{dungeon.name}</h3>
          {isLocked ? (
            <span className="shrink-0 flex items-center gap-1 text-xs font-medium text-theme-dark-text/60 bg-theme-bg/15 px-2.5 py-1 rounded-full">
              <Lock size={12} />
              {t('dungeonList.locked')}
            </span>
          ) : (
            activeCount > 0 && (
              <span className="shrink-0 text-xs font-medium text-theme-accent bg-theme-accent/10 px-2.5 py-1 rounded-full">
                {t('dungeonList.activeCount', { count: activeCount })}
              </span>
            )
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center rounded-full bg-theme-bg/15 border border-theme-card-border px-3 py-1 text-xs font-medium text-theme-accent">
            {t('dungeonList.entryCost', { cost: dungeon.entry_cost_gram })}
          </span>
          <span className="inline-flex items-center rounded-full bg-theme-bg/15 border border-theme-card-border px-3 py-1 text-xs font-medium text-theme-accent">
            {t('dungeonList.duration', { hours: dungeon.duration_hours })}
          </span>
          <span className="inline-flex items-center rounded-full bg-theme-bg/15 border border-theme-card-border px-3 py-1 text-xs font-medium text-theme-accent">
            {t('dungeonList.profit', { percent: profitPercent })}
          </span>
        </div>

        {group.length > 0 && (
          <p className="text-xs text-theme-dark-text/70">
            {readyToClaim
              ? t('dungeonList.lootWaiting', { amount: totalReward })
              : t('dungeonList.inProgress', { time: formatCountdown(msLeft, t) })}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={!canEnter}
            onClick={() => handleEnter(dungeon)}
            className="flex-1 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('dungeonList.enter')}
          </button>
          {group.length > 0 && (
            <button
              type="button"
              disabled={!canClaim}
              onClick={() => handleClaim(dungeon.id, group)}
              className="flex-1 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-dark-text text-theme-card disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('dungeonList.claimLoot')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 rounded-2xl bg-theme-card border border-theme-card-border p-1">
        <button
          type="button"
          onClick={() => setSubTab('regular')}
          className={`flex-1 rounded-2xl px-3 py-2 text-sm font-semibold transition-colors ${
            subTab === 'regular' ? 'bg-theme-accent text-white' : 'text-theme-dark-text/60'
          }`}
        >
          {t('dungeonList.tabRegular')}
        </button>
        <button
          type="button"
          onClick={() => setSubTab('exclusive')}
          className={`flex-1 rounded-2xl px-3 py-2 text-sm font-semibold transition-colors ${
            subTab === 'exclusive' ? 'bg-theme-accent text-white' : 'text-theme-dark-text/60'
          }`}
        >
          {t('dungeonList.tabExclusive')}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-100 border border-red-300 rounded-2xl px-3 py-2">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-theme-dark-text/70">{t('dungeonList.loading')}</p>
      ) : subTab === 'regular' ? (
        regularDungeons.length === 0 ? (
          <div className="bg-theme-card border border-theme-card-border rounded-2xl p-5 text-center">
            <p className="text-sm text-theme-dark-text/70">{t('dungeonList.noneAvailable')}</p>
          </div>
        ) : (
          regularDungeons.map(renderDungeonCard)
        )
      ) : exclusiveTiers.length === 0 ? (
        <div className="bg-theme-card border border-theme-card-border rounded-2xl p-5 text-center">
          <p className="text-sm text-theme-dark-text/70">{t('dungeonList.noneAvailable')}</p>
        </div>
      ) : (
        exclusiveTiers.map(([threshold, tierDungeons]) => (
          <div key={threshold} className="flex flex-col gap-3">
            <p className="text-xs font-medium text-theme-dark-text/60 px-1">
              {t('dungeonList.tierHeader', { threshold, current: lifetimeDeposit })}
            </p>
            {tierDungeons.map(renderDungeonCard)}
          </div>
        ))
      )}
    </div>
  )
}

export default DungeonList
