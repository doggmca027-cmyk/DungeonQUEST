import { useCallback, useEffect, useState } from 'react'
import { TonConnectButton, useTonAddress, useTonConnectUI } from '@tonconnect/ui-react'
import { supabase } from '../supabaseClient'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

const PROJECT_WALLET_ADDRESS = import.meta.env.VITE_PROJECT_WALLET_ADDRESS
const MIN_WITHDRAWAL_GRAM = 0.5
const WITHDRAWAL_FEE_RATE = 0.1

function Wallet() {
  const [user] = useState(() => tg?.initDataUnsafe?.user ?? null)
  const tonAddress = useTonAddress()
  const [tonConnectUI] = useTonConnectUI()

  const [balance, setBalance] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const [depositAmount, setDepositAmount] = useState('')
  const [depositBusy, setDepositBusy] = useState(false)

  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawBusy, setWithdrawBusy] = useState(false)

  const refreshBalance = useCallback(async () => {
    if (!user) return
    const { data, error: balErr } = await supabase
      .from('users')
      .select('gram_balance')
      .eq('id', user.id)
      .single()
    if (balErr) throw balErr
    setBalance(data?.gram_balance ?? 0)
  }, [user])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        await refreshBalance()
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
  }, [refreshBalance])

  useEffect(() => {
    if (!user || !tonAddress) return
    let cancelled = false

    async function saveWalletAddress() {
      const { error: updErr } = await supabase
        .from('users')
        .update({ wallet_address: tonAddress })
        .eq('id', user.id)
      if (updErr && !cancelled) setError(updErr.message)
    }

    saveWalletAddress()
    return () => {
      cancelled = true
    }
  }, [user, tonAddress])

  async function handleDeposit() {
    const amount = Number(depositAmount)
    if (!user || !tonAddress || !amount || amount <= 0) return

    setDepositBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [
          {
            address: PROJECT_WALLET_ADDRESS,
            amount: String(Math.round(amount * 1e9)),
          },
        ],
      })
      if (!result?.boc) throw new Error('Транзакция не была отправлена')

      const { error: rpcErr } = await supabase.rpc('apply_deposit', {
        p_ton_amount: amount,
      })
      if (rpcErr) throw rpcErr

      setNotice(`Баланс пополнен на ${amount} GRAM`)
      setDepositAmount('')
      await refreshBalance()
    } catch (err) {
      setError(err.message)
    } finally {
      setDepositBusy(false)
    }
  }

  async function handleWithdraw() {
    const amount = Number(withdrawAmount)
    if (!user || !amount) return
    if (amount < MIN_WITHDRAWAL_GRAM) {
      setError(`Минимальная сумма вывода — ${MIN_WITHDRAWAL_GRAM} GRAM`)
      return
    }

    setWithdrawBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { error: rpcErr } = await supabase.rpc('request_withdrawal', {
        p_amount_gram: amount,
      })
      if (rpcErr) throw rpcErr

      setNotice('Заявка на вывод создана и ожидает обработки')
      setWithdrawAmount('')
      await refreshBalance()
    } catch (err) {
      setError(err.message)
    } finally {
      setWithdrawBusy(false)
    }
  }

  const withdrawAmountNumber = Number(withdrawAmount) || 0
  const withdrawFinalAmount =
    withdrawAmountNumber > 0 ? withdrawAmountNumber * (1 - WITHDRAWAL_FEE_RATE) : 0

  if (!user) {
    return (
      <p className="text-sm text-theme-dark-text/70">
        Откройте приложение через Telegram, чтобы управлять кошельком.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4 text-left">
      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-base">Кошелёк</h3>
          <TonConnectButton />
        </div>
        <p className="text-sm text-theme-dark-text/70">
          Баланс: {loading ? '…' : `${balance} GRAM`}
        </p>
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

      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <h3 className="font-semibold text-base">Пополнение</h3>
        <input
          type="number"
          min="0"
          step="0.01"
          value={depositAmount}
          onChange={(e) => setDepositAmount(e.target.value)}
          placeholder="Сумма в TON"
          className="rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={handleDeposit}
          disabled={!tonAddress || depositBusy || !Number(depositAmount)}
          className="rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {depositBusy ? 'Отправка…' : 'Пополнить'}
        </button>
        {!tonAddress && (
          <p className="text-xs text-theme-dark-text/60">
            Подключите кошелёк, чтобы пополнить баланс.
          </p>
        )}
      </div>

      <div className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3">
        <h3 className="font-semibold text-base">Вывод</h3>
        <input
          type="number"
          min={MIN_WITHDRAWAL_GRAM}
          step="0.01"
          value={withdrawAmount}
          onChange={(e) => setWithdrawAmount(e.target.value)}
          placeholder={`Сумма в GRAM (мин. ${MIN_WITHDRAWAL_GRAM})`}
          className="rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm"
        />
        {withdrawAmountNumber > 0 && (
          <p className="text-xs text-theme-dark-text/60">
            Комиссия 10% · к выплате: {withdrawFinalAmount.toFixed(2)} GRAM
          </p>
        )}
        <button
          type="button"
          onClick={handleWithdraw}
          disabled={withdrawBusy || withdrawAmountNumber < MIN_WITHDRAWAL_GRAM}
          className="rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-dark-text text-theme-card disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {withdrawBusy ? 'Отправка…' : 'Вывести'}
        </button>
      </div>
    </div>
  )
}

export default Wallet
