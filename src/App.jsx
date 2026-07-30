import { useEffect, useState } from 'react'
import { Home, Swords, ClipboardList, Wallet as WalletIcon, Users, ShieldAlert } from 'lucide-react'
import { supabase, setAuthToken } from './supabaseClient'
import DungeonList from './components/DungeonList.jsx'
import Wallet from './components/Wallet.jsx'
import Guild from './components/Guild.jsx'
import Tasks from './components/Tasks.jsx'
import AdminPanel from './components/AdminPanel.jsx'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

const ADMIN_TG_ID = import.meta.env.VITE_ADMIN_TG_ID

const TABS = [
  { id: 'home', label: 'Главная', icon: Home },
  { id: 'expedition', label: 'Поход', icon: Swords },
  { id: 'quests', label: 'Задания', icon: ClipboardList },
  { id: 'wallet', label: 'Кошелёк', icon: WalletIcon },
  { id: 'guild', label: 'Гильдия', icon: Users },
]

const ADMIN_TAB = { id: 'admin', label: 'Админ-панель', icon: ShieldAlert }

function App() {
  const [activeTab, setActiveTab] = useState('home')
  const [user] = useState(() => tg?.initDataUnsafe?.user ?? null)
  const [referralId] = useState(() => {
    const startParam = tg?.initDataUnsafe?.start_param
    const referralMatch = startParam?.match(/^ref_(\d+)$/)
    return referralMatch ? referralMatch[1] : null
  })

  const [verifiedUser, setVerifiedUser] = useState(null)
  const [registered, setRegistered] = useState(false)
  const [registerError, setRegisterError] = useState(null)

  useEffect(() => {
    if (tg) {
      try {
        tg.ready()
        tg.expand()
      } catch (e) {
        console.error('Telegram WebApp init error:', e)
      }
    }
  }, [])

  useEffect(() => {
    if (!user) return
    let cancelled = false

    async function authenticate() {
      const { data, error } = await supabase.functions.invoke('telegram-auth', {
        body: { initData: tg?.initData },
      })
      if (cancelled) return
      if (error || !data?.token) {
        setRegisterError(error?.message ?? data?.error ?? 'Не удалось авторизоваться')
        return
      }
      setAuthToken(data.token)
      setVerifiedUser(data.user)
      setRegistered(true)
    }

    authenticate()
    return () => {
      cancelled = true
    }
  }, [user])

  const isAdmin = verifiedUser && ADMIN_TG_ID && String(verifiedUser.id) === ADMIN_TG_ID

  const tabs = isAdmin ? [...TABS, ADMIN_TAB] : TABS

  return (
    <div className="min-h-screen bg-theme-bg flex flex-col text-theme-dark-text">
      <header className="px-4 pt-6 pb-4">
        <h1 className="text-2xl font-bold">DungeonQuest</h1>
        {user ? (
          <p className="mt-1 text-sm text-theme-dark-text/70">
            Привет, {user.first_name}
            {user.username ? ` (@${user.username})` : ''}!
          </p>
        ) : (
          <p className="mt-1 text-sm text-theme-dark-text/70">
            Откройте приложение через Telegram, чтобы авторизоваться
          </p>
        )}
        {referralId && (
          <p className="mt-1 text-xs text-theme-dark-text/60">
            Приглашён игроком #{referralId}
          </p>
        )}
        {registerError && (
          <p className="mt-2 text-sm text-red-700 bg-red-100 border border-red-300 rounded-2xl px-3 py-2">
            {registerError}
          </p>
        )}
      </header>

      <main className="flex-1 px-4 pb-24">
        {user && !registered && !registerError ? (
          <p className="text-sm text-theme-dark-text/70">Загрузка профиля…</p>
        ) : activeTab === 'expedition' ? (
          <DungeonList />
        ) : activeTab === 'quests' ? (
          <Tasks />
        ) : activeTab === 'wallet' ? (
          <Wallet />
        ) : activeTab === 'guild' ? (
          <Guild />
        ) : activeTab === 'admin' ? (
          <AdminPanel />
        ) : (
          <div className="bg-theme-card border border-theme-card-border rounded-2xl p-5 min-h-[60vh]">
            <h2 className="text-lg font-semibold mb-2">
              {tabs.find((t) => t.id === activeTab)?.label}
            </h2>
            <p className="text-theme-dark-text/70 text-sm">
              Раздел «{tabs.find((t) => t.id === activeTab)?.label}» скоро будет наполнен контентом.
            </p>
          </div>
        )}
      </main>

      <nav className="fixed bottom-0 inset-x-0 bg-theme-card border-t border-theme-card-border px-2 py-2">
        <div className="flex justify-around max-w-md mx-auto">
          {tabs.map(({ id, label, icon: Icon }) => {
            const isActive = activeTab === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex flex-col items-center gap-1 px-2 py-1 rounded-2xl text-xs transition-colors ${
                  isActive
                    ? 'text-theme-accent'
                    : 'text-theme-dark-text/50'
                }`}
              >
                <Icon size={22} strokeWidth={isActive ? 2.5 : 2} />
                {label}
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}

export default App
