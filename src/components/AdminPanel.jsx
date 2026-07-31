import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

// Accepts "https://t.me/username", "t.me/username", or "@username" and
// returns a canonical "https://t.me/username" link, so task.link is always
// a valid href for the "Перейти в канал" button.
function normalizeChannelLink(input) {
  if (!input) return null
  const username = input
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^@/, '')
    .split(/[/?]/)[0]
  return username ? `https://t.me/${username}` : null
}

function AdminPanel() {
  const [withdrawals, setWithdrawals] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [resetBusy, setResetBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const [taskTitle, setTaskTitle] = useState('')
  const [taskReward, setTaskReward] = useState('')
  const [taskLink, setTaskLink] = useState('')
  const [taskBusy, setTaskBusy] = useState(false)

  const [minWithdrawal, setMinWithdrawal] = useState('')
  const [feeRatePercent, setFeeRatePercent] = useState('')
  const [seasonEndAt, setSeasonEndAt] = useState('')
  const [settingsBusy, setSettingsBusy] = useState(false)

  const [creditTelegramId, setCreditTelegramId] = useState('')
  const [creditAmount, setCreditAmount] = useState('')
  const [creditBusy, setCreditBusy] = useState(false)

  const refresh = useCallback(async () => {
    const [{ data, error: fetchErr }, { data: settingsData, error: settingsErr }] = await Promise.all([
      supabase.from('withdrawals').select('*').eq('status', 'pending'),
      supabase.from('app_settings').select('key, value'),
    ])
    if (fetchErr) throw fetchErr
    if (settingsErr) throw settingsErr
    setWithdrawals(data ?? [])

    const settings = Object.fromEntries((settingsData ?? []).map((row) => [row.key, row.value]))
    if (settings.min_withdrawal_gram) setMinWithdrawal(settings.min_withdrawal_gram)
    if (settings.withdrawal_fee_rate) {
      setFeeRatePercent(String(Number(settings.withdrawal_fee_rate) * 100))
    }
    if (settings.season_end_at) {
      setSeasonEndAt(new Date(settings.season_end_at).toISOString().slice(0, 16))
    }
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
      const { data, error: fnErr } = await supabase.functions.invoke('send-withdrawal-payout', {
        body: { withdrawal_id: withdrawal.id },
      })
      if (fnErr) throw fnErr
      if (!data?.success) throw new Error(data?.message ?? 'Не удалось отправить выплату')
      setNotice('Выплата отправлена, заявка подтверждена')
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
    if (!tg) return

    tg.showConfirm(
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

  async function handleCreateTask() {
    const link = normalizeChannelLink(taskLink)
    if (!taskTitle.trim() || !link) {
      setError('Укажите название и ссылку вида https://t.me/username или @username')
      return
    }

    setTaskBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { error: rpcErr } = await supabase.rpc('create_task', {
        p_title: taskTitle.trim(),
        p_reward_gram: Number(taskReward) || 0,
        p_link: link,
      })
      if (rpcErr) throw rpcErr

      setNotice('Задание создано')
      setTaskTitle('')
      setTaskReward('')
      setTaskLink('')
    } catch (err) {
      setError(err.message)
    } finally {
      setTaskBusy(false)
    }
  }

  async function handleSaveSettings() {
    setSettingsBusy(true)
    setError(null)
    setNotice(null)
    try {
      const feeRateDecimal = Number(feeRatePercent) / 100
      const seasonEndIso = seasonEndAt ? new Date(seasonEndAt).toISOString() : null

      const updates = [
        ['min_withdrawal_gram', String(Number(minWithdrawal))],
        ['withdrawal_fee_rate', String(feeRateDecimal)],
      ]
      if (seasonEndIso) updates.push(['season_end_at', seasonEndIso])

      for (const [key, value] of updates) {
        const { error: rpcErr } = await supabase.rpc('update_app_setting', {
          p_key: key,
          p_value: value,
        })
        if (rpcErr) throw rpcErr
      }

      setNotice('Настройки сохранены')
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setSettingsBusy(false)
    }
  }

  async function handleCreditBalance() {
    const telegramId = Number(creditTelegramId)
    const amount = Number(creditAmount)
    if (!telegramId || !amount) {
      setError('Укажите корректные Telegram ID и сумму')
      return
    }

    setCreditBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { error: rpcErr } = await supabase.rpc('admin_credit_balance', {
        p_target_telegram_id: telegramId,
        p_amount: amount,
      })
      if (rpcErr) throw rpcErr

      setNotice(`Начислено ${amount} GRAM игроку ${telegramId}`)
      setCreditTelegramId('')
      setCreditAmount('')
    } catch (err) {
      setError(err.message)
    } finally {
      setCreditBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 text-left">
      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <h3 className="font-semibold text-base">Новое задание</h3>
        <input
          type="text"
          value={taskTitle}
          onChange={(e) => setTaskTitle(e.target.value)}
          placeholder="Название задания"
          className="rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm"
        />
        <input
          type="number"
          min="0"
          step="0.01"
          value={taskReward}
          onChange={(e) => setTaskReward(e.target.value)}
          placeholder="Награда, GRAM"
          className="rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={taskLink}
          onChange={(e) => setTaskLink(e.target.value)}
          placeholder="https://t.me/username или @username"
          className="rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={handleCreateTask}
          disabled={taskBusy}
          className="rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {taskBusy ? 'Создание…' : 'Создать задание'}
        </button>
      </div>

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

      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <h3 className="font-semibold text-base">Настройки</h3>
        <label className="text-xs text-theme-dark-text/60">
          Мин. сумма вывода, GRAM
          <input
            type="number"
            min="0"
            step="0.01"
            value={minWithdrawal}
            onChange={(e) => setMinWithdrawal(e.target.value)}
            className="mt-1 w-full rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm text-theme-dark-text"
          />
        </label>
        <label className="text-xs text-theme-dark-text/60">
          Комиссия вывода, %
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={feeRatePercent}
            onChange={(e) => setFeeRatePercent(e.target.value)}
            className="mt-1 w-full rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm text-theme-dark-text"
          />
        </label>
        <label className="text-xs text-theme-dark-text/60">
          Конец сезона
          <input
            type="datetime-local"
            value={seasonEndAt}
            onChange={(e) => setSeasonEndAt(e.target.value)}
            className="mt-1 w-full rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm text-theme-dark-text"
          />
        </label>
        <button
          type="button"
          onClick={handleSaveSettings}
          disabled={settingsBusy}
          className="rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {settingsBusy ? 'Сохранение…' : 'Сохранить настройки'}
        </button>
      </div>

      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <h3 className="font-semibold text-base">Выдать баланс</h3>
        <input
          type="text"
          inputMode="numeric"
          value={creditTelegramId}
          onChange={(e) => setCreditTelegramId(e.target.value)}
          placeholder="Telegram ID игрока"
          className="rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm"
        />
        <input
          type="number"
          step="0.01"
          value={creditAmount}
          onChange={(e) => setCreditAmount(e.target.value)}
          placeholder="Сумма, GRAM"
          className="rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={handleCreditBalance}
          disabled={creditBusy}
          className="rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {creditBusy ? 'Начисление…' : 'Начислить'}
        </button>
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
                  <span className="text-theme-dark-text/60">
                    К выплате (-{Math.round((1 - w.final_amount / w.amount_gram) * 100)}%):{' '}
                  </span>
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
                    {isBusy ? 'Отправка…' : 'Подтвердить'}
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
