import { useCallback, useEffect, useState } from 'react'
import { Swords } from 'lucide-react'
import { supabase } from '../supabaseClient'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

function Home({ onNavigateToExpedition }) {
  const [user] = useState(() => tg?.initDataUnsafe?.user ?? null)
  const [balance, setBalance] = useState(0)
  const [activeExpeditions, setActiveExpeditions] = useState([])
  const [dungeonNames, setDungeonNames] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!user) return
    const [
      { data: userData, error: userErr },
      { data: expeditionsData, error: expErr },
      { data: dungeonsData, error: dungeonsErr },
    ] = await Promise.all([
      supabase.from('users').select('gram_balance').eq('id', user.id).single(),
      supabase.from('expeditions').select('*').eq('user_id', user.id).eq('is_claimed', false),
      supabase.from('dungeons').select('id, name'),
    ])
    if (userErr) throw userErr
    if (expErr) throw expErr
    if (dungeonsErr) throw dungeonsErr

    setBalance(userData?.gram_balance ?? 0)
    setActiveExpeditions(expeditionsData ?? [])
    setDungeonNames(Object.fromEntries((dungeonsData ?? []).map((d) => [d.id, d.name])))
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

  if (!user) {
    return (
      <p className="text-sm text-theme-dark-text/70">
        Откройте приложение через Telegram, чтобы увидеть профиль.
      </p>
    )
  }

  const nearestExpedition = activeExpeditions[0] ?? null

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
