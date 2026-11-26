import React, { useEffect, useState } from 'react';
import { Lock, LogOut, RefreshCw, Unlock } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { PharmacySettings, User } from '../types';
import { BrandLogo } from './BrandLogo';

interface LockOverlayProps {
  currentUser: User;
  onUnlock: () => void;
  onSwitched: (token: string, user: User, settings: PharmacySettings) => void;
  onLogout: () => void;
}

export const LockOverlay: React.FC<LockOverlayProps> = ({
  currentUser,
  onUnlock,
  onSwitched,
  onLogout,
}) => {
  const [mode, setMode] = useState<'UNLOCK' | 'SWITCH'>('UNLOCK');
  const [password, setPassword] = useState('');
  const [targetUsername, setTargetUsername] = useState('');
  const [directory, setDirectory] = useState<Array<{ id: string; username: string; fullName: string; role: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<Array<{ id: string; username: string; fullName: string; role: string }>>(
      '/api/auth/users-directory'
    )
      .then((list) => {
        setDirectory(list);
        const other = list.find((u) => u.username !== currentUser.username);
        if (other) setTargetUsername(other.username);
      })
      .catch(() => {});
  }, [currentUser.username]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await apiFetch('/api/auth/verify-password', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setPassword('');
      onUnlock();
    } catch (err: any) {
      setError(err?.message || 'Palavra-passe incorreta.');
    } finally {
      setLoading(false);
    }
  };

  const handleSwitch = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!targetUsername.trim() || !password) {
      setError('Selecione o utilizador e introduza a respetiva palavra-passe.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: User; settings: PharmacySettings }>(
        '/api/auth/switch',
        {
          method: 'POST',
          body: JSON.stringify({ username: targetUsername.trim(), password }),
        }
      );
      if (!data?.token || !data?.user || !data?.settings) {
        throw new Error('Resposta incompleta do servidor ao mudar de utilizador. Tente novamente.');
      }
      setPassword('');
      onSwitched(data.token, data.user, data.settings);
    } catch (err: any) {
      setError(err?.message || 'Credenciais inválidas.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 sm:p-8 space-y-6 shadow-2xl">
        <div className="pb-4 border-b border-slate-200 dark:border-slate-800">
          <BrandLogo size="sm" />
        </div>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-green-50 dark:bg-green-950/60 border border-green-200 dark:border-green-800 flex items-center justify-center text-green-800 dark:text-green-400 shrink-0">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100">
              {mode === 'UNLOCK' ? 'Sessão Bloqueada' : 'Mudar de Utilizador'}
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
              Utilizador atual:{' '}
              <span className="font-medium text-slate-900 dark:text-slate-100">{currentUser.fullName}</span>
            </p>
          </div>
        </div>

        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          <button
            type="button"
            onClick={() => {
              setMode('UNLOCK');
              setError('');
              setPassword('');
            }}
            className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              mode === 'UNLOCK'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Desbloquear Sessão
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('SWITCH');
              setError('');
              setPassword('');
            }}
            className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              mode === 'SWITCH'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Entrar com Outro Utilizador
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-900 text-xs text-red-800 dark:text-red-300">
            {error}
          </div>
        )}

        {mode === 'UNLOCK' ? (
          <form onSubmit={handleUnlock} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Palavra-passe de {currentUser.username}
              </label>
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Introduza a sua palavra-passe"
                className="w-full min-h-[44px] px-3.5 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-green-600"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[44px] px-4 py-2.5 bg-green-700 hover:bg-green-800 text-white text-sm font-medium rounded-lg flex items-center justify-center gap-2 whitespace-nowrap"
            >
              <Unlock className="w-4 h-4" />
              {loading ? 'A verificar...' : 'Desbloquear'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSwitch} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Selecionar Utilizador
              </label>
              <select
                value={targetUsername}
                onChange={(e) => setTargetUsername(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-green-600"
              >
                {directory.map((u) => (
                  <option key={u.id} value={u.username}>
                    {u.fullName} ({u.role === 'ADMIN' ? 'Administrador' : 'Vendedor/Farmacêutico'})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Palavra-passe do utilizador selecionado
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Palavra-passe obrigatória"
                className="w-full min-h-[44px] px-3.5 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-green-600"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[44px] px-4 py-2.5 bg-green-700 hover:bg-green-800 text-white text-sm font-medium rounded-lg flex items-center justify-center gap-2 whitespace-nowrap"
            >
              <RefreshCw className="w-4 h-4" />
              {loading ? 'A mudar...' : 'Confirmar Mudança'}
            </button>
          </form>
        )}

        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex justify-end">
          <button
            type="button"
            onClick={onLogout}
            className="text-xs font-medium text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 flex items-center gap-1.5 py-1.5 px-2 whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            Terminar Sessão
          </button>
        </div>
      </div>
    </div>
  );
};

interface SwitchUserModalProps {
  currentUser: User;
  onClose: () => void;
  onSwitched: (token: string, user: User, settings: PharmacySettings) => void;
}

export const SwitchUserModal: React.FC<SwitchUserModalProps> = ({
  currentUser,
  onClose,
  onSwitched,
}) => {
  const [directory, setDirectory] = useState<Array<{ id: string; username: string; fullName: string; role: string }>>([]);
  const [targetUsername, setTargetUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<Array<{ id: string; username: string; fullName: string; role: string }>>(
      '/api/auth/users-directory'
    )
      .then((list) => {
        setDirectory(list);
        const other = list.find((u) => u.username !== currentUser.username) || list[0];
        if (other) setTargetUsername(other.username);
      })
      .catch(() => {});
  }, [currentUser.username]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!targetUsername || !password) {
      setError('Selecione o utilizador e introduza a palavra-passe.');
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<{ token: string; user: User; settings: PharmacySettings }>(
        '/api/auth/switch',
        {
          method: 'POST',
          body: JSON.stringify({ username: targetUsername, password }),
        }
      );
      if (!data?.token || !data?.user || !data?.settings) {
        throw new Error('Resposta incompleta do servidor ao mudar de utilizador. Tente novamente.');
      }
      onSwitched(data.token, data.user, data.settings);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Palavra-passe incorreta.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
            Mudar de Utilizador
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 px-2 py-1"
          >
            Fechar
          </button>
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Por segurança, é obrigatório validar a palavra-passe do utilizador que vai iniciar sessão.
        </p>

        {error && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-900 text-xs text-red-800 dark:text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Utilizador de destino
            </label>
            <select
              value={targetUsername}
              onChange={(e) => setTargetUsername(e.target.value)}
              className="w-full min-h-[44px] px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-green-600"
            >
              {directory.map((u) => (
                <option key={u.id} value={u.username}>
                  {u.fullName} ({u.role === 'ADMIN' ? 'Admin' : 'Vendedor'})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Palavra-passe
            </label>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Introduza a palavra-passe"
              className="w-full min-h-[44px] px-3.5 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-green-600"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg whitespace-nowrap"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-white bg-green-700 hover:bg-green-800 rounded-lg whitespace-nowrap"
            >
              {loading ? 'A validar...' : 'Mudar Utilizador'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
