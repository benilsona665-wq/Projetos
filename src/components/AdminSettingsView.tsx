import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CloudUpload,
  Download,
  Edit2,
  FileCode2,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatDateTimePT, todayLocalISO } from '../lib/format';
import type {
  AgtPublicStatus,
  AuditLogEntry,
  BackupPolicySettings,
  PharmacySettings,
  SellerPermissions,
  TaxCode,
  TaxRuleEntry,
  User,
  UserRole,
  VatRegime,
} from '../types';

interface AdminSettingsViewProps {
  currentUser: User;
  settings: PharmacySettings;
  users: User[];
  auditLogs: AuditLogEntry[];
  initialTab?: 'USERS' | 'SETTINGS' | 'AUDIT' | 'BACKUP';
  onOpenProductsNoTax?: () => void;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

const defaultPerms: SellerPermissions = {
  canDiscount: true,
  maxDiscountPercent: 5,
  canProcessReturns: true,
  canCancelSales: false,
  canViewPurchases: false,
  canStartInventoryCount: true,
  canConfigureProductVat: false,
};

export const AdminSettingsView: React.FC<AdminSettingsViewProps> = ({
  currentUser,
  settings,
  users,
  auditLogs,
  initialTab,
  onOpenProductsNoTax,
  onRefresh,
  onNotify,
}) => {
  const [tab, setTab] = useState<'USERS' | 'SETTINGS' | 'AUDIT' | 'BACKUP'>(initialTab || 'USERS');

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  // Users modal
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [uUsername, setUUsername] = useState('');
  const [uFullName, setUFullName] = useState('');
  const [uPassword, setUPassword] = useState('');
  const [uRole, setURole] = useState<UserRole>('SELLER');
  const [uActive, setUActive] = useState(true);
  const [uPerms, setUPerms] = useState<SellerPermissions>(defaultPerms);

  // Settings form
  const [setForm, setSetForm] = useState<PharmacySettings>(settings);
  const [settingsChangeReason, setSettingsChangeReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmClearDemo, setConfirmClearDemo] = useState(false);

  useEffect(() => {
    setSetForm(settings);
  }, [settings]);

  // Administrable VAT Rules
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<TaxRuleEntry | null>(null);
  const [ruleForm, setRuleForm] = useState({
    taxCode: 'NOR' as Exclude<TaxCode, 'NAO_CONFIGURADO'>,
    description: '',
    rate: '',
    exemptionCode: '',
    legalBasis: '',
    validFrom: todayLocalISO(),
    validTo: '',
    active: true,
    confirmedByAccountant: false,
    changeReason: '',
  });
  const [savingRule, setSavingRule] = useState(false);

  // External daily backup status & policy
  const [autoBackupStatus, setAutoBackupStatus] = useState<{
    storageConfigured: boolean;
    missingRequirements: string[];
    providerHost: string;
    bucket: string;
    prefix: string;
    encryptionEnabled: boolean;
    cronEndpointConfigured: boolean;
    policy: BackupPolicySettings;
  } | null>(null);
  const [backupPolicyForm, setBackupPolicyForm] = useState<BackupPolicySettings>(
    settings.backupPolicy || {
      enabled: false,
      retentionDays: 30,
      dailyHourUTC: 2,
      lastStatus: 'NEVER',
    }
  );
  const [runningAutoBackup, setRunningAutoBackup] = useState(false);
  const [manualBackupResult, setManualBackupResult] = useState<{
    ok: boolean;
    message: string;
    at: string;
  } | null>(null);
  const [autoBackupActionResult, setAutoBackupActionResult] = useState<{
    ok: boolean;
    message: string;
    at: string;
  } | null>(null);

  const loadAutoBackupStatus = async () => {
    try {
      const data = await apiFetch<{
        storageConfigured: boolean;
        missingRequirements: string[];
        providerHost: string;
        bucket: string;
        prefix: string;
        encryptionEnabled: boolean;
        cronEndpointConfigured: boolean;
        policy: BackupPolicySettings;
      }>('/api/backup/auto/status');
      setAutoBackupStatus(data);
      setBackupPolicyForm(data.policy);
    } catch {
      // Ignore if offline or unavailable
    }
  };

  const [agtStatus, setAgtStatus] = useState<
    (AgtPublicStatus & {
      vatRegime: VatRegime;
      agtElectronicInvoicingEnabled: boolean;
      unconfiguredProductsCount: number;
      missingIssuerFields: string[];
    }) | null
  >(null);
  const [saftStartDate, setSaftStartDate] = useState(() => `${todayLocalISO().slice(0, 7)}-01`);
  const [saftEndDate, setSaftEndDate] = useState(() => todayLocalISO());
  const [saftExportResult, setSaftExportResult] = useState<{
    filename: string;
    warnings: string[];
    summary: {
      invoicesAndCreditNotesCount: number;
      workingDocumentsCount: number;
      paymentsCount: number;
      totalCredit: number;
      totalDebit: number;
      certified: boolean;
      saftCompliant: boolean;
      blockingIssues: string[];
      structureValid?: boolean;
      structureErrors?: string[];
    };
  } | null>(null);
  const [exportingSaft, setExportingSaft] = useState(false);

  // Solicitar Série AGT (DE 683/25)
  const [seriesDocType, setSeriesDocType] = useState<'FT' | 'FR' | 'NC' | 'ND' | 'RC'>('FR');
  const [seriesReqYear, setSeriesReqYear] = useState<number>(
    () => settings.series.seriesYear || new Date().getFullYear()
  );
  const [seriesEstablishment, setSeriesEstablishment] = useState<string>(
    () => settings.establishmentCode || 'EST-01'
  );
  const [seriesContingency, setSeriesContingency] = useState<'N' | 'C'>('N');
  const [requestingSeries, setRequestingSeries] = useState(false);
  const [seriesRequestResult, setSeriesRequestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const loadAgtStatus = async () => {
    try {
      const data = await apiFetch<
        AgtPublicStatus & {
          vatRegime: VatRegime;
          agtElectronicInvoicingEnabled: boolean;
          unconfiguredProductsCount: number;
          missingIssuerFields: string[];
        }
      >('/api/fiscal/agt/status');
      setAgtStatus(data);
    } catch {
      // Ignore if offline or unavailable
    }
  };

  useEffect(() => {
    setSetForm(settings);
  }, [settings]);

  useEffect(() => {
    if (tab === 'BACKUP') {
      loadAutoBackupStatus();
      loadAgtStatus();
    } else if (tab === 'SETTINGS') {
      loadAgtStatus();
    }
  }, [tab]);

  const openCreateUser = () => {
    setEditingUser(null);
    setUUsername('');
    setUFullName('');
    setUPassword('');
    setURole('SELLER');
    setUActive(true);
    setUPerms(defaultPerms);
    setShowUserModal(true);
  };

  const openEditUser = (u: User) => {
    setEditingUser(u);
    setUUsername(u.username);
    setUFullName(u.fullName);
    setUPassword('');
    setURole(u.role);
    setUActive(u.active);
    setUPerms({ ...u.permissions });
    setShowUserModal(true);
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingUser) {
        await apiFetch(`/api/users/${editingUser.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            fullName: uFullName,
            role: uRole,
            active: uActive,
            permissions: uPerms,
            newPassword: uPassword || undefined,
          }),
        });
        onNotify('Utilizador atualizado.');
      } else {
        await apiFetch('/api/users', {
          method: 'POST',
          body: JSON.stringify({
            username: uUsername,
            fullName: uFullName,
            password: uPassword,
            role: uRole,
            permissions: uPerms,
          }),
        });
        onNotify('Novo utilizador criado.');
      }
      setShowUserModal(false);
      await onRefresh();
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao guardar utilizador.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...setForm,
          changeReason: settingsChangeReason.trim() || undefined,
        }),
      });
      setSettingsChangeReason('');
      await onRefresh();
      onNotify('Configurações da farmácia e séries documentais guardadas.');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao guardar configurações.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openNewTaxRule = () => {
    setEditingRule(null);
    setRuleForm({
      taxCode: 'NOR',
      description: '',
      rate: '',
      exemptionCode: '',
      legalBasis: '',
      validFrom: todayLocalISO(),
      validTo: '',
      active: true,
      confirmedByAccountant: false,
      changeReason: '',
    });
    setShowRuleModal(true);
  };

  const openEditTaxRule = (rule: TaxRuleEntry) => {
    setEditingRule(rule);
    setRuleForm({
      taxCode: rule.taxCode,
      description: rule.description,
      rate: String(rule.rate),
      exemptionCode: rule.exemptionCode || '',
      legalBasis: rule.legalBasis,
      validFrom: rule.validFrom,
      validTo: rule.validTo || '',
      active: rule.active,
      confirmedByAccountant: rule.confirmedByAccountant,
      changeReason: '',
    });
    setShowRuleModal(true);
  };

  const handleSaveTaxRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingRule(true);
    try {
      const payload = {
        taxType: 'IVA',
        taxCode: ruleForm.taxCode,
        description: ruleForm.description.trim(),
        rate: ruleForm.taxCode === 'ISE' ? 0 : Number(ruleForm.rate),
        exemptionCode: ruleForm.exemptionCode.trim().toUpperCase(),
        legalBasis: ruleForm.legalBasis.trim(),
        validFrom: ruleForm.validFrom,
        validTo: ruleForm.validTo,
        active: ruleForm.active,
        confirmedByAccountant: ruleForm.confirmedByAccountant,
        changeReason: ruleForm.changeReason.trim() || undefined,
      };
      if (editingRule) {
        await apiFetch(`/api/fiscal/tax-rules/${editingRule.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        onNotify('Regra de IVA atualizada (documentos já emitidos permanecem imutáveis).');
      } else {
        await apiFetch('/api/fiscal/tax-rules', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onNotify('Nova regra de IVA registada na tabela fiscal.');
      }
      setShowRuleModal(false);
      await onRefresh();
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao guardar regra de IVA.', 'error');
    } finally {
      setSavingRule(false);
    }
  };

  const lastManualBackupLog = auditLogs.find(
    (entry) => entry.action === 'COPIA_SEGURANCA_EXPORTADA'
  );

  const handleExportBackup = async () => {
    try {
      const payload = await apiFetch<any>('/api/backup/export');
      const fileName = `copia_seguranca_ancora_sms_${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      setManualBackupResult({
        ok: true,
        message: `Cópia de segurança manual concluída (${fileName}).`,
        at: new Date().toISOString(),
      });
      await onRefresh();
      onNotify('Cópia de segurança transferida.');
    } catch (err: any) {
      const msg = err?.message || 'Erro ao exportar cópia de segurança.';
      setManualBackupResult({
        ok: false,
        message: msg,
        at: new Date().toISOString(),
      });
      onNotify(msg, 'error');
    }
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await apiFetch('/api/backup/restore', {
        method: 'POST',
        body: JSON.stringify(parsed),
      });
      await onRefresh();
      onNotify('Cópia de segurança restaurada com sucesso.');
    } catch (err: any) {
      onNotify(err?.message || 'Ficheiro inválido ou falha na recuperação.', 'error');
    } finally {
      e.target.value = '';
    }
  };

  const handleClearDemo = async () => {
    setSaving(true);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>('/api/backup/clear-demo', {
        method: 'POST',
      });
      setConfirmClearDemo(false);
      await onRefresh();
      onNotify(res.message || 'Dados de demonstração removidos.');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao limpar dados de demonstração.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleResetDemo = async () => {
    try {
      await apiFetch('/api/backup/reset-demo', { method: 'POST' });
      await onRefresh();
      onNotify('Dados de demonstração repostos.');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao repor dados.', 'error');
    }
  };

  const handleSaveBackupPolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await apiFetch<BackupPolicySettings>('/api/backup/auto/config', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: backupPolicyForm.enabled,
          retentionDays: Number(backupPolicyForm.retentionDays),
          dailyHourUTC: Number(backupPolicyForm.dailyHourUTC),
        }),
      });
      setBackupPolicyForm(updated);
      await loadAutoBackupStatus();
      await onRefresh();
      onNotify('Política de cópias de segurança automáticas guardada.');
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao guardar política de backups.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRunExternalBackupNow = async () => {
    setRunningAutoBackup(true);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>('/api/backup/auto/run', {
        method: 'POST',
      });
      setAutoBackupActionResult({
        ok: true,
        message: res.message,
        at: new Date().toISOString(),
      });
      await loadAutoBackupStatus();
      await onRefresh();
      onNotify(res.message);
    } catch (err: any) {
      const msg = err?.message || 'Erro ao executar cópia de segurança externa.';
      setAutoBackupActionResult({
        ok: false,
        message: msg,
        at: new Date().toISOString(),
      });
      await loadAutoBackupStatus();
      onNotify(msg, 'error');
    } finally {
      setRunningAutoBackup(false);
    }
  };

  const handleExportSaftAo = async () => {
    setExportingSaft(true);
    try {
      const result = await apiFetch<{
        xml: string;
        filename: string;
        readinessWarnings: string[];
        summary: {
          invoicesAndCreditNotesCount: number;
          workingDocumentsCount: number;
          paymentsCount: number;
          totalCredit: number;
          totalDebit: number;
          certified: boolean;
          saftCompliant: boolean;
          blockingIssues: string[];
          structureValid?: boolean;
          structureErrors?: string[];
        };
      }>(
        `/api/fiscal/saft-ao/export?startDate=${encodeURIComponent(saftStartDate)}&endDate=${encodeURIComponent(
          saftEndDate
        )}`
      );
      const blob = new Blob([result.xml], { type: 'application/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
      setSaftExportResult({
        filename: result.filename,
        warnings: result.readinessWarnings || [],
        summary: result.summary,
      });
      await onRefresh();
      onNotify(`SAF-T (AO) 1.01_01 exportado (${result.filename}).`);
    } catch (err: any) {
      onNotify(err?.message || 'Erro ao gerar ficheiro SAF-T (AO).', 'error');
    } finally {
      setExportingSaft(false);
    }
  };

  const handleRequestAgtSeries = async () => {
    setRequestingSeries(true);
    setSeriesRequestResult(null);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>('/api/fiscal/agt/solicitar-serie', {
        method: 'POST',
        body: JSON.stringify({
          documentType: seriesDocType,
          seriesYear: Number(seriesReqYear) || new Date().getFullYear(),
          establishmentNumber: seriesEstablishment.trim() || 'EST-01',
          seriesContingencyIndicator: seriesContingency,
        }),
      });
      setSeriesRequestResult({ ok: res.ok, message: res.message });
      await onRefresh();
      await loadAgtStatus();
      onNotify(res.message);
    } catch (err: any) {
      const msg = err?.message || 'Erro ao solicitar série na AGT.';
      setSeriesRequestResult({ ok: false, message: msg });
      onNotify(msg, 'error');
    } finally {
      setRequestingSeries(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl sm:text-2xl font-display font-semibold text-slate-900 dark:text-slate-100">
          Administração, Auditoria e Segurança
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
          Gestão de utilizadores, permissões, séries numéricas, registo de auditoria e cópias de segurança.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg">
        {[
          { id: 'USERS', label: `Utilizadores (${users.length})` },
          { id: 'SETTINGS', label: 'Dados Fiscais, Regime IVA e Séries' },
          { id: 'AUDIT', label: 'Registo de Auditoria' },
          { id: 'BACKUP', label: 'AGT / SAF-T (AO) e Cópias de Segurança' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as any)}
            className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === t.id
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'USERS' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={openCreateUser}
              className="min-h-[40px] px-4 py-2 bg-green-700 hover:bg-green-800 text-white text-xs font-medium rounded-lg flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              Novo Utilizador
            </button>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                    <th className="py-3 px-4 font-medium">Nome / Utilizador</th>
                    <th className="py-3 px-3 font-medium">Perfil</th>
                    <th className="py-3 px-3 font-medium">Permissões Configuradas</th>
                    <th className="py-3 px-3 font-medium">Estado</th>
                    <th className="py-3 px-4 font-medium text-right">Editar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{u.fullName}</div>
                        <div className="font-mono text-slate-500 dark:text-slate-400">@{u.username}</div>
                      </td>
                      <td className="py-3 px-3 font-medium text-slate-800 dark:text-slate-200">
                        {u.role === 'ADMIN' ? 'Administrador' : 'Vendedor / Farmacêutico'}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {u.role === 'ADMIN' ? (
                          'Acesso total'
                        ) : (
                          <span>
                            Desc. máx: {u.permissions.canDiscount ? `${u.permissions.maxDiscountPercent}%` : 'Não'} ·{' '}
                            Devoluções: {u.permissions.canProcessReturns ? 'Sim' : 'Não'} ·{' '}
                            Anulações: {u.permissions.canCancelSales ? 'Sim' : 'Não'}
                            {u.permissions.canConfigureProductVat ? ' · Config. IVA Produtos' : ''}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={
                            u.active
                              ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                              : 'text-red-700 dark:text-red-400 font-medium'
                          }
                        >
                          {u.active ? 'Ativo' : 'Desativado'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => openEditUser(u)}
                          className="p-2 text-slate-600 dark:text-slate-300 hover:text-green-700 dark:hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                          title="Editar utilizador e palavra-passe"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'SETTINGS' && (
        <div className="space-y-5">
          {((settings.vatRegime || 'NAO_CONFIGURADO') === 'NAO_CONFIGURADO' ||
            (agtStatus?.unconfiguredProductsCount ?? 0) > 0 ||
            (agtStatus?.missingIssuerFields?.length ?? 0) > 0) && (
            <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-100 space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-display font-semibold text-sm">
                    Checklist para Desbloquear a Emissão Fiscal (Faturas / FR / NC)
                  </div>
                  <p className="text-[11px] text-amber-900/90 dark:text-amber-200/90 mt-0.5">
                    Por conformidade fiscal, o sistema não escolhe o regime nem taxas de IVA automaticamente. Conclua os passos abaixo com a informação confirmada pelo contabilista:
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-amber-200 dark:border-amber-800/80 flex flex-col justify-between gap-2">
                  <div>
                    <div className="font-semibold">1. Regime de IVA da Farmácia</div>
                    <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
                      Atual:{' '}
                      <strong className="font-mono">
                        {settings.vatRegime || 'NAO_CONFIGURADO'}
                      </strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.getElementById('vat-regime-section');
                      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      setTimeout(() => {
                        document.getElementById('vat-regime-select')?.focus();
                      }, 250);
                    }}
                    className="self-start px-2.5 py-1 rounded-md bg-amber-700 hover:bg-amber-800 text-white font-medium text-[11px]"
                  >
                    {(settings.vatRegime || 'NAO_CONFIGURADO') === 'NAO_CONFIGURADO'
                      ? 'Selecionar Regime e Guardar'
                      : 'Rever Regime'}
                  </button>
                </div>
                <div className="p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-amber-200 dark:border-amber-800/80 flex flex-col justify-between gap-2">
                  <div>
                    <div className="font-semibold">2. Tabela de Taxas / Isenções</div>
                    <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
                      {(settings.taxRules || []).length} regra(s) configurada(s)
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={openNewTaxRule}
                    className="self-start px-2.5 py-1 rounded-md bg-white dark:bg-slate-800 border border-amber-300 dark:border-amber-700 hover:bg-amber-100/70 dark:hover:bg-slate-700 text-amber-950 dark:text-amber-100 font-medium text-[11px]"
                  >
                    + Nova Regra de IVA
                  </button>
                </div>
                <div className="p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-amber-200 dark:border-amber-800/80 flex flex-col justify-between gap-2">
                  <div>
                    <div className="font-semibold">3. IVA dos Produtos no Catálogo</div>
                    <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
                      {(agtStatus?.unconfiguredProductsCount ?? 0) > 0
                        ? `${agtStatus?.unconfiguredProductsCount} produto(s) ativo(s) sem IVA`
                        : 'Todos os produtos ativos configurados'}
                    </div>
                  </div>
                  {onOpenProductsNoTax && (
                    <button
                      type="button"
                      onClick={onOpenProductsNoTax}
                      className="self-start px-2.5 py-1 rounded-md bg-green-700 hover:bg-green-800 text-white font-medium text-[11px]"
                    >
                      Configurar Produtos (individual ou lote)
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <form
            onSubmit={handleSaveSettings}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6 text-xs"
          >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Nome Comercial / Marca
              </label>
              <input
                required
                value={setForm.pharmacyName}
                onChange={(e) => setSetForm({ ...setForm, pharmacyName: e.target.value })}
                className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Denominação Legal (Sociedade / Empresário)
              </label>
              <input
                value={setForm.legalName || ''}
                onChange={(e) => setSetForm({ ...setForm, legalName: e.target.value })}
                placeholder="ex.: Farmácia Âncora, Lda."
                className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">NIF</label>
              <input
                value={setForm.nif}
                onChange={(e) => setSetForm({ ...setForm, nif: e.target.value })}
                className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Estabelecimento Emissor
              </label>
              <input
                value={setForm.establishmentName || ''}
                onChange={(e) => setSetForm({ ...setForm, establishmentName: e.target.value })}
                placeholder="ex.: Sede / Balcão Principal"
                className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Código do Estabelecimento / CAE
              </label>
              <input
                value={setForm.establishmentCode || ''}
                onChange={(e) => setSetForm({ ...setForm, establishmentCode: e.target.value })}
                placeholder="ex.: EST-01"
                className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Telefone</label>
              <input
                value={setForm.phone}
                onChange={(e) => setSetForm({ ...setForm, phone: e.target.value })}
                className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">E-mail Fiscal</label>
              <input
                type="email"
                value={setForm.email}
                onChange={(e) => setSetForm({ ...setForm, email: e.target.value })}
                className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Moeda</label>
              <select
                value={setForm.currencySymbol}
                onChange={(e) => setSetForm({ ...setForm, currencySymbol: e.target.value })}
                className="w-full min-h-[38px] px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="Kz">Kwanza (Kz)</option>
                <option value="€">Euro (€)</option>
                <option value="MT">Metical (MT)</option>
                <option value="CVE">Escudo Cabo-Verdiano (CVE)</option>
                <option value="$">Dólar ($)</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Sede ou Domicílio
              </label>
              <input
                value={setForm.address}
                onChange={(e) => setSetForm({ ...setForm, address: e.target.value })}
                className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Cidade / Município</label>
                <input
                  value={setForm.city || ''}
                  onChange={(e) => setSetForm({ ...setForm, city: e.target.value })}
                  placeholder="Luanda"
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">País</label>
                <input
                  value={setForm.country || 'AO'}
                  onChange={(e) => setSetForm({ ...setForm, country: e.target.value })}
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>
          </div>

          <div
            id="vat-regime-section"
            className={`border-t border-slate-200 dark:border-slate-800 pt-5 space-y-3 ${
              (setForm.vatRegime || 'NAO_CONFIGURADO') === 'NAO_CONFIGURADO'
                ? 'rounded-lg p-4 bg-amber-50/50 dark:bg-amber-950/20 border border-amber-300 dark:border-amber-800'
                : ''
            }`}
          >
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
              Regime Fiscal de IVA e Facturação Electrónica (DP 71/25)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="vat-regime-select"
                  className="block font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  Regime de IVA Confirmado
                </label>
                <select
                  id="vat-regime-select"
                  value={setForm.vatRegime || 'NAO_CONFIGURADO'}
                  onChange={(e) => setSetForm({ ...setForm, vatRegime: e.target.value as VatRegime })}
                  className={`w-full min-h-[38px] px-3 py-1.5 border rounded-lg text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 ${
                    (setForm.vatRegime || 'NAO_CONFIGURADO') === 'NAO_CONFIGURADO'
                      ? 'border-amber-500 dark:border-amber-600 ring-2 ring-amber-400/30'
                      : 'border-slate-300 dark:border-slate-700'
                  }`}
                >
                  <option value="NAO_CONFIGURADO">Não configurado (requer confirmação do contabilista)</option>
                  <option value="GERAL">Regime Geral de IVA</option>
                  <option value="SIMPLIFICADO">Regime Simplificado</option>
                  <option value="EXCLUSAO">Regime de Exclusão</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Preços no Catálogo
                </label>
                <select
                  value={setForm.pricesIncludeTax ? 'INCLUDED' : 'EXCLUDED'}
                  onChange={(e) =>
                    setSetForm({ ...setForm, pricesIncludeTax: e.target.value === 'INCLUDED' })
                  }
                  className="w-full min-h-[38px] px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                >
                  <option value="EXCLUDED">Preço base sem IVA (acresce IVA se produto tributado)</option>
                  <option value="INCLUDED">Preço de venda já inclui IVA</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Motivo / Observação da Alteração Fiscal (registado no histórico)
                </label>
                <input
                  value={settingsChangeReason}
                  onChange={(e) => setSettingsChangeReason(e.target.value)}
                  placeholder="ex.: Enquadramento confirmado pelo contabilista / AGT em..."
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-slate-100"
                />
              </div>
              <label className="sm:col-span-2 flex items-center gap-2 text-slate-800 dark:text-slate-200 font-medium">
                <input
                  type="checkbox"
                  checked={Boolean(setForm.agtElectronicInvoicingEnabled)}
                  onChange={(e) =>
                    setSetForm({ ...setForm, agtElectronicInvoicingEnabled: e.target.checked })
                  }
                />
                <span>Adesão ao regime de Facturação Electrónica da AGT confirmada pelo contribuinte</span>
              </label>
            </div>
            {agtStatus && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-950 dark:text-amber-200 space-y-1">
                <div>
                  <strong>Lista Oficial de Software Validado da AGT:</strong>{' '}
                  {agtStatus.officiallyValidatedOnAgtList
                    ? 'Confirmado'
                    : 'NÃO VALIDADO (o Âncora SMS ainda não consta na lista pública oficial da AGT)'}
                </div>
                <div>
                  <strong>Estado técnico AGT:</strong> {agtStatus.certifiedDisclaimer}
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 dark:border-slate-800 pt-5 space-y-3">
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
              Séries Internas Provisórias (Não Oficiais) e Numeração Cronológica por Ano Fiscal
            </h3>
            <p className="text-slate-500 dark:text-slate-400">
              Numeração sequencial interna por tipo de documento e ano fiscal (<span className="font-mono">INTERNA_NAO_OFICIAL</span>). Números emitidos nunca são reutilizados nem reduzidos. As séries oficiais para Facturação Electrónica são solicitadas diretamente à AGT no separador <strong>AGT / SAF-T (AO)</strong> (<span className="font-mono">solicitarSerie</span>).
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Ano Fiscal da Série</label>
                <input
                  type="number"
                  min={2020}
                  value={setForm.series.seriesYear || new Date().getFullYear()}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, seriesYear: Number(e.target.value) },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Prefixo Fatura-Recibo (FR)</label>
                <input
                  value={setForm.series.invoiceReciboPrefix || 'FR 2026'}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, invoiceReciboPrefix: e.target.value },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Próx. Nº FR</label>
                <input
                  type="number"
                  min={settings.series.invoiceReciboNext || 1}
                  value={setForm.series.invoiceReciboNext || 1}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, invoiceReciboNext: Number(e.target.value) },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Prefixo Fatura (FT)</label>
                <input
                  value={setForm.series.invoicePrefix}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, invoicePrefix: e.target.value },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Próx. Nº FT</label>
                <input
                  type="number"
                  min={settings.series.invoiceNext}
                  value={setForm.series.invoiceNext}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, invoiceNext: Number(e.target.value) },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Prefixo Recibos (RC)</label>
                <input
                  value={setForm.series.receiptPrefix || 'RC 2026'}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, receiptPrefix: e.target.value },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Próx. Nº RC</label>
                <input
                  type="number"
                  min={settings.series.receiptNext || 1}
                  value={setForm.series.receiptNext || 1}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, receiptNext: Number(e.target.value) },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Prefixo Proformas (PF)</label>
                <input
                  value={setForm.series.proformaPrefix}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, proformaPrefix: e.target.value },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Próx. Nº Proforma</label>
                <input
                  type="number"
                  min={settings.series.proformaNext}
                  value={setForm.series.proformaNext}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, proformaNext: Number(e.target.value) },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Prefixo Notas Crédito (NC)</label>
                <input
                  value={setForm.series.creditNotePrefix}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, creditNotePrefix: e.target.value },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">
                  Ref. Interna de Anulação (AN — não fiscal)
                </label>
                <input
                  value={setForm.series.cancellationPrefix}
                  onChange={(e) =>
                    setSetForm({
                      ...setForm,
                      series: { ...setForm.series, cancellationPrefix: e.target.value },
                    })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Alerta Validade (dias)</label>
                <input
                  type="number"
                  min="7"
                  value={setForm.expiryWarningDays}
                  onChange={(e) =>
                    setSetForm({ ...setForm, expiryWarningDays: Number(e.target.value) })
                  }
                  className="w-full min-h-[36px] px-2.5 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-green-700 hover:bg-green-800 text-white font-medium rounded-lg text-sm"
            >
              {saving ? 'A guardar...' : 'Guardar Configurações'}
            </button>
          </div>
        </form>

        {/* Administrable VAT Tax Rules Table */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 text-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
                Tabela Administrável de Códigos, Taxas de IVA e Motivos Legais
              </h3>
              <p className="text-slate-600 dark:text-slate-400 mt-0.5">
                Registe apenas os códigos (<span className="font-mono">NOR</span>, <span className="font-mono">INT</span>, <span className="font-mono">RED</span>, <span className="font-mono">ISE</span>, <span className="font-mono">OUT</span>), percentagens, bases legais e períodos de vigência confirmados pelo contabilista e pela AGT. Alterações futuras nunca reescrevem faturas nem notas de crédito já emitidas.
              </p>
            </div>
            <button
              type="button"
              onClick={openNewTaxRule}
              className="min-h-[38px] px-3.5 py-2 bg-green-700 hover:bg-green-800 text-white font-medium rounded-lg flex items-center gap-1.5 whitespace-nowrap self-start"
            >
              <Plus className="w-4 h-4" />
              Nova Regra de IVA
            </button>
          </div>

          <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                  <th className="py-2.5 px-3 font-medium">Código / Taxa</th>
                  <th className="py-2.5 px-3 font-medium">Descrição</th>
                  <th className="py-2.5 px-3 font-medium">Cód. Isenção / Base Legal</th>
                  <th className="py-2.5 px-3 font-medium">Vigência</th>
                  <th className="py-2.5 px-3 font-medium">Validação</th>
                  <th className="py-2.5 px-3 font-medium text-right">Editar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {(settings.taxRules || []).map((rule) => (
                  <tr key={rule.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 px-3 font-mono font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      {rule.taxCode} · {rule.rate}%
                    </td>
                    <td className="py-2.5 px-3 text-slate-800 dark:text-slate-200">
                      <div className="font-medium">{rule.description}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {rule.active ? 'Ativa' : 'Inativa'}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">
                      {rule.exemptionCode && (
                        <span className="font-mono font-semibold mr-1.5">[{rule.exemptionCode}]</span>
                      )}
                      <span>{rule.legalBasis}</span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {rule.validFrom} {rule.validTo ? `→ ${rule.validTo}` : '→ Sem termo'}
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <span
                        className={
                          rule.confirmedByAccountant
                            ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                            : 'text-amber-700 dark:text-amber-400 font-medium'
                        }
                      >
                        {rule.confirmedByAccountant ? 'Confirmada p/ Contabilista' : 'Aguarda Confirmação'}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => openEditTaxRule(rule)}
                        className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-green-700 dark:hover:text-green-400 rounded-lg"
                        title="Editar regra de IVA"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {(settings.taxRules || []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500 dark:text-slate-400">
                      Nenhuma regra de IVA configurada ainda. Adicione apenas taxas e motivos confirmados pelo contabilista da farmácia.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Fiscal Change History */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3 text-xs">
          <div>
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
              Histórico de Alterações Fiscais (Regime, Regras, Produtos e Lotes)
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mt-0.5">
              Registo imutável das alterações de enquadramento de IVA com autor, data/hora, valores anterior e novo, e motivo.
            </p>
          </div>
          <div className="overflow-x-auto max-h-72 border border-slate-200 dark:border-slate-800 rounded-lg">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                  <th className="py-2 px-3 font-medium">Data / Hora</th>
                  <th className="py-2 px-3 font-medium">Utilizador</th>
                  <th className="py-2 px-3 font-medium">Entidade</th>
                  <th className="py-2 px-3 font-medium">Alteração</th>
                  <th className="py-2 px-3 font-medium">Motivo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {(settings.fiscalHistory || []).slice(0, 100).map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2 px-3 font-mono whitespace-nowrap text-slate-600 dark:text-slate-400">
                      {formatDateTimePT(entry.timestamp)}
                    </td>
                    <td className="py-2 px-3 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      {entry.userName}
                    </td>
                    <td className="py-2 px-3 text-slate-800 dark:text-slate-200">
                      <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400 mr-1">
                        [{entry.entityType}]
                      </span>
                      {entry.entityLabel}
                    </td>
                    <td className="py-2 px-3 text-slate-700 dark:text-slate-300">
                      <span className="text-slate-500 dark:text-slate-400">{entry.previousValue}</span> →{' '}
                      <strong className="text-slate-900 dark:text-slate-100">{entry.newValue}</strong>
                    </td>
                    <td className="py-2 px-3 text-slate-600 dark:text-slate-400">{entry.reason}</td>
                  </tr>
                ))}
                {(settings.fiscalHistory || []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-500 dark:text-slate-400">
                      Ainda não foram registadas alterações fiscais.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        </div>
      )}

      {tab === 'AUDIT' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto max-h-[540px]">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                  <th className="py-3 px-4 font-medium">Data / Hora</th>
                  <th className="py-3 px-3 font-medium">Utilizador</th>
                  <th className="py-3 px-3 font-medium">Operação</th>
                  <th className="py-3 px-4 font-medium">Descrição</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="py-2.5 px-4 font-mono whitespace-nowrap text-slate-700 dark:text-slate-300">
                      {formatDateTimePT(log.timestamp)}
                    </td>
                    <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100">
                      {log.userName}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-600 dark:text-slate-400">{log.action}</td>
                    <td className="py-2.5 px-4 text-slate-700 dark:text-slate-300">{log.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'BACKUP' && (
        <div className="space-y-4">
          {/* AGT & SAF-T (AO) Compliance & Export Panel */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  <FileCode2 className="w-4 h-4 text-green-700 dark:text-green-400" />
                  Conformidade Fiscal Angola (DP 71/25 · AGT FE Schema 2.0 · SAF-T AO 1.01_01)
                </h3>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                  Monitorização real de prontidão fiscal, credenciais AGT do servidor (nunca expostas no navegador) e exportação SAF-T (AO).
                </p>
              </div>
              <span
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap self-start ${
                  agtStatus?.certified && agtStatus?.officiallyValidatedOnAgtList
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                    : agtStatus?.homologationConfigured
                    ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-800 dark:text-sky-300 border border-sky-200 dark:border-sky-800'
                    : 'bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                }`}
              >
                {agtStatus?.certified && agtStatus?.officiallyValidatedOnAgtList
                  ? `Validação Oficial AGT (${agtStatus.environment})`
                  : agtStatus?.homologationConfigured
                  ? 'Homologação AGT (Não Certificado Comercialmente)'
                  : 'NÃO CERTIFICADO PELA AGT (Modo Rascunho)'}
              </span>
            </div>

            {agtStatus && (
              <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-200 space-y-2">
                <div className="flex items-start gap-2 font-semibold">
                  <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                  <span>{agtStatus.certifiedDisclaimer}</span>
                </div>
                <div className="pl-6 text-[11px] flex flex-wrap gap-x-5 gap-y-1">
                  <span>
                    Ambiente: <strong className="font-mono">{agtStatus.environment}</strong>
                  </span>
                  <span>
                    Lista Oficial de Software Validado da AGT:{' '}
                    <strong>{agtStatus.officiallyValidatedOnAgtList ? 'Confirmado' : 'Não (Sem validação comercial)'}</strong>
                  </span>
                </div>
                {agtStatus.missingRequirements.length > 0 && (
                  <div className="pl-6 space-y-1">
                    <div className="font-medium text-[11px]">
                      Requisitos externos no servidor (dependem de homologação/adesão e segredos da AGT):
                    </div>
                    <ul className="list-disc pl-4 space-y-0.5 text-[11px]">
                      {agtStatus.missingRequirements.map((reqItem) => (
                        <li key={reqItem}>{reqItem}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(agtStatus.missingIssuerFields.length > 0 ||
                  agtStatus.vatRegime === 'NAO_CONFIGURADO' ||
                  agtStatus.unconfiguredProductsCount > 0) && (
                  <div className="pl-6 pt-1 space-y-1.5 border-t border-amber-200/70 dark:border-amber-800/70 text-[11px]">
                    <div className="font-semibold">
                      Pendências que o Administrador pode configurar já na aplicação (após confirmar com o contabilista):
                    </div>
                    {agtStatus.missingIssuerFields.length > 0 && (
                      <div>• Dados da farmácia em falta: {agtStatus.missingIssuerFields.join(', ')}.</div>
                    )}
                    {agtStatus.vatRegime === 'NAO_CONFIGURADO' && (
                      <div>• Regime de IVA ainda não confirmado nas configurações fiscais.</div>
                    )}
                    {agtStatus.unconfiguredProductsCount > 0 && (
                      <div>
                        • {agtStatus.unconfiguredProductsCount} produto(s) ativo(s) ainda sem código/taxa de IVA atribuída.
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {(agtStatus.vatRegime === 'NAO_CONFIGURADO' || agtStatus.missingIssuerFields.length > 0) && (
                        <button
                          type="button"
                          onClick={() => setTab('SETTINGS')}
                          className="px-2.5 py-1 rounded-md bg-amber-700 hover:bg-amber-800 text-white font-medium text-[11px]"
                        >
                          Configurar Dados Fiscais e Regime de IVA
                        </button>
                      )}
                      {agtStatus.unconfiguredProductsCount > 0 && onOpenProductsNoTax && (
                        <button
                          type="button"
                          onClick={onOpenProductsNoTax}
                          className="px-2.5 py-1 rounded-md bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 hover:bg-amber-100/60 dark:hover:bg-amber-900/40 text-amber-950 dark:text-amber-100 font-medium text-[11px]"
                        >
                          Configurar IVA dos Produtos ({agtStatus.unconfiguredProductsCount})
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Solicitar Série AGT (DE 683/25) */}
            <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3 text-xs">
              <div>
                <h4 className="font-display font-semibold text-slate-900 dark:text-slate-100">
                  Solicitar Série Electrónica na AGT (Decreto Executivo n.º 683/25 — <span className="font-mono">solicitarSerie</span>)
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Apenas séries de documentos fiscais aceites pela AGT (<span className="font-mono">FT</span>, <span className="font-mono">FR</span>, <span className="font-mono">NC</span>, <span className="font-mono">ND</span>, <span className="font-mono">RC</span>). Proformas (<span className="font-mono">PF</span>) e referências internas (<span className="font-mono">AN</span>) não são séries fiscais AGT.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1">Tipo Documento</label>
                  <select
                    value={seriesDocType}
                    onChange={(e) => setSeriesDocType(e.target.value as any)}
                    className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                  >
                    <option value="FR">FR — Fatura-Recibo</option>
                    <option value="FT">FT — Fatura</option>
                    <option value="NC">NC — Nota de Crédito</option>
                    <option value="ND">ND — Nota de Débito</option>
                    <option value="RC">RC — Recibo</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1">Ano da Série</label>
                  <input
                    type="number"
                    min={2024}
                    value={seriesReqYear}
                    onChange={(e) => setSeriesReqYear(Number(e.target.value))}
                    className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1">Estabelecimento</label>
                  <input
                    value={seriesEstablishment}
                    onChange={(e) => setSeriesEstablishment(e.target.value)}
                    placeholder="EST-01"
                    className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 dark:text-slate-400 mb-1">Indicador</label>
                  <select
                    value={seriesContingency}
                    onChange={(e) => setSeriesContingency(e.target.value as 'N' | 'C')}
                    className="w-full min-h-[38px] px-2.5 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    <option value="N">Normal (N)</option>
                    <option value="C">Contingência (C)</option>
                  </select>
                </div>
                <button
                  type="button"
                  disabled={requestingSeries || !agtStatus?.configured}
                  onClick={handleRequestAgtSeries}
                  className="min-h-[38px] px-3 py-2 bg-slate-800 hover:bg-slate-900 dark:bg-slate-700 dark:hover:bg-slate-600 disabled:opacity-50 text-white font-medium rounded-lg whitespace-nowrap"
                >
                  {requestingSeries ? 'A solicitar...' : 'Solicitar Série AGT'}
                </button>
              </div>
              {seriesRequestResult && (
                <div
                  className={`p-2.5 rounded-lg border text-[11px] ${
                    seriesRequestResult.ok
                      ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                      : 'bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                  }`}
                >
                  {seriesRequestResult.message}
                </div>
              )}
              {(settings.series.agtSeries || []).length > 0 && (
                <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-left text-slate-600 dark:text-slate-300">
                        <th className="py-2 px-3 font-medium">Série</th>
                        <th className="py-2 px-3 font-medium">Tipo / Ano</th>
                        <th className="py-2 px-3 font-medium">Estabelecimento</th>
                        <th className="py-2 px-3 font-medium">Origem / Ambiente</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {(settings.series.agtSeries || []).map((s, idx) => (
                        <tr key={`${s.seriesCode}-${idx}`}>
                          <td className="py-2 px-3 font-mono font-semibold text-slate-900 dark:text-slate-100">
                            {s.seriesCode}
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-700 dark:text-slate-300">
                            {s.documentType} · {s.seriesYear} ({s.seriesContingencyIndicator})
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-700 dark:text-slate-300">
                            {s.establishmentNumber}
                          </td>
                          <td className="py-2 px-3 text-slate-600 dark:text-slate-400">
                            {s.source} ({s.environment})
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end text-xs border-t border-slate-200 dark:border-slate-800 pt-4">
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Data Inicial SAF-T (AO)</label>
                <input
                  type="date"
                  value={saftStartDate}
                  onChange={(e) => setSaftStartDate(e.target.value)}
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">Data Final SAF-T (AO)</label>
                <input
                  type="date"
                  value={saftEndDate}
                  onChange={(e) => setSaftEndDate(e.target.value)}
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <button
                type="button"
                disabled={exportingSaft}
                onClick={handleExportSaftAo}
                className="min-h-[38px] px-4 py-2 bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white font-medium rounded-lg flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                {exportingSaft ? 'A gerar XML...' : 'Exportar SAF-T (AO) 1.01_01 (.xml)'}
              </button>
            </div>

            {saftExportResult && (
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-slate-900 dark:text-slate-100">
                    Ficheiro gerado: <span className="font-mono">{saftExportResult.filename}</span>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                      saftExportResult.summary.saftCompliant
                        ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
                        : 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
                    }`}
                  >
                    {saftExportResult.summary.saftCompliant
                      ? 'SAF-T Estruturalmente Conforme'
                      : 'Exportação Preparatória (Pendências Fiscais)'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-600 dark:text-slate-400">
                  Faturas/NC: {saftExportResult.summary.invoicesAndCreditNotesCount} · Proformas (PF):{' '}
                  {saftExportResult.summary.workingDocumentsCount} · Recibos (RC):{' '}
                  {saftExportResult.summary.paymentsCount}
                  {saftExportResult.summary.structureValid !== undefined && (
                    <>
                      {' '}
                      · Estrutura XML:{' '}
                      <strong
                        className={
                          saftExportResult.summary.structureValid
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }
                      >
                        {saftExportResult.summary.structureValid ? 'Válida (1.01_01)' : 'Com inconsistências'}
                      </strong>
                    </>
                  )}
                </div>
                {saftExportResult.summary.structureErrors && saftExportResult.summary.structureErrors.length > 0 && (
                  <div className="text-[11px] text-red-700 dark:text-red-300 space-y-0.5">
                    <div className="font-semibold">Erros estruturais SAF-T XML:</div>
                    <ul className="list-disc pl-5 space-y-0.5">
                      {saftExportResult.summary.structureErrors.map((errMsg, i) => (
                        <li key={i}>{errMsg}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {saftExportResult.summary.blockingIssues?.length > 0 && (
                  <div className="text-[11px] text-red-700 dark:text-red-300 space-y-0.5">
                    <div className="font-semibold">Bloqueios de conformidade SAF-T oficial:</div>
                    <ul className="list-disc pl-5 space-y-0.5">
                      {saftExportResult.summary.blockingIssues.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(() => {
                  const blockingSet = new Set(saftExportResult.summary.blockingIssues || []);
                  const extraWarnings = saftExportResult.warnings.filter((w) => !blockingSet.has(w));
                  if (extraWarnings.length === 0) return null;
                  return (
                    <ul className="list-disc pl-5 text-[11px] text-amber-800 dark:text-amber-300 space-y-0.5">
                      {extraWarnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  <CloudUpload className="w-4 h-4 text-green-700 dark:text-green-400" />
                  Cópias de Segurança Automáticas Diárias (Armazenamento Externo)
                </h3>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                  Envio encriptado/comprimido para bucket compatível com S3 (Google Cloud Storage, R2, S3) com retenção configurável. Credenciais configuradas apenas nos segredos do servidor.
                </p>
              </div>
              <span
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap self-start ${
                  autoBackupStatus?.storageConfigured
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                    : 'bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                }`}
              >
                {autoBackupStatus?.storageConfigured
                  ? `Destino configurado (${autoBackupStatus.bucket})`
                  : 'Armazenamento externo pendente de segredos no servidor'}
              </span>
            </div>

            <form onSubmit={handleSaveBackupPolicy} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end text-xs">
              <label className="flex items-center gap-2 min-h-[38px] text-slate-800 dark:text-slate-200 font-medium">
                <input
                  type="checkbox"
                  checked={backupPolicyForm.enabled}
                  onChange={(e) =>
                    setBackupPolicyForm({ ...backupPolicyForm, enabled: e.target.checked })
                  }
                />
                <span>Ativar cópia diária automática</span>
              </label>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">
                  Retenção (dias)
                </label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={backupPolicyForm.retentionDays}
                  onChange={(e) =>
                    setBackupPolicyForm({
                      ...backupPolicyForm,
                      retentionDays: Number(e.target.value),
                    })
                  }
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-400 mb-1">
                  Hora diária (UTC 0-23)
                </label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={backupPolicyForm.dailyHourUTC}
                  onChange={(e) =>
                    setBackupPolicyForm({
                      ...backupPolicyForm,
                      dailyHourUTC: Number(e.target.value),
                    })
                  }
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 min-h-[38px] px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 font-medium rounded-lg"
                >
                  Guardar Política
                </button>
                <button
                  type="button"
                  disabled={runningAutoBackup || !autoBackupStatus?.storageConfigured}
                  onClick={handleRunExternalBackupNow}
                  className="flex-1 min-h-[38px] px-3 py-1.5 bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white font-medium rounded-lg whitespace-nowrap"
                >
                  {runningAutoBackup ? 'A enviar...' : 'Executar Agora'}
                </button>
              </div>
            </form>

            {autoBackupStatus && (
              <div className="space-y-2.5 border-t border-slate-200 dark:border-slate-800 pt-3">
                <div className="text-[11px] text-slate-600 dark:text-slate-400 flex flex-wrap gap-x-6 gap-y-1">
                  <span>
                    Encriptação AES-256:{' '}
                    <strong className="text-slate-800 dark:text-slate-200">
                      {autoBackupStatus.encryptionEnabled ? 'Ativa' : 'Opcional (sem chave)'}
                    </strong>
                  </span>
                  <span>
                    Endpoint Cron:{' '}
                    <strong className="text-slate-800 dark:text-slate-200">
                      {autoBackupStatus.cronEndpointConfigured ? 'Protegido por segredo' : 'Pendente'}
                    </strong>
                  </span>
                  <span>
                    Última execução:{' '}
                    <strong className="text-slate-800 dark:text-slate-200">
                      {autoBackupStatus.policy.lastRunAt
                        ? `${formatDateTimePT(autoBackupStatus.policy.lastRunAt)} — ${
                            autoBackupStatus.policy.lastStatus === 'SUCCESS'
                              ? 'Concluída com sucesso'
                              : autoBackupStatus.policy.lastStatus === 'ERROR'
                              ? 'Falhou'
                              : 'Nunca executada'
                          }`
                        : 'Nunca executada'}
                    </strong>
                  </span>
                </div>

                {!autoBackupStatus.storageConfigured && autoBackupStatus.missingRequirements.length > 0 && (
                  <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-xs text-amber-950 dark:text-amber-200 space-y-1">
                    <div className="font-semibold">
                      Cópia automática externa indisponível neste momento — falta configurar no servidor:
                    </div>
                    <ul className="list-disc pl-5 space-y-0.5 text-[11px]">
                      {autoBackupStatus.missingRequirements.map((reqItem) => (
                        <li key={reqItem}>{reqItem}</li>
                      ))}
                    </ul>
                    <div className="text-[11px] opacity-90 pt-0.5">
                      As credenciais ficam apenas nas variáveis de ambiente do servidor e nunca são expostas ao navegador. Enquanto não configurar armazenamento externo, utilize a exportação manual abaixo.
                    </div>
                  </div>
                )}

                {autoBackupActionResult && (
                  <div
                    role={autoBackupActionResult.ok ? 'status' : 'alert'}
                    className={`p-2.5 rounded-lg border text-xs ${
                      autoBackupActionResult.ok
                        ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                        : 'bg-red-50 dark:bg-red-950/60 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
                    }`}
                  >
                    {autoBackupActionResult.message} ({formatDateTimePT(autoBackupActionResult.at)})
                  </div>
                )}

                {autoBackupStatus.policy.lastError && !autoBackupActionResult && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-xs text-red-900 dark:text-red-200">
                    Último erro registado: {autoBackupStatus.policy.lastError}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
              Exportar Cópia de Segurança
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Descarregue um ficheiro JSON completo com produtos, vendas, proformas, compras, inventários, caixas, fechos e utilizadores.
            </p>
            <button
              type="button"
              onClick={handleExportBackup}
              className="w-full min-h-[40px] px-4 py-2 bg-green-700 hover:bg-green-800 text-white text-xs font-medium rounded-lg flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              Descarregar Cópia (.json)
            </button>
            {manualBackupResult ? (
              <div
                role={manualBackupResult.ok ? 'status' : 'alert'}
                className={`p-2.5 rounded-lg border text-[11px] ${
                  manualBackupResult.ok
                    ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                    : 'bg-red-50 dark:bg-red-950/60 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
                }`}
              >
                {manualBackupResult.message} ({formatDateTimePT(manualBackupResult.at)})
              </div>
            ) : lastManualBackupLog ? (
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Última cópia manual registada: {formatDateTimePT(lastManualBackupLog.timestamp)} por {lastManualBackupLog.userName}
              </div>
            ) : (
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Nenhuma cópia manual exportada neste histórico ainda.
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
              Restaurar Base de Dados
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Carregue um ficheiro de cópia de segurança gerado anteriormente para recuperar todos os registos.
            </p>
            <label className="w-full min-h-[40px] px-4 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-medium rounded-lg flex items-center justify-center gap-2 cursor-pointer">
              <Upload className="w-4 h-4" />
              Selecionar Ficheiro (.json)
              <input type="file" accept=".json,application/json" onChange={handleRestoreFile} className="hidden" />
            </label>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
              Mudar para Produção (Limpar Demonstração)
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Remove apenas os utilizadores, produtos, vendas e registos marcados como demonstração, mantendo a sua conta e todos os dados reais inseridos.
            </p>
            {!confirmClearDemo ? (
              <button
                type="button"
                onClick={() => setConfirmClearDemo(true)}
                className="w-full min-h-[40px] px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded-lg flex items-center justify-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Limpar Dados de Demonstração
              </button>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmClearDemo(false)}
                  className="flex-1 min-h-[40px] px-3 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-medium rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleClearDemo}
                  className="flex-1 min-h-[40px] px-3 py-2 bg-red-700 hover:bg-red-800 text-white text-xs font-medium rounded-lg"
                >
                  {saving ? 'A limpar...' : 'Confirmar Limpeza'}
                </button>
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-slate-100">
              Repor Dados de Demonstração
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Reinicia a base de dados para o estado inicial de demonstração (apenas para testes).
            </p>
            <button
              type="button"
              onClick={handleResetDemo}
              className="w-full min-h-[40px] px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-medium rounded-lg flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Repor Demonstração
            </button>
          </div>
        </div>
        </div>
      )}

      {/* User Create/Edit Modal */}
      {showUserModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 my-8 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-green-700 dark:text-green-400" />
                <h2 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                  {editingUser ? `Editar Utilizador (${editingUser.username})` : 'Criar Utilizador'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowUserModal(false)}
                className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveUser} className="space-y-3 text-xs">
              {!editingUser && (
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Identificador de Acesso (login) *
                  </label>
                  <input
                    required
                    value={uUsername}
                    onChange={(e) => setUUsername(e.target.value)}
                    placeholder="ex.: carlos.silva"
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>
              )}
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Nome Completo *
                </label>
                <input
                  required
                  value={uFullName}
                  onChange={(e) => setUFullName(e.target.value)}
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">Perfil</label>
                  <select
                    value={uRole}
                    onChange={(e) => setURole(e.target.value as UserRole)}
                    className="w-full min-h-[38px] px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100"
                  >
                    <option value="SELLER">Vendedor / Farmacêutico</option>
                    <option value="ADMIN">Administrador</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {editingUser ? 'Nova Palavra-passe (opcional)' : 'Palavra-passe *'}
                  </label>
                  <input
                    type="password"
                    required={!editingUser}
                    value={uPassword}
                    onChange={(e) => setUPassword(e.target.value)}
                    placeholder="Mín. 4 caracteres"
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              {editingUser && editingUser.id !== currentUser.id && (
                <label className="flex items-center gap-2 pt-1 text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={uActive}
                    onChange={(e) => setUActive(e.target.checked)}
                    className="rounded border-slate-300 dark:border-slate-700"
                  />
                  <span>Conta ativa (pode iniciar sessão)</span>
                </label>
              )}

              {uRole === 'SELLER' && (
                <div className="p-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg space-y-2.5 text-slate-700 dark:text-slate-300">
                  <p className="font-semibold text-slate-800 dark:text-slate-200">
                    Permissões do Vendedor/Farmacêutico
                  </p>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={uPerms.canDiscount}
                      onChange={(e) => setUPerms({ ...uPerms, canDiscount: e.target.checked })}
                    />
                    <span>Permitir aplicar descontos</span>
                  </label>
                  {uPerms.canDiscount && (
                    <div className="flex items-center gap-2 pl-5">
                      <span>Desconto máximo (%):</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={uPerms.maxDiscountPercent}
                        onChange={(e) =>
                          setUPerms({ ...uPerms, maxDiscountPercent: Number(e.target.value) })
                        }
                        className="w-16 px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded font-mono text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  )}
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={uPerms.canProcessReturns}
                      onChange={(e) =>
                        setUPerms({ ...uPerms, canProcessReturns: e.target.checked })
                      }
                    />
                    <span>Pode registar devoluções</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={uPerms.canCancelSales}
                      onChange={(e) =>
                        setUPerms({ ...uPerms, canCancelSales: e.target.checked })
                      }
                    />
                    <span>Pode anular faturas</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={uPerms.canViewPurchases}
                      onChange={(e) =>
                        setUPerms({ ...uPerms, canViewPurchases: e.target.checked })
                      }
                    />
                    <span>Pode consultar histórico de compras</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={uPerms.canStartInventoryCount}
                      onChange={(e) =>
                        setUPerms({ ...uPerms, canStartInventoryCount: e.target.checked })
                      }
                    />
                    <span>Pode realizar contagens de inventário</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(uPerms.canConfigureProductVat)}
                      onChange={(e) =>
                        setUPerms({ ...uPerms, canConfigureProductVat: e.target.checked })
                      }
                    />
                    <span>Pode configurar/rever enquadramento de IVA dos produtos e lotes</span>
                  </label>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowUserModal(false)}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-green-700 hover:bg-green-800 text-white rounded-lg font-medium"
                >
                  {saving ? 'A guardar...' : 'Guardar Utilizador'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tax Rule Modal */}
      {showRuleModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 my-8 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                {editingRule ? 'Editar Regra Fiscal de IVA' : 'Nova Regra Fiscal de IVA'}
              </h2>
              <button
                type="button"
                onClick={() => setShowRuleModal(false)}
                className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveTaxRule} className="space-y-3 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Código Fiscal AGT *
                  </label>
                  <select
                    value={ruleForm.taxCode}
                    onChange={(e) => {
                      const nextCode = e.target.value as Exclude<TaxCode, 'NAO_CONFIGURADO'>;
                      setRuleForm({
                        ...ruleForm,
                        taxCode: nextCode,
                        rate: nextCode === 'ISE' ? '0' : ruleForm.rate,
                      });
                    }}
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    <option value="NOR">NOR — Taxa Normal (&gt; 0%)</option>
                    <option value="INT">INT — Taxa Intermédia (&gt; 0%)</option>
                    <option value="RED">RED — Taxa Reduzida (&gt; 0%)</option>
                    <option value="ISE">ISE — Isento (0%)</option>
                    <option value="OUT">OUT — Outro / Sem liquidação</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Taxa de IVA (%) *
                  </label>
                  <input
                    required
                    type="number"
                    min={ruleForm.taxCode === 'ISE' || ruleForm.taxCode === 'OUT' ? '0' : '0.01'}
                    max="100"
                    step="0.01"
                    disabled={ruleForm.taxCode === 'ISE'}
                    value={ruleForm.taxCode === 'ISE' ? '0' : ruleForm.rate}
                    onChange={(e) => setRuleForm({ ...ruleForm, rate: e.target.value })}
                    placeholder="Indique a percentagem confirmada"
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Descrição da Regra *
                </label>
                <input
                  required
                  value={ruleForm.description}
                  onChange={(e) => setRuleForm({ ...ruleForm, description: e.target.value })}
                  placeholder="ex.: Taxa normal geral / Medicamentos isentos conforme CIVA"
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>

              {(ruleForm.taxCode === 'ISE' ||
                (ruleForm.taxCode === 'OUT' && ruleForm.rate.trim() !== '' && Number(ruleForm.rate) === 0)) && (
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Código de Isenção / Motivo AGT {ruleForm.taxCode === 'ISE' ? '*' : '(opcional)'}
                  </label>
                  <input
                    required={ruleForm.taxCode === 'ISE'}
                    value={ruleForm.exemptionCode}
                    onChange={(e) => setRuleForm({ ...ruleForm, exemptionCode: e.target.value })}
                    placeholder="Código oficial confirmado na tabela AGT"
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                  />
                </div>
              )}

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Base Legal Confirmada *
                </label>
                <input
                  required
                  value={ruleForm.legalBasis}
                  onChange={(e) => setRuleForm({ ...ruleForm, legalBasis: e.target.value })}
                  placeholder="Artigo / diploma legal confirmado pelo contabilista"
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Início de Vigência *
                  </label>
                  <input
                    required
                    type="date"
                    value={ruleForm.validFrom}
                    onChange={(e) => setRuleForm({ ...ruleForm, validFrom: e.target.value })}
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Fim de Vigência (opcional)
                  </label>
                  <input
                    type="date"
                    value={ruleForm.validTo}
                    onChange={(e) => setRuleForm({ ...ruleForm, validTo: e.target.value })}
                    className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg font-mono text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Motivo da criação / alteração
                </label>
                <input
                  value={ruleForm.changeReason}
                  onChange={(e) => setRuleForm({ ...ruleForm, changeReason: e.target.value })}
                  placeholder="Registado no histórico fiscal"
                  className="w-full min-h-[38px] px-3 py-1.5 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>

              <div className="space-y-1.5 pt-1 text-slate-800 dark:text-slate-200">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ruleForm.active}
                    onChange={(e) => setRuleForm({ ...ruleForm, active: e.target.checked })}
                  />
                  <span>Regra ativa para seleção e emissão fiscal</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ruleForm.confirmedByAccountant}
                    onChange={(e) =>
                      setRuleForm({ ...ruleForm, confirmedByAccountant: e.target.checked })
                    }
                  />
                  <span>Confirmada pelo contabilista / enquadramento oficial da farmácia</span>
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowRuleModal(false)}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingRule}
                  className="px-4 py-2 bg-green-700 hover:bg-green-800 text-white rounded-lg font-medium"
                >
                  {savingRule ? 'A guardar...' : 'Guardar Regra Fiscal'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
