import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  TonClient,
  WalletContractV5R1,
  WalletContractV4,
  WalletContractV3R2,
  WalletContractV3R1,
  internal,
} from 'npm:@ton/ton@^15'
import { mnemonicToPrivateKey } from 'npm:@ton/crypto@^3'
import { Address, toNano } from 'npm:@ton/core@^0.63.1'

const MNEMONIC = Deno.env.get('PROJECT_WALLET_MNEMONIC')!
const TONCENTER_API_KEY = Deno.env.get('TONCENTER_API_KEY')!
const PROJECT_WALLET_ADDRESS = Deno.env.get('PROJECT_WALLET_ADDRESS')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const ADMIN_TELEGRAM_ID = 6288342755

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

// Tries each common wallet contract version until one derives to the same
// address as PROJECT_WALLET_ADDRESS -- we don't know offhand which version
// the project wallet was actually deployed as, and getting it wrong means
// signing with a contract that doesn't match the funded account at all.
function resolveWallet(publicKey: Uint8Array) {
  const target = Address.parse(PROJECT_WALLET_ADDRESS)
  const candidates = [
    () => WalletContractV5R1.create({ workchain: 0, publicKey }),
    () => WalletContractV4.create({ workchain: 0, publicKey }),
    () => WalletContractV3R2.create({ workchain: 0, publicKey }),
    () => WalletContractV3R1.create({ workchain: 0, publicKey }),
  ]

  for (const build of candidates) {
    try {
      const wallet = build()
      if (wallet.address.equals(target)) return wallet
    } catch {
      // unsupported export in this package version -- skip and try the next
    }
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  let claimedWithdrawalId: string | null = null

  try {
    const payload = decodeJwtPayload(req.headers.get('Authorization'))
    const callerId = payload?.telegram_id
    if (!callerId || Number(callerId) !== ADMIN_TELEGRAM_ID) {
      return jsonResponse({ success: false, message: 'Unauthorized' }, 401)
    }

    const { withdrawal_id: withdrawalId } = await req.json()
    if (!withdrawalId) {
      return jsonResponse({ success: false, message: 'Missing withdrawal_id' }, 400)
    }

    // Atomic claim -- guards against double-click / retry double-sends.
    const { data: claimed, error: claimErr } = await admin
      .from('withdrawals')
      .update({ status: 'processing' })
      .eq('id', withdrawalId)
      .eq('status', 'pending')
      .select()
      .single()

    if (claimErr || !claimed) {
      return jsonResponse({ success: false, message: 'already_processed' })
    }
    claimedWithdrawalId = claimed.id

    const keyPair = await mnemonicToPrivateKey(MNEMONIC.trim().split(/\s+/))
    const wallet = resolveWallet(keyPair.publicKey)

    if (!wallet) {
      throw new Error(
        'Не удалось определить версию кошелька по мнемонике (адрес не совпал ни с одним вариантом)',
      )
    }

    const client = new TonClient({
      endpoint: 'https://toncenter.com/api/v2/jsonRPC',
      apiKey: TONCENTER_API_KEY,
    })
    const contract = client.open(wallet)
    const seqno = await contract.getSeqno()

    await contract.sendTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      messages: [
        internal({
          to: claimed.wallet_address,
          value: toNano(String(claimed.final_amount)),
          body: `DungeonQuest withdrawal #${claimed.id}`,
          bounce: false,
        }),
      ],
    })

    const { error: finalizeErr } = await admin
      .from('withdrawals')
      .update({ status: 'approved', processed_at: new Date().toISOString() })
      .eq('id', claimed.id)
    if (finalizeErr) throw finalizeErr

    return jsonResponse({ success: true })
  } catch (err) {
    if (claimedWithdrawalId) {
      await admin
        .from('withdrawals')
        .update({ status: 'pending' })
        .eq('id', claimedWithdrawalId)
        .eq('status', 'processing')
    }
    return jsonResponse(
      { success: false, message: err instanceof Error ? err.message : 'Ошибка отправки выплаты' },
      500,
    )
  }
})
