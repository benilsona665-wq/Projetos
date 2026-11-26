import React, { useEffect, useState } from 'react';
import { Database, Eye, EyeOff, Lock, LogIn, Moon, ShieldPlus, Sun } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { apiFetch } from '../lib/api';
import type { PharmacySettings, User } from '../types';
import { ANCORA_LOGO_SRC } from './BrandLogo';
import { OfflineIndicator, PWAInstallButton } from './PWAInstallButton';

interface LoginScreenProps {
  onSuccess: (token: string, user: User, settings: PharmacySettings) => Promise<void> | void;
  sessionNotice?: string | null;
}

interface BootstrapInfo {
  needsAdminSetup?: boolean;
  dbEngine: 'postgresql' | 'sqlite';
  persistentSharedDb?: boolean;
  pharmacyName: string;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onSuccess, sessionNotice }) => {
  const { theme, toggleTheme } = useTheme();
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bootstrapError, setBootstrapError] = useState('');
  const [bootstrapInfo, setBootstrapInfo] = useState<BootstrapInfo | null>(null);

  useEffect(() => {
    apiFetch<BootstrapInfo>('/api/auth/bootstrap-info')
      .then((info) => {
        setBootstrapInfo(info);
        setBootstrapError('');
      })
      .catch((err: any) => {
        setBootstrapError(
          err?.message ||
            'Não foi possível ligar ao servidor ou à base de dados. Verifique se o serviço está ativo.'
        );
      });
  }, []);

  const isFirstAccessSetup = Boolean(bootstrapInfo?.needsAdminSetup);
  const isSharedPostgres =
    bootstrapInfo?.dbEngine === 'postgresql' || Boolean(bootstrapInfo?.persistentSharedDb);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (isFirstAccessSetup) {
      if (!fullName.trim() || !username.trim() || !password) {
        setError('Preencha o nome completo, o utilizador e a palavra-passe.');
        return;
      }
      if (password.length < 8) {
        setError('A palavra-passe do administrador deve ter pelo menos 8 caracteres.');
        return;
      }
      if (password !== confirmPassword) {
        setError('A confirmação da palavra-passe não coincide.');
        return;
      }
      setLoading(true);
      try {
        const data = await apiFetch<{ token: string; user: User; settings: PharmacySettings }>(
          '/api/auth/setup-admin',
          {
            method: 'POST',
            body: JSON.stringify({
              fullName: fullName.trim(),
              username: username.trim(),
              password,
            }),
          }
        );
        if (!data?.token || !data?.user || !data?.settings) {
          throw new Error(
            'Resposta incompleta do servidor ao criar administrador. Recarregue a página e tente novamente.'
          );
        }
        await onSuccess(data.token, data.user, data.settings);
      } catch (err: any) {
        setError(err?.message || 'Não foi possível configurar o administrador inicial.');
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!username.trim() || !password) {
      setError('Introduza o nome de utilizador e a palavra-passe.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: User; settings: PharmacySettings }>(
        '/api/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({ username: username.trim(), password }),
        }
      );
      if (!data?.token || !data?.user || !data?.settings) {
        throw new Error(
          'Resposta incompleta do servidor ao iniciar sessão. Recarregue a página e tente novamente.'
        );
      }
      await onSuccess(data.token, data.user, data.settings);
    } catch (err: any) {
      setError(err?.message || 'Não foi possível iniciar sessão.');
    } finally {
      setLoading(false);
    }
  };

  const dbFeatureText = bootstrapInfo
    ? isSharedPostgres
      ? 'Acesso individual em computador e telemóvel com base de dados partilhada (PostgreSQL), validade de lotes, proformas e relatórios exportáveis.'
      : 'Acesso individual em computador e telemóvel com base de dados local SQLite neste servidor, validade de lotes, proformas e relatórios exportáveis.'
    : 'Acesso individual em computador e telemóvel com controlo de validade de lotes, proformas e relatórios exportáveis.';

  const dbBadgeLabel = bootstrapInfo
    ? isSharedPostgres
      ? 'PostgreSQL (base de dados partilhada)'
      : 'SQLite local (não partilhada)'
    : null;

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950 flex flex-col">
      <OfflineIndicator />
      <div className="flex-1 flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-5xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12 shadow-xl dark:shadow-black/40">
          {/* Left brand panel: Crisp White Logo Frame + Pharmaceutical Green */}
          <div className="lg:col-span-5 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 flex flex-col justify-between">
            <div className="p-8 sm:p-10 flex-1 flex items-center justify-center bg-white">
              <div className="w-48 h-48 sm:w-60 sm:h-60 bg-white flex items-center justify-center p-2">
                <img
                  src={ANCORA_LOGO_SRC}
                  alt="Logotipo Âncora SMS — Stock Management System"
                  className="w-full h-full object-contain"
                />
              </div>
            </div>

            <div className="bg-green-800 text-white p-6 sm:p-8 space-y-2">
              <h1 className="text-lg font-display font-semibold text-white [text-wrap:balance]">
                Controlo rigoroso de stock, vendas e fecho diário.
              </h1>
              <p className="text-xs sm:text-sm text-green-100 leading-relaxed">
                {dbFeatureText}
              </p>
            </div>
          </div>

          {/* Right login form */}
          <div className="lg:col-span-7 p-6 sm:p-10 flex flex-col justify-between bg-white dark:bg-slate-900">
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
                    {isFirstAccessSetup ? 'Configuração Inicial' : 'Iniciar Sessão'}
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    {isFirstAccessSetup
                      ? 'Configure a conta do administrador inicial para começar.'
                      : 'Introduza as suas credenciais individuais para continuar'}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <PWAInstallButton compact />
                  <button
                    type="button"
                    onClick={toggleTheme}
                    className="p-2 min-h-[36px] min-w-[36px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-center"
                    aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
                    title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
                  >
                    {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {(error || sessionNotice || bootstrapError) && (
                <div
                  role="alert"
                  className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-900 text-sm text-red-800 dark:text-red-300"
                >
                  {error || sessionNotice || bootstrapError}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                {isFirstAccessSetup && (
                  <div>
                    <label
                      htmlFor="setup-fullname"
                      className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                    >
                      Nome completo do Administrador
                    </label>
                    <input
                      id="setup-fullname"
                      type="text"
                      autoComplete="name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Introduza o nome completo"
                      className="w-full min-h-[44px] px-3.5 py-2.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-green-600"
                    />
                  </div>
                )}

                <div>
                  <label
                    htmlFor="login-username"
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                  >
                    Utilizador
                  </label>
                  <input
                    id="login-username"
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Introduza o nome de utilizador"
                    className="w-full min-h-[44px] px-3.5 py-2.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-green-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="login-password"
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                  >
                    Palavra-passe
                  </label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete={isFirstAccessSetup ? 'new-password' : 'current-password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Introduza a palavra-passe"
                      className="w-full min-h-[44px] px-3.5 py-2.5 pr-11 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-green-600"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Ocultar palavra-passe' : 'Mostrar palavra-passe'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {isFirstAccessSetup && (
                  <div>
                    <label
                      htmlFor="setup-confirm-password"
                      className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                    >
                      Confirmar palavra-passe
                    </label>
                    <input
                      id="setup-confirm-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Repita a palavra-passe (mín. 8 caracteres)"
                      className="w-full min-h-[44px] px-3.5 py-2.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-green-600"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full min-h-[44px] px-4 py-2.5 bg-green-700 hover:bg-green-800 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                >
                  {isFirstAccessSetup ? (
                    <ShieldPlus className="w-4 h-4" />
                  ) : (
                    <LogIn className="w-4 h-4" />
                  )}
                  {loading
                    ? 'A autenticar...'
                    : isFirstAccessSetup
                    ? 'Criar Administrador e Iniciar'
                    : 'Iniciar sessão'}
                </button>
              </form>
            </div>

            {/* Bottom info: strictly reflects real server database state, no demo credentials */}
            <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-green-700 dark:text-green-400 shrink-0" />
                Acesso restrito a utilizadores autorizados.
              </span>
              {dbBadgeLabel && (
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  <Database className="w-3.5 h-3.5 text-green-700 dark:text-green-400 shrink-0" />
                  {dbBadgeLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
