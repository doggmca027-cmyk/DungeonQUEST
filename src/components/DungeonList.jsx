import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

function formatCountdown(ms) {
  if (ms <= 0) return 'Поход завершён'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function DungeonList() {
  const [user] = useState(() => tg?.initDataUnsafe?.user ?? null)
  const [dungeons, setDungeons] = useState([])
  const [expeditions, setExpeditions] = useState([])
  const [balance, setBalance] = useState(0)
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
    const [{ data: expeditionsData, error: expErr }, { data: userData, error: userErr }] = await Promise.all([
      supabase.from('expeditions').select('*').eq('user_id', user.id).eq('is_claimed', false),
      supabase.from('users').select('gram_balance').eq('id', user.id).single(),
    ])
    if (expErr) throw expErr
    if (userErr) throw userErr
    setExpeditions(expeditionsData ?? [])
    setBalance(userData?.gram_balance ?? 0)
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
        if (!cancelled) setError(err.message ?? 'Не удалось загрузить подземелья')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [refresh])

  const expeditionGroups = useMemo(() => {
    const map = {}
    for (const exp of expeditions) {
      if (!map[exp.dungeon_id]) map[exp.dungeon_id] = []
      map[exp.dungeon_id].push(exp)
    }
    return map
  }, [expeditions])

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
      if (!data?.success) throw new Error(data?.message ?? 'Не удалось отправиться в поход')

      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleBoost(expedition, targetHours) {
    setBusyId(expedition.dungeon_id)
    setError(null)
    try {
      const { data, error: rpcErr } = await supabase.rpc('use_booster', {
        p_expedition_id: expedition.id,
        p_target_hours: targetHours,
      })
      if (rpcErr) throw rpcErr
      if (!data?.success) throw new Error(data?.message ?? 'Не удалось ускорить поход')

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
        if (!data?.success) throw new Error(data?.message ?? 'Не удалось забрать лут')
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
      <p className="text-sm text-theme-dark-text/70">
        Откройте приложение через Telegram, чтобы отправляться в походы.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="text-sm text-red-700 bg-red-100 border border-red-300 rounded-2xl px-3 py-2">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-theme-dark-text/70">Загрузка подземелий…</p>
      ) : dungeons.length === 0 ? (
        <div className="bg-theme-card border border-theme-card-border rounded-2xl p-5 text-center">
          <p className="text-sm text-theme-dark-text/70">Нет доступных подземелий</p>
        </div>
      ) : (
        dungeons.map((dungeon) => {
          const group = expeditionGroups[dungeon.id] ?? []
          const activeCount = group.reduce((sum, e) => sum + e.active_count, 0)
          const inProgress = group.find((e) => new Date(e.end_time).getTime() > now)
          const readyToClaim = group.length > 0 && !inProgress
          const totalReward = group.reduce((sum, e) => sum + e.reward_per_unit * e.active_count, 0)
          const msLeft = inProgress ? new Date(inProgress.end_time).getTime() - now : 0
          const isBusy = busyId === dungeon.id
          const canEnter = !readyToClaim && balance >= dungeon.entry_cost_gram && !isBusy
          const canClaim = readyToClaim && !isBusy

          const startMs = inProgress ? new Date(inProgress.start_time).getTime() : null
          const canBoost6 =
            inProgress && startMs + 6 * 60 * 60 * 1000 < new Date(inProgress.end_time).getTime()
          const canBoost9 =
            inProgress && startMs + 9 * 60 * 60 * 1000 < new Date(inProgress.end_time).getTime()

          return (
            <div
              key={dungeon.id}
              className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3 text-left"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-base">{dungeon.name}</h3>
                {activeCount > 0 && (
                  <span className="shrink-0 text-xs font-medium text-theme-accent bg-theme-accent/10 px-2.5 py-1 rounded-full">
                    Активно походов: {activeCount}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <span className="inline-flex items-center rounded-full bg-theme-bg/15 border border-theme-card-border px-3 py-1 text-xs font-medium text-theme-accent">
                  Поход за {dungeon.entry_cost_gram} GRAM
                </span>
                <span className="inline-flex items-center rounded-full bg-theme-bg/15 border border-theme-card-border px-3 py-1 text-xs font-medium text-theme-accent">
                  {dungeon.duration_hours} часов в пути
                </span>
              </div>

              {group.length > 0 && (
                <p className="text-xs text-theme-dark-text/70">
                  {readyToClaim
                    ? `Лут ждёт: ${totalReward} GRAM`
                    : `В пути, осталось: ${formatCountdown(msLeft)}`}
                </p>
              )}

              {(canBoost6 || canBoost9) && (
                <div className="flex gap-2">
                  {canBoost6 && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleBoost(inProgress, 6)}
                      className="flex-1 rounded-2xl px-3 py-2 text-xs font-semibold bg-theme-bg/15 border border-theme-card-border text-theme-accent disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Ускорить до 6ч
                    </button>
                  )}
                  {canBoost9 && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleBoost(inProgress, 9)}
                      className="flex-1 rounded-2xl px-3 py-2 text-xs font-semibold bg-theme-bg/15 border border-theme-card-border text-theme-accent disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Ускорить до 9ч
                    </button>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!canEnter}
                  onClick={() => handleEnter(dungeon)}
                  className="flex-1 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  В поход
                </button>
                {group.length > 0 && (
                  <button
                    type="button"
                    disabled={!canClaim}
                    onClick={() => handleClaim(dungeon.id, group)}
                    className="flex-1 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-dark-text text-theme-card disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Забрать лут
                  </button>
                )}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

export default DungeonList
