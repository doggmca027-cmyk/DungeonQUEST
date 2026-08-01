import { lazy, Suspense, useEffect, useState } from 'react'
import { Home as HomeIcon, Swords, ClipboardList, Wallet as WalletIcon, Users, ShieldAlert, Languages } from 'lucide-react'
import { supabase, setAuthToken } from './supabaseClient'
import { useLanguage } from './i18n/LanguageContext.jsx'
import SupportButton from './components/SupportButton.jsx'

const Home = lazy(() => import('./components/Home.jsx'))
const DungeonList = lazy(() => import('./components/DungeonList.jsx'))
const Wallet = lazy(() => import('./components/Wallet.jsx'))
const Guild = lazy(() => import('./components/Guild.jsx'))
const Tasks = lazy(() => import('./components/Tasks.jsx'))
const AdminPanel = lazy(() => import('./components/AdminPanel.jsx'))

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

const ADMIN_TG_ID = import.meta.env.VITE_ADMIN_TG_ID

function LanguageToggle() {
  const { language, toggleLanguage } = useLanguage()
  return (
    <button
      type="button"
      onClick={toggleLanguage}
      className="shrink-0 flex items-center gap-1.5 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-card border border-theme-card-border text-theme-accent"
    >
      <Languages size={18} />
      {language === 'ru' ? 'EN' : 'RU'}
    </button>
  )
}

function App() {
  const { t } = useLanguage()
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
        setRegisterError(error?.message ?? data?.error ?? t('app.authError'))
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
    // t intentionally omitted -- re-running auth on language toggle would re-fire the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const isAdmin = verifiedUser && ADMIN_TG_ID && String(verifiedUser.id) === ADMIN_TG_ID

  const TABS = [
    { id: 'home', label: t('app.tabs.home'), icon: HomeIcon },
    { id: 'expedition', label: t('app.tabs.expedition'), icon: Swords },
    { id: 'quests', label: t('app.tabs.quests'), icon: ClipboardList },
    { id: 'wallet', label: t('app.tabs.wallet'), icon: WalletIcon },
    { id: 'guild', label: t('app.tabs.guild'), icon: Users },
  ]
  const ADMIN_TAB = { id: 'admin', label: t('app.tabs.admin'), icon: ShieldAlert }
  const tabs = isAdmin ? [...TABS, ADMIN_TAB] : TABS

  return (
    <div className="min-h-screen bg-theme-bg flex flex-col text-theme-dark-text">
      <header className="px-4 pt-6 pb-4">
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-2xl font-bold">{t('app.title')}</h1>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <SupportButton />
          </div>
        </div>
        {user ? (
          <p className="mt-1 text-sm text-theme-dark-text/70">
            {t('app.greeting', {
              name: user.first_name,
              username: user.username ? t('app.usernameSuffix', { username: user.username }) : '',
            })}
          </p>
        ) : (
          <p className="mt-1 text-sm text-theme-dark-text/70">{t('app.openInTelegram')}</p>
        )}
        {referralId && (
          <p className="mt-1 text-xs text-theme-dark-text/60">
            {t('app.invitedBy', { id: referralId })}
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
          <p className="text-sm text-theme-dark-text/70">{t('app.loadingProfile')}</p>
        ) : (
          <Suspense fallback={<p className="text-sm text-theme-dark-text/70">{t('app.loading')}</p>}>
            {activeTab === 'expedition' ? (
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
              <Home onNavigateToExpedition={() => setActiveTab('expedition')} />
            )}
          </Suspense>
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
