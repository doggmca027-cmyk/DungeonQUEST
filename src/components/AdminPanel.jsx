import { useCallback, useEffect, useState } from 'react'
import WebApp from '@twa-dev/sdk'
import { supabase } from '../supabaseClient'

function AdminPanel() {
  const [withdrawals, setWithdrawals] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [resetBusy, setResetBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const refresh = useCallback(async () => {
    const { data, error: fetchErr } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('status', 'pending')
    if (fetchErr) throw fetchErr
    setWithdrawals(data ?? [])
  }, [])

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

  async function handleApprove(withdrawal) {
    setBusyId(withdrawal.id)
    setError(null)
    setNotice(null)
    try {
      const { error: rpcErr } = await supabase.rpc('approve_withdrawal', {
        p_withdrawal_id: withdrawal.id,
      })
      if (rpcErr) throw rpcErr
      setNotice('Заявка подтверждена')
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleReject(withdrawal) {
    setBusyId(withdrawal.id)
    setError(null)
    setNotice(null)
    try {
      const { error: rpcErr } = await supabase.rpc('reject_withdrawal', {
        p_withdrawal_id: withdrawal.id,
      })
      if (rpcErr) throw rpcErr
      setNotice('Заявка отклонена, средства возвращены игроку')
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  function handleResetSeason() {
    WebApp.showConfirm(
      'Точно хотите сбросить сезон? Это действие необратимо.',
      async (confirmed) => {
        if (!confirmed) return
        setResetBusy(true)
        setError(null)
        setNotice(null)
        try {
          const { error: rpcErr } = await supabase.rpc('reset_season_admin')
          if (rpcErr) throw rpcErr
          setNotice('Сезон сброшен')
          await refresh()
        } catch (err) {
          setError(err.message)
        } finally {
          setResetBusy(false)
        }
      },
    )
  }

  return (
    <div className="flex flex-col gap-4 text-left">
      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-base">Управление сезоном</h3>
          <button
            type="button"
            onClick={handleResetSeason}
            disabled={resetBusy}
            className="rounded-2xl px-3 py-2 text-sm font-semibold bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {resetBusy ? 'Сброс…' : 'Сбросить сезон'}
          </button>
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

      <div className="flex flex-col gap-3">
        <h3 className="font-semibold text-base">Заявки на вывод</h3>
        {loading ? (
          <p className="text-sm text-theme-dark-text/70">Загрузка заявок…</p>
        ) : withdrawals.length === 0 ? (
          <p className="text-sm text-theme-dark-text/70">Нет заявок в ожидании.</p>
        ) : (
          withdrawals.map((w) => {
            const isBusy = busyId === w.id
            return (
              <div
                key={w.id}
                className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-2"
              >
                <p className="text-sm">
                  <span className="text-theme-dark-text/60">Telegram ID: </span>
                  <span className="font-semibold">{w.user_id}</span>
                </p>
                <p className="text-sm">
                  <span className="text-theme-dark-text/60">Запрошено: </span>
                  <span className="font-semibold">{w.amount_gram} GRAM</span>
                </p>
                <p className="text-sm">
                  <span className="text-theme-dark-text/60">К выплате (-10%): </span>
                  <span className="font-semibold text-theme-accent">{w.final_amount} GRAM</span>
                </p>
                <p className="text-sm break-all">
                  <span className="text-theme-dark-text/60">Кошелёк: </span>
                  <span className="font-mono text-xs">{w.wallet_address}</span>
                </p>

                <div className="flex gap-2 mt-1">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleApprove(w)}
                    className="flex-1 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Подтвердить
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleReject(w)}
                    className="flex-1 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-dark-text text-theme-card disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Отклонить
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export default AdminPanel
