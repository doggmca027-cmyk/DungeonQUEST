import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  TonClient,
  WalletContractV5R1,
  WalletContractV4,
  WalletContractV3R2,
  WalletContractV3R1,
  internal,
} from 'npm:@ton/ton@^15'
import { mnemonicToPrivateKey, mnemonicValidate } from 'npm:@ton/crypto@^3'
import { Address, toNano } from 'npm:@ton/core@^0.63.1'

const MNEMONIC = Deno.env.get('PROJECT_WALLET_MNEMONIC')!
const TONCENTER_API_KEY = Deno.env.get('TONCENTER_API_KEY')!
const TONAPI_KEY = Deno.env.get('TONAPI_KEY')!
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

// Diagnostic only: the wallet is already deployed and active on-chain (it's
// received real deposits), so TonAPI can just tell us its actual contract
// interface directly instead of us having to guess-and-check.
async function fetchWalletInterfaces(): Promise<string[]> {
  try {
    const res = await fetch(`https://tonapi.io/v2/accounts/${PROJECT_WALLET_ADDRESS}`, {
      headers: { Authorization: `Bearer ${TONAPI_KEY}` },
    })
    const data = await res.json()
    return data.interfaces ?? []
  } catch (err) {
    console.error('Failed to fetch wallet interfaces from TonAPI:', err)
    return []
  }
}

// Tries each common wallet contract version until one derives to the same
// address as PROJECT_WALLET_ADDRESS -- we don't know offhand which version
// the project wallet was actually deployed as, and getting it wrong means
// signing with a contract that doesn't match the funded account at all.
function resolveWallet(publicKey: Uint8Array) {
  const target = Address.parse(PROJECT_WALLET_ADDRESS)
  console.log('Target address (raw):', target.toRawString())
  console.log('Target address (friendly):', target.toString())

  const candidates = [
    ['V5R1', () => WalletContractV5R1.create({ workchain: 0, publicKey })],
    ['V4', () => WalletContractV4.create({ workchain: 0, publicKey })],
    ['V3R2', () => WalletContractV3R2.create({ workchain: 0, publicKey })],
    ['V3R1', () => WalletContractV3R1.create({ workchain: 0, publicKey })],
  ] as const

  for (const [name, build] of candidates) {
    try {
      const wallet = build()
      console.log(`Candidate ${name} address:`, wallet.address.toRawString())
      if (wallet.address.equals(target)) return wallet
    } catch (err) {
      console.error(`Candidate ${name} failed to build:`, err instanceof Error ? err.message : err)
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
  let transferSent = false

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

    const interfaces = await fetchWalletInterfaces()
    console.log('TonAPI reports wallet interfaces:', interfaces)

    const mnemonicWords = MNEMONIC.trim().split(/\s+/)
    console.log('Mnemonic word count:', mnemonicWords.length)
    // If this comes back false, the phrase isn't a standard native-TON
    // mnemonic (e.g. it's a BIP39-style export from a hardware/multi-chain
    // wallet) -- mnemonicToPrivateKey would then silently derive the wrong
    // keypair even though every word is "correct".
    const isValidNativeMnemonic = await mnemonicValidate(mnemonicWords)
    console.log('Native TON mnemonic checksum valid:', isValidNativeMnemonic)
    const keyPair = await mnemonicToPrivateKey(mnemonicWords)
    const wallet = resolveWallet(keyPair.publicKey)

    if (!wallet) {
      throw new Error(
        'Не удалось определить версию кошелька по мнемонике (адрес не совпал ни с одним вариантом)',
      )
    }
    console.log('Resolved wallet address:', wallet.address.toString())

    const client = new TonClient({
      endpoint: 'https://toncenter.com/api/v2/jsonRPC',
      apiKey: TONCENTER_API_KEY,
    })
    const contract = client.open(wallet)
    const seqno = await contract.getSeqno()
    console.log('Seqno:', seqno, 'sending', claimed.final_amount, 'to', claimed.wallet_address)

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
    // Money has left the wallet at this point -- from here on, a failure
    // must NEVER cause the row to revert to 'pending', or a retry would
    // broadcast a second real payout for the same withdrawal.
    transferSent = true

    const { error: finalizeErr } = await admin
      .from('withdrawals')
      .update({ status: 'approved', processed_at: new Date().toISOString() })
      .eq('id', claimed.id)
    if (finalizeErr) throw finalizeErr

    return jsonResponse({ success: true })
  } catch (err) {
    console.error(
      'send-withdrawal-payout failed:',
      err instanceof Error ? err.stack ?? err.message : JSON.stringify(err),
    )
    if (claimedWithdrawalId && !transferSent) {
      // Failed before anything was sent -- safe to release the claim so the
      // admin can retry.
      await admin
        .from('withdrawals')
        .update({ status: 'pending' })
        .eq('id', claimedWithdrawalId)
        .eq('status', 'processing')
    }

    const message = transferSent
      ? 'Выплата УЖЕ ОТПРАВЛЕНА в сеть, но не удалось обновить статус заявки. Не подтверждайте повторно — проверьте транзакцию и статус вручную в базе данных.'
      : err instanceof Error
        ? err.message
        : 'Ошибка отправки выплаты'

    return jsonResponse({ success: false, message }, 500)
  }
})
