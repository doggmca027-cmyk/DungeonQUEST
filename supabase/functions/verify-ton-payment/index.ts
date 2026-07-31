import { createClient } from 'npm:@supabase/supabase-js@2'

const TONAPI_KEY = Deno.env.get('TONAPI_KEY')!
const PROJECT_WALLET_ADDRESS = Deno.env.get('PROJECT_WALLET_ADDRESS')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function decodeJwtPayload(authHeader: string | null): Record<string, unknown> | null {
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  const payloadPart = token?.split('.')[1]
  if (!payloadPart) return null
  const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  return JSON.parse(atob(padded))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  try {
    const payload = decodeJwtPayload(req.headers.get('Authorization'))
    const telegramId = payload?.telegram_id
    if (!telegramId) {
      return jsonResponse({ credited: false, message: 'Unauthorized' }, 401)
    }

    const { expected_amount: expectedAmount, submitted_at: submittedAt } = await req.json()
    if (!expectedAmount || Number(expectedAmount) <= 0) {
      return jsonResponse({ credited: false, message: 'Missing expected_amount' }, 400)
    }
    const expectedNanotons = Math.round(Number(expectedAmount) * 1e9)
    // Only consider transactions from this deposit attempt onward -- without
    // this, a repeat deposit for the same amount (same comment, since it's
    // always just the Telegram ID) could match an older, already-credited
    // transaction instead of the new one.
    const CLOCK_SKEW_BUFFER_SECONDS = 60
    const sinceSeconds = submittedAt
      ? Math.floor(Number(submittedAt) / 1000) - CLOCK_SKEW_BUFFER_SECONDS
      : 0

    const tonRes = await fetch(
      `https://tonapi.io/v2/accounts/${PROJECT_WALLET_ADDRESS}/events?limit=50`,
      { headers: { Authorization: `Bearer ${TONAPI_KEY}` } },
    )
    if (!tonRes.ok) {
      return jsonResponse({ credited: false, pending: true, message: 'TonAPI unavailable' })
    }
    const tonData = await tonRes.json()

    let match: { txHash: string; amountTon: number } | null = null

    for (const event of tonData.events ?? []) {
      if (typeof event.timestamp === 'number' && event.timestamp < sinceSeconds) continue

      for (const action of event.actions ?? []) {
        if (action.type !== 'TonTransfer') continue
        const transfer = action.TonTransfer
        if (!transfer) continue

        const comment = transfer.comment ?? ''
        const amountNanotons = Number(transfer.amount ?? 0)

        if (comment === String(telegramId) && amountNanotons >= expectedNanotons) {
          match = {
            txHash: event.event_id ?? event.lt ?? `${event.timestamp}-${telegramId}`,
            amountTon: amountNanotons / 1e9,
          }
          break
        }
      }
      if (match) break
    }

    if (!match) {
      return jsonResponse({ credited: false, pending: true })
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data, error: rpcErr } = await admin.rpc('credit_verified_deposit', {
      p_user_id: telegramId,
      p_tx_hash: match.txHash,
      p_amount: match.amountTon,
    })
    if (rpcErr) throw rpcErr

    // already_processed just means an earlier poll already credited this
    // same transaction -- still a "yes, it's credited" from the caller's
    // point of view.
    if (!data?.success && data?.message !== 'already_processed') {
      return jsonResponse({ credited: false, pending: true })
    }

    return jsonResponse({ credited: true, amount: match.amountTon })
  } catch (err) {
    return jsonResponse(
      { credited: false, message: err instanceof Error ? err.message : 'Ошибка проверки' },
      500,
    )
  }
})
