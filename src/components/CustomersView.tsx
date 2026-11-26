import React, { useMemo, useState } from 'react';
import { Edit2, Plus, Search, Users, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatMoney, isInvoiceSaleType } from '../lib/format';
import type { Customer, PharmacySettings, Sale } from '../types';

interface CustomersViewProps {
  settings: PharmacySettings;
  customers: Customer[];
  sales: Sale[];
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const CustomersView: React.FC<CustomersViewProps> = ({
  settings,
  customers,
  sales,
  onRefresh,
  onNotify,
}) => {
  const cur = settings.currencySymbol || 'Kz';
  const [query, setQuery] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [form, setForm] = useState({
    name: '',
    nif: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      `${c.name} ${c.nif} ${c.phone} ${c.email}`.toLowerCase().includes(q)
    );
  }, [customers, query]);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', nif: '', phone: '', email: '', address: '', notes: '' });
    setShowModal(true);
  };

  const openEdit = (c: Customer) => {
    setEditing(c);
    setForm({
      name: c.name,
      nif: c.nif,
      phone: c.phone,
      email: c.email,
      address: c.address,
      notes: c.notes,
    });
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await apiFetch(`/api/customers/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(form),
        });
        onNotify('Cliente atualizado.');
      } else {
        await apiFetch('/api/customers', {
          method: 'POST',
          body: JSON.stringify(form),
        });
        onNotify('Cliente registado com sucesso.');
      }
      setShowModal(false);
      await onRefresh();
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao guardar cliente.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
            Clientes (Faturação com NIF)
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Clientes registados para faturação nominal. Vendas a consumidor comum não exigem cadastro.
          </p>
        </div>

        <button
          type="button"
          onClick={openCreate}
          className="min-h-[42px] px-4 py-2 bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white text-sm font-medium rounded-lg flex items-center gap-2 whitespace-nowrap self-start"
        >
          <Plus className="w-4 h-4" />
          Novo Cliente
        </button>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
        <div className="relative max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Pesquisar cliente por nome, NIF ou telefone..."
            className="w-full min-h-[40px] pl-9 pr-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm"
          />
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                <th className="py-3 px-4 font-medium">Nome</th>
                <th className="py-3 px-3 font-medium">NIF</th>
                <th className="py-3 px-3 font-medium">Contactos</th>
                <th className="py-3 px-3 font-medium">Endereço</th>
                <th className="py-3 px-3 font-medium text-right">Compras Faturadas</th>
                <th className="py-3 px-4 font-medium text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filtered.map((c) => {
                const custSales = sales.filter(
                  (s) => s.customerId === c.id && isInvoiceSaleType(s.type) && s.status !== 'ANULADA'
                );
                const totalSpent = custSales.reduce((acc, s) => acc + s.totalAmount, 0);
                return (
                  <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-slate-100">
                      <div className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-slate-400 shrink-0" />
                        <span>{c.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono text-slate-700 dark:text-slate-300">{c.nif || '—'}</td>
                    <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                      <div>{c.phone || '—'}</div>
                      <div className="text-[11px]">{c.email}</div>
                    </td>
                    <td className="py-3 px-3 text-slate-600 dark:text-slate-400">{c.address || '—'}</td>
                    <td className="py-3 px-3 text-right font-mono">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {formatMoney(totalSpent, cur)}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">{custSales.length} fatura(s)</div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => openEdit(c)}
                        className="p-2 text-slate-600 dark:text-slate-400 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                        title="Editar cliente"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-500 dark:text-slate-400">
                    Nenhum cliente encontrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-display font-semibold text-slate-900 dark:text-slate-100">
                {editing ? 'Editar Cliente' : 'Cadastrar Cliente'}
              </h2>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-3 text-sm">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Nome Completo *</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">NIF</label>
                  <input
                    value={form.nif}
                    onChange={(e) => setForm({ ...form, nif: e.target.value })}
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Telefone</label>
                  <input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Endereço</label>
                <input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full min-h-[40px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Observações</label>
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-sm bg-green-700 hover:bg-green-800 dark:hover:bg-green-600 text-white rounded-lg font-medium"
                >
                  {saving ? 'A guardar...' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
