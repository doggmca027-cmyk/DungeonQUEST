import { useCallback, useEffect, useState } from 'react'
import { TonConnectButton, useTonAddress, useTonConnectUI } from '@tonconnect/ui-react'
import { beginCell } from '@ton/core'
import { supabase } from '../supabaseClient'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

const PROJECT_WALLET_ADDRESS = import.meta.env.VITE_PROJECT_WALLET_ADDRESS
const DEFAULT_MIN_WITHDRAWAL_GRAM = 0.5
const DEFAULT_WITHDRAWAL_FEE_RATE = 0.1
const PENDING_DEPOSIT_KEY = 'dungeonquest_pending_deposit'
const PENDING_MAX_AGE_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 4000
const POLL_MAX_ATTEMPTS = 30

function buildCommentPayload(comment) {
  return beginCell().storeUint(0, 32).storeStringTail(comment).endCell().toBoc().toString('base64')
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

  const [minWithdrawal, setMinWithdrawal] = useState(DEFAULT_MIN_WITHDRAWAL_GRAM)
  const [feeRate, setFeeRate] = useState(DEFAULT_WITHDRAWAL_FEE_RATE)

  const [verifying, setVerifying] = useState(false)

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

      try {
        const { data, error: settingsErr } = await supabase
          .from('app_settings')
          .select('key, value')
          .in('key', ['min_withdrawal_gram', 'withdrawal_fee_rate'])
        if (settingsErr) throw settingsErr
        if (cancelled) return
        const settings = Object.fromEntries((data ?? []).map((row) => [row.key, row.value]))
        if (settings.min_withdrawal_gram) setMinWithdrawal(Number(settings.min_withdrawal_gram))
        if (settings.withdrawal_fee_rate) setFeeRate(Number(settings.withdrawal_fee_rate))
      } catch (err) {
        console.error('Failed to load withdrawal settings, using defaults:', err)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [refreshBalance])

  // Never credits from the client's own report -- polls the backend, which
  // only credits once it independently finds a matching, verified incoming
  // transaction on-chain via TonAPI (see verify-ton-payment Edge Function).
  // submittedAt scopes the search to this deposit attempt, so a repeat
  // deposit for the same amount can't get "confirmed" by matching an older,
  // already-credited transaction (comment is always just the Telegram ID,
  // so it alone doesn't distinguish separate deposits).
  const pollForDeposit = useCallback(async (expectedAmount, submittedAt) => {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      try {
        const { data, error: fnErr } = await supabase.functions.invoke('verify-ton-payment', {
          body: { expected_amount: expectedAmount, submitted_at: submittedAt },
        })
        if (fnErr) throw fnErr
        if (data?.credited) return true
      } catch (err) {
        // A single transient failure (network blip, cold start) shouldn't
        // abort the whole 2-minute check -- log it and keep polling.
        console.error('verify-ton-payment attempt failed:', err)
      }
      await wait(POLL_INTERVAL_MS)
    }
    return false
  }, [])

  // Resumes checking a deposit whose transaction was sent but whose
  // verification never finished (e.g. the user left the Wallet tab before
  // polling completed). Safe to repeat -- verify-ton-payment only ever
  // credits a given on-chain transaction once.
  useEffect(() => {
    if (!user) return
    const raw = localStorage.getItem(PENDING_DEPOSIT_KEY)
    if (!raw) return
    let cancelled = false

    async function resumePendingDeposit() {
      try {
        const { amount, submittedAt } = JSON.parse(raw)
        if (Date.now() - submittedAt > PENDING_MAX_AGE_MS) {
          localStorage.removeItem(PENDING_DEPOSIT_KEY)
          return
        }
        if (cancelled) return
        setVerifying(true)
        setNotice('Проверяем зачисление предыдущей транзакции…')
        const credited = await pollForDeposit(amount, submittedAt)
        if (cancelled) return
        if (credited) {
          localStorage.removeItem(PENDING_DEPOSIT_KEY)
          setNotice(`Баланс пополнен на ${amount} GRAM`)
          await refreshBalance()
        } else {
          setNotice(null)
        }
      } catch (err) {
        console.error('Failed to resume pending deposit check:', err)
      } finally {
        if (!cancelled) setVerifying(false)
      }
    }

    resumePendingDeposit()
    return () => {
      cancelled = true
    }
  }, [user, pollForDeposit, refreshBalance])

  useEffect(() => {
    if (!user || !tonAddress) return
    let cancelled = false

    async function saveWalletAddress() {
      const { error: rpcErr } = await supabase.rpc('save_wallet_address', {
        p_wallet_address: tonAddress,
      })
      if (rpcErr && !cancelled) setError(rpcErr.message)
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
      const payload = buildCommentPayload(String(user.id))

      const result = await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [
          {
            address: PROJECT_WALLET_ADDRESS,
            amount: String(Math.round(amount * 1e9)),
            payload,
          },
        ],
      })
      if (!result?.boc) throw new Error('Транзакция не была отправлена')

      const submittedAt = Date.now()
      localStorage.setItem(PENDING_DEPOSIT_KEY, JSON.stringify({ amount, submittedAt }))
      setVerifying(true)
      setNotice('Транзакция отправлена в сеть, проверяем зачисление…')

      const credited = await pollForDeposit(amount, submittedAt)

      if (credited) {
        localStorage.removeItem(PENDING_DEPOSIT_KEY)
        setNotice(`Баланс пополнен на ${amount} GRAM`)
        setDepositAmount('')
        await refreshBalance()
      } else {
        setNotice('Транзакция ещё обрабатывается сетью — баланс обновится автоматически')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setDepositBusy(false)
      setVerifying(false)
    }
  }

  async function handleWithdraw() {
    const amount = Number(withdrawAmount)
    if (!user || !amount) return
    if (amount < minWithdrawal) {
      setError(`Минимальная сумма вывода — ${minWithdrawal} GRAM`)
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
    withdrawAmountNumber > 0 ? withdrawAmountNumber * (1 - feeRate) : 0

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
          {verifying ? 'Проверяем зачисление…' : depositBusy ? 'Отправка…' : 'Пополнить'}
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
          min={minWithdrawal}
          step="0.01"
          value={withdrawAmount}
          onChange={(e) => setWithdrawAmount(e.target.value)}
          placeholder={`Сумма в GRAM (мин. ${minWithdrawal})`}
          className="rounded-2xl border border-theme-card-border bg-white px-3 py-2 text-sm"
        />
        {withdrawAmountNumber > 0 && (
          <p className="text-xs text-theme-dark-text/60">
            Комиссия {Math.round(feeRate * 100)}% · к выплате: {withdrawFinalAmount.toFixed(2)} GRAM
          </p>
        )}
        <button
          type="button"
          onClick={handleWithdraw}
          disabled={withdrawBusy || withdrawAmountNumber < minWithdrawal}
          className="rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-dark-text text-theme-card disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {withdrawBusy ? 'Отправка…' : 'Вывести'}
        </button>
      </div>
    </div>
  )
}

export default Wallet
