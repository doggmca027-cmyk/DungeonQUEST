import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { translations } from './translations.js'

const STORAGE_KEY = 'dungeonquest_language'
const LanguageContext = createContext(null)

function resolvePath(obj, path) {
  return path.split('.').reduce((acc, part) => acc?.[part], obj)
}

function readStoredLanguage() {
  if (typeof window === 'undefined') return 'ru'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  return stored === 'en' ? 'en' : 'ru'
}

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(readStoredLanguage)

  const setLanguage = useCallback((next) => {
    setLanguageState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  }, [])

  const toggleLanguage = useCallback(() => {
    setLanguage(language === 'ru' ? 'en' : 'ru')
  }, [language, setLanguage])

  const t = useCallback(
    (key, vars) => {
      const dict = translations[language] ?? translations.ru
      const template = resolvePath(dict, key) ?? resolvePath(translations.ru, key)
      if (template == null) return key
      if (!vars) return template
      return Object.entries(vars).reduce(
        (str, [name, value]) => str.replaceAll(`{{${name}}}`, String(value)),
        template,
      )
    },
    [language],
  )

  const value = useMemo(
    () => ({ language, setLanguage, toggleLanguage, t }),
    [language, setLanguage, toggleLanguage, t],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- hook is tightly coupled to this provider
export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider')
  return ctx
}
