import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  Building2,
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Moon,
  Package,
  PackagePlus,
  RefreshCw,
  RotateCcw,
  Settings,
  ShoppingCart,
  Sun,
  Unlock,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { AdminSettingsView } from './components/AdminSettingsView';
import { BrandLogo } from './components/BrandLogo';
import { ClosingsView } from './components/ClosingsView';
import { CustomersView } from './components/CustomersView';
import { DashboardView, type NavSection } from './components/DashboardView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { InventoryView } from './components/InventoryView';
import { LockOverlay, SwitchUserModal } from './components/LockOverlay';
import { LoginScreen } from './components/LoginScreen';
import { PosSalesView } from './components/PosSalesView';
import { PrintableDocumentModal, type PrintableDocPayload } from './components/PrintableDocumentModal';
import { ProductsView } from './components/ProductsView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { ReportsView } from './components/ReportsView';
import { ReturnsView } from './components/ReturnsView';
import { SuppliersPurchasesView } from './components/SuppliersPurchasesView';
import { useTheme } from './hooks/useTheme';
import {
  ApiError,
  apiFetch,
  getStoredLocked,
  getStoredToken,
  setStoredLocked,
  setStoredToken,
} from './lib/api';
import type {
  AuditLogEntry,
  CashRegisterStatusPayload,
  Customer,
  InventorySession,
  PharmacySettings,
  PharmacologicalClass,
  Product,
  Purchase,
  Sale,
  SaleReturn,
  SellerClosing,
  Supplier,
  User,
} from './types';

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [settings, setSettings] = useState<PharmacySettings | null>(null);
  const [isLocked, setIsLocked] = useState<boolean>(getStoredLocked());
  const [showSwitchModal, setShowSwitchModal] = useState(false);

  const [section, setSection] = useState<NavSection>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  // Domain state
  const [users, setUsers] = useState<User[]>([]);
  const [classes, setClasses] = useState<PharmacologicalClass[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [returns, setReturns] = useState<SaleReturn[]>([]);
  const [inventories, setInventories] = useState<InventorySession[]>([]);
  const [closings, setClosings] = useState<SellerClosing[]>([]);
  const [cashRegisterStatus, setCashRegisterStatus] = useState<CashRegisterStatusPayload | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  const [showOpenRegisterModal, setShowOpenRegisterModal] = useState(false);
  const [openRegBalance, setOpenRegBalance] = useState('0');
  const [openRegNotes, setOpenRegNotes] = useState('');
  const [openingRegister, setOpeningRegister] = useState(false);
  const promptedRegisterUserRef = useRef<string | null>(null);

  const [printableDoc, setPrintableDoc] = useState<PrintableDocPayload | null>(null);
  const [purchaseModalSignal, setPurchaseModalSignal] = useState<{
    key: number;
    productId?: string;
  } | null>(null);
  const [settingsTabTarget, setSettingsTabTarget] = useState<'USERS' | 'SETTINGS' | 'AUDIT' | 'BACKUP'>('USERS');
  const [productsAlertTarget, setProductsAlertTarget] = useState<'ALL' | 'LOW' | 'OUT' | 'EXPIRING' | 'NO_TAX'>('ALL');
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const openVatSettings = useCallback(() => {
    setSettingsTabTarget('SETTINGS');
    setSection('settings');
  }, []);

  const openProductsNoTax = useCallback(() => {
    setProductsAlertTarget('NO_TAX');
    setSection('products');
  }, []);

  const notify = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const loadAllData = useCallback(async (activeUser: User) => {
    const canSeePurchases =
      activeUser.role === 'ADMIN' || activeUser.permissions.canViewPurchases;

    const [
      usersRes,
      classesRes,
      productsRes,
      suppliersRes,
      purchasesRes,
      customersRes,
      salesRes,
      returnsRes,
      invRes,
      closingsRes,
      cashRegisterRes,
      auditRes,
      settingsRes,
    ] = await Promise.all([
      apiFetch<User[]>('/api/users'),
      apiFetch<PharmacologicalClass[]>('/api/classes'),
      apiFetch<Product[]>('/api/products'),
      apiFetch<Supplier[]>('/api/suppliers'),
      canSeePurchases ? apiFetch<Purchase[]>('/api/purchases') : Promise.resolve([]),
      apiFetch<Customer[]>('/api/customers'),
      apiFetch<Sale[]>('/api/sales'),
      apiFetch<SaleReturn[]>('/api/returns'),
      apiFetch<InventorySession[]>('/api/inventories'),
      apiFetch<{ sellerClosings: SellerClosing[] }>('/api/closings'),
      apiFetch<CashRegisterStatusPayload>('/api/cash-register/current'),
      apiFetch<AuditLogEntry[]>('/api/audit'),
      apiFetch<PharmacySettings>('/api/settings'),
    ]);

    setUsers(usersRes);
    setClasses(classesRes);
    setProducts(productsRes);
    setSuppliers(suppliersRes);
    setPurchases(purchasesRes);
    setCustomers(customersRes);
    setSales(salesRes);
    setReturns(returnsRes);
    setInventories(invRes);
    setClosings(closingsRes.sellerClosings);
    setCashRegisterStatus(cashRegisterRes);
    setAuditLogs(auditRes);
    setSettings(settingsRes);

    if (
      activeUser.role === 'SELLER' &&
      promptedRegisterUserRef.current !== activeUser.id
    ) {
      promptedRegisterUserRef.current = activeUser.id;
      if (
        !cashRegisterRes.openRegister &&
        !cashRegisterRes.isPeriodClosed &&
        cashRegisterRes.closedTodayCount < cashRegisterRes.maxAllowedPerDay
      ) {
        setOpenRegBalance('0');
        setOpenRegNotes('');
        setShowOpenRegisterModal(true);
      }
    }
  }, []);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setBooting(false);
      return;
    }
    apiFetch<{ user: User; settings: PharmacySettings }>('/api/auth/me')
      .then(async (res) => {
        if (!res?.user || !res?.settings) {
          throw new Error('Resposta inválida ao validar sessão.');
        }
        setUser(res.user);
        setSettings(res.settings);
        await loadAllData(res.user);
      })
      .catch(() => {
        setStoredToken(null);
        setStoredLocked(false);
      })
      .finally(() => setBooting(false));
  }, [loadAllData]);

  const handleLoginSuccess = async (
    token: string,
    loggedUser: User,
    loadedSettings: PharmacySettings
  ) => {
    setStoredToken(token);
    setStoredLocked(false);
    setIsLocked(false);
    setSessionNotice(null);
    setDataError(null);
    promptedRegisterUserRef.current = null;
    setShowOpenRegisterModal(false);
    setUser(loggedUser);
    setSettings(loadedSettings);
    setSection('dashboard');
    setDataLoading(true);
    try {
      await loadAllData(loggedUser);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) {
        setStoredToken(null);
        setStoredLocked(false);
        setUser(null);
        setSettings(null);
        setCashRegisterStatus(null);
        setSessionNotice(
          err.message || 'A sessão expirou ou é inválida. Inicie sessão novamente.'
        );
        return;
      }
      setDataError(
        err?.message ||
          'Não foi possível carregar os dados do painel a partir do servidor ou da base de dados.'
      );
    } finally {
      setDataLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore if token expired
    }
    setStoredToken(null);
    setStoredLocked(false);
    setIsLocked(false);
    setDataError(null);
    setDataLoading(false);
    setShowOpenRegisterModal(false);
    setCashRegisterStatus(null);
    promptedRegisterUserRef.current = null;
    setUser(null);
    setSettings(null);
  };

  const handleLock = () => {
    setStoredLocked(true);
    setIsLocked(true);
  };

  const handleUnlock = () => {
    setStoredLocked(false);
    setIsLocked(false);
  };

  const refreshData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    setDataError(null);
    try {
      await loadAllData(user);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) {
        setStoredToken(null);
        setStoredLocked(false);
        setIsLocked(false);
        setUser(null);
        setSettings(null);
        setSessionNotice(
          err.message || 'A sessão expirou ou foi terminada no servidor. Inicie sessão novamente.'
        );
        return;
      }
      setDataError(
        err?.message ||
          'Falha ao carregar os dados atualizados do servidor. Verifique a ligação à base de dados.'
      );
    } finally {
      setDataLoading(false);
    }
  }, [user, loadAllData]);

  const openPurchaseEntry = useCallback(
    (productId?: string) => {
      if (!user || user.role !== 'ADMIN') return;
      setSection('suppliers');
      setMobileMenuOpen(false);
      setPurchaseModalSignal({ key: Date.now(), productId });
    },
    [user]
  );

  const openCashRegisterModal = useCallback(() => {
    setOpenRegBalance('0');
    setOpenRegNotes('');
    setShowOpenRegisterModal(true);
  }, []);

  const handleOpenCashRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOpeningRegister(true);
    try {
      await apiFetch('/api/cash-register/open', {
        method: 'POST',
        body: JSON.stringify({
          openingBalance: Math.max(0, Number(openRegBalance) || 0),
          openingNotes: openRegNotes.trim(),
        }),
      });
      setShowOpenRegisterModal(false);
      await refreshData();
      notify('Caixa aberto com sucesso. Pode iniciar as vendas.');
    } catch (err: any) {
      notify(err?.message || 'Não foi possível abrir o caixa.', 'error');
    } finally {
      setOpeningRegister(false);
    }
  };

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-6 py-5 text-sm text-slate-700 dark:text-slate-200 shadow-sm">
          A carregar Âncora SMS — Stock Management System...
        </div>
      </div>
    );
  }

  if (!user || !settings) {
    return <LoginScreen onSuccess={handleLoginSuccess} sessionNotice={sessionNotice} />;
  }

  const isAdmin = user.role === 'ADMIN';
  const canViewPurchases = isAdmin || user.permissions.canViewPurchases;

  const navItems: Array<{ id: NavSection; label: string; icon: React.ReactNode; visible: boolean }> = [
    {
      id: 'dashboard',
      label: 'Painel Principal',
      icon: <LayoutDashboard className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 'pos',
      label: 'Vendas e Faturas',
      icon: <ShoppingCart className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 'proformas',
      label: 'Proformas',
      icon: <FileText className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 'products',
      label: 'Produtos e Classes',
      icon: <Package className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 'suppliers',
      label: 'Fornecedores e Compras',
      icon: <Building2 className="w-4 h-4 shrink-0" />,
      visible: canViewPurchases,
    },
    {
      id: 'customers',
      label: 'Clientes (NIF)',
      icon: <Users className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 'returns',
      label: 'Devoluções e Anulações',
      icon: <RotateCcw className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 'inventory',
      label: 'Inventário e Ajustes',
      icon: <ClipboardCheck className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 'reports',
      label: 'Relatórios',
      icon: <BarChart3 className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 'closings',
      label: 'Caixa e Fechos',
      icon: <Wallet className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 'settings',
      label: 'Administração e Sistema',
      icon: <Settings className="w-4 h-4 shrink-0" />,
      visible: isAdmin,
    },
  ];

  const activeNavLabel = navItems.find((n) => n.id === section)?.label || 'Painel Principal';

  const selectNav = (id: NavSection) => {
    if (id === 'products') setProductsAlertTarget('ALL');
    if (id === 'settings') setSettingsTabTarget('USERS');
    setSection(id);
    setMobileMenuOpen(false);
  };

  return (
    <ErrorBoundary onResetSession={handleLogout}>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      <OfflineIndicator />

      <div className="flex-1 flex min-w-0">
        {/* Desktop Sidebar */}
        <aside className="no-print hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 z-30">
          <div className="h-16 px-4 border-b border-slate-200 dark:border-slate-800 flex items-center shrink-0 bg-white dark:bg-slate-900">
            <BrandLogo size="md" systemName={settings.pharmacyName} />
          </div>

          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
            {isAdmin && (
              <button
                type="button"
                onClick={() => openPurchaseEntry()}
                className="w-full min-h-[42px] px-3 py-2 mb-2 rounded-lg text-xs font-semibold flex items-center gap-2.5 bg-green-700 hover:bg-green-800 dark:bg-green-700 dark:hover:bg-green-600 text-white shadow-sm transition-colors"
              >
                <PackagePlus className="w-4 h-4 shrink-0" />
                <span className="truncate">Registar compra / Entrada de stock</span>
              </button>
            )}
            {navItems
              .filter((n) => n.visible)
              .map((item) => {
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectNav(item.id)}
                    className={`w-full min-h-[40px] px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2.5 transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-green-50 dark:bg-green-950/60 text-green-800 dark:text-green-300 font-semibold border border-green-200/80 dark:border-green-800/80'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
          </nav>

          <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5 text-xs">
            <PWAInstallButton className="w-full" />

            <div className="truncate pt-1">
              <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                {user.fullName}
              </div>
              <div className="text-slate-500 dark:text-slate-400">
                {isAdmin ? 'Administrador' : 'Vendedor / Farmacêutico'}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => setShowSwitchModal(true)}
                className="py-1.5 px-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-md font-medium flex items-center justify-center gap-1 whitespace-nowrap"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Mudar
              </button>
              <button
                type="button"
                onClick={handleLock}
                className="py-1.5 px-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-md font-medium flex items-center justify-center gap-1 whitespace-nowrap"
              >
                <Lock className="w-3.5 h-3.5" />
                Bloquear
              </button>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="w-full py-1.5 px-2 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-md font-medium flex items-center justify-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              Terminar Sessão
            </button>
          </div>
        </aside>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="no-print fixed inset-0 z-40 lg:hidden flex">
            <div
              className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm"
              onClick={() => setMobileMenuOpen(false)}
            />
            <div className="relative z-50 w-72 max-w-[85vw] bg-white dark:bg-slate-900 h-full border-r border-slate-200 dark:border-slate-800 flex flex-col">
              <div className="h-16 px-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 bg-white dark:bg-slate-900">
                <BrandLogo size="sm" systemName={settings.pharmacyName} />
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white shrink-0"
                  aria-label="Fechar menu"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => openPurchaseEntry()}
                    className="w-full min-h-[44px] px-3 py-2.5 mb-2 rounded-lg text-sm font-semibold flex items-center gap-3 bg-green-700 hover:bg-green-800 text-white shadow-sm"
                  >
                    <PackagePlus className="w-4 h-4 shrink-0" />
                    <span>Registar compra / Entrada de stock</span>
                  </button>
                )}
                {navItems
                  .filter((n) => n.visible)
                  .map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectNav(item.id)}
                      className={`w-full min-h-[44px] px-3 py-2.5 rounded-lg text-sm font-medium flex items-center gap-3 ${
                        section === item.id
                          ? 'bg-green-50 dark:bg-green-950/60 text-green-800 dark:text-green-300 font-semibold border border-green-200/80 dark:border-green-800/80'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
              </nav>
              <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5 text-xs">
                <PWAInstallButton className="w-full" />
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  {user.fullName}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      setShowSwitchModal(true);
                    }}
                    className="flex-1 min-h-[44px] bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-lg font-medium"
                  >
                    Mudar Utilizador
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      handleLock();
                    }}
                    className="flex-1 min-h-[44px] bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-lg font-medium"
                  >
                    Bloquear
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="w-full min-h-[44px] text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/50 rounded-lg font-medium"
                >
                  Terminar Sessão
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Content Shell */}
        <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
          {/* Top Header */}
          <header className="no-print h-16 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 lg:px-8 flex items-center justify-between gap-3 sticky top-0 z-30">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="lg:hidden p-2 min-h-[44px] min-w-[44px] flex items-center justify-center -ml-2 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg shrink-0"
                aria-label="Abrir navegação"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="lg:hidden min-w-0">
                <BrandLogo size="sm" systemName={settings.pharmacyName} />
              </div>
              <div className="hidden lg:flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-green-800 dark:text-green-400 whitespace-nowrap">
                  {settings.pharmacyName}
                </span>
                <span className="text-slate-300 dark:text-slate-700">/</span>
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                  {activeNavLabel}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="hidden sm:inline text-xs text-slate-500 dark:text-slate-400 truncate max-w-[140px]">
                {user.fullName}
              </span>
              <PWAInstallButton compact className="hidden md:inline-flex" />
              <button
                type="button"
                onClick={toggleTheme}
                className="p-2 min-h-[36px] min-w-[36px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-center"
                aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
                title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
              >
                {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={() => setShowSwitchModal(true)}
                className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg whitespace-nowrap"
              >
                Mudar Utilizador
              </button>
              <button
                type="button"
                onClick={handleLock}
                className="hidden sm:inline-flex items-center gap-1 px-3 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg whitespace-nowrap"
              >
                <Lock className="w-3.5 h-3.5" />
                Bloquear
              </button>
            </div>
          </header>

          <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1400px] w-full mx-auto">
          {dataError && (
            <div
              role="alert"
              className="mb-6 bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-900 rounded-xl p-4 sm:p-5 space-y-3"
            >
              <div className="space-y-1">
                <h2 className="text-sm font-display font-semibold text-red-900 dark:text-red-200">
                  Não foi possível carregar os dados do painel
                </h2>
                <p className="text-xs sm:text-sm text-red-800 dark:text-red-300">
                  Causa: {dataError}
                </p>
                <p className="text-xs text-red-700/90 dark:text-red-300/80">
                  Passo seguinte: verifique se o servidor e a base de dados estão ligados e tente recarregar os dados ou iniciar sessão novamente.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={refreshData}
                  disabled={dataLoading}
                  className="min-h-[38px] px-3.5 py-1.5 bg-red-700 hover:bg-red-800 disabled:opacity-60 text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {dataLoading ? 'A carregar...' : 'Tentar novamente'}
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="min-h-[38px] px-3.5 py-1.5 bg-white dark:bg-slate-900 border border-red-300 dark:border-red-800 text-red-800 dark:text-red-200 text-xs font-medium rounded-lg inline-flex items-center gap-1.5"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Terminar Sessão
                </button>
              </div>
            </div>
          )}

          {dataLoading && !dataError && products.length === 0 && auditLogs.length === 0 ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-600 dark:text-slate-300">
              A carregar os dados do painel principal do Âncora SMS...
            </div>
          ) : null}

          {section === 'dashboard' && !dataError && !(dataLoading && products.length === 0 && auditLogs.length === 0) && (
            <DashboardView
              user={user}
              settings={settings}
              products={products}
              classes={classes}
              sales={sales}
              returns={returns}
              closings={closings}
              cashRegisterStatus={cashRegisterStatus}
              auditLogs={auditLogs}
              onNavigate={setSection}
              onOpenPurchaseEntry={isAdmin ? () => openPurchaseEntry() : undefined}
              onOpenCashRegister={openCashRegisterModal}
            />
          )}

          {(section === 'pos' || section === 'proformas') && (
            <PosSalesView
              key={section}
              mode={section === 'proformas' ? 'PROFORMAS' : 'POS'}
              user={user}
              settings={settings}
              products={products}
              customers={customers}
              sales={sales}
              cashRegisterStatus={cashRegisterStatus}
              onOpenCashRegister={openCashRegisterModal}
              onOpenVatSettings={isAdmin ? openVatSettings : undefined}
              onOpenProductsNoTax={
                isAdmin || user.permissions.canConfigureProductVat ? openProductsNoTax : undefined
              }
              onRefresh={refreshData}
              onNotify={notify}
              onPrintDoc={setPrintableDoc}
            />
          )}

          {section === 'products' && (
            <ProductsView
              user={user}
              settings={settings}
              products={products}
              classes={classes}
              suppliers={suppliers}
              initialAlertFilter={productsAlertTarget}
              onRefresh={refreshData}
              onNotify={notify}
              onOpenPurchaseEntry={isAdmin ? openPurchaseEntry : undefined}
            />
          )}

          {section === 'suppliers' && canViewPurchases && (
            <SuppliersPurchasesView
              user={user}
              settings={settings}
              suppliers={suppliers}
              products={products}
              purchases={purchases}
              openPurchaseSignal={purchaseModalSignal}
              onRefresh={refreshData}
              onNotify={notify}
              onPrintDoc={setPrintableDoc}
            />
          )}

          {section === 'customers' && (
            <CustomersView
              settings={settings}
              customers={customers}
              sales={sales}
              onRefresh={refreshData}
              onNotify={notify}
            />
          )}

          {section === 'returns' && (
            <ReturnsView
              user={user}
              settings={settings}
              sales={sales}
              returns={returns}
              cashRegisterStatus={cashRegisterStatus}
              onOpenCashRegister={openCashRegisterModal}
              onOpenVatSettings={isAdmin ? openVatSettings : undefined}
              onRefresh={refreshData}
              onNotify={notify}
              onPrintDoc={setPrintableDoc}
            />
          )}

          {section === 'inventory' && (
            <InventoryView
              user={user}
              settings={settings}
              products={products}
              classes={classes}
              inventories={inventories}
              onRefresh={refreshData}
              onNotify={notify}
            />
          )}

          {section === 'reports' && (
            <ReportsView
              user={user}
              settings={settings}
              users={users}
              products={products}
              classes={classes}
              suppliers={suppliers}
            />
          )}

          {section === 'closings' && (
            <ClosingsView
              user={user}
              settings={settings}
              onRefresh={refreshData}
              onNotify={notify}
            />
          )}

          {section === 'settings' && isAdmin && (
            <AdminSettingsView
              currentUser={user}
              settings={settings}
              users={users}
              auditLogs={auditLogs}
              initialTab={settingsTabTarget}
              onOpenProductsNoTax={openProductsNoTax}
              onRefresh={refreshData}
              onNotify={notify}
            />
          )}
          </main>
        </div>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          className={`no-print fixed bottom-4 right-4 z-50 max-w-sm px-4 py-3 rounded-xl border text-xs font-medium shadow-lg ${
            toast.type === 'error'
              ? 'bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-800 text-red-900 dark:text-red-200'
              : 'bg-green-800 border-green-700 text-white'
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Switch User Modal */}
      {showSwitchModal && (
        <SwitchUserModal
          currentUser={user}
          onClose={() => setShowSwitchModal(false)}
          onSwitched={handleLoginSuccess}
        />
      )}

      {/* Lock Screen Overlay */}
      {isLocked && (
        <LockOverlay
          currentUser={user}
          onUnlock={handleUnlock}
          onSwitched={handleLoginSuccess}
          onLogout={handleLogout}
        />
      )}

      {/* Quick Open Cash Register Modal */}
      {showOpenRegisterModal && (
        <div className="no-print fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-green-100 dark:bg-green-950/70 text-green-700 dark:text-green-400 flex items-center justify-center shrink-0">
                  <Unlock className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-display font-semibold text-slate-900 dark:text-slate-100">
                    Abrir caixa
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Operador: {user.fullName}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowOpenRegisterModal(false)}
                className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                aria-label="Fechar janela"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {cashRegisterStatus?.isPeriodClosed ? (
              <div className="space-y-3 text-xs">
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-900 dark:text-red-200">
                  A data de hoje já está encerrada pelo Fecho Geral ({cashRegisterStatus.closedPeriodRef}). Não é possível abrir um novo caixa para hoje.
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setShowOpenRegisterModal(false)}
                    className="px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-lg font-medium"
                  >
                    Fechar
                  </button>
                </div>
              </div>
            ) : cashRegisterStatus &&
              cashRegisterStatus.closedTodayCount >= cashRegisterStatus.maxAllowedPerDay ? (
              <div className="space-y-3 text-xs">
                <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200">
                  Já atingiu o limite máximo de {cashRegisterStatus.maxAllowedPerDay} aberturas/fechos hoje.
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setShowOpenRegisterModal(false)}
                    className="px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-lg font-medium"
                  >
                    Fechar
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleOpenCashRegisterSubmit} className="space-y-4 text-xs">
                <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                  Registe o valor inicial em caixa antes de faturar vendas ou processar devoluções nesta sessão.
                </p>

                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Valor inicial em caixa ({settings.currencySymbol || 'Kz'}) *
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={openRegBalance}
                    onChange={(e) => setOpenRegBalance(e.target.value)}
                    className="w-full min-h-[42px] px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg font-mono text-sm tabular-nums"
                  />
                </div>

                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Observações de abertura (opcional)
                  </label>
                  <textarea
                    rows={2}
                    value={openRegNotes}
                    onChange={(e) => setOpenRegNotes(e.target.value)}
                    placeholder="Troco inicial, conferência do turno..."
                    className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-lg text-sm"
                  />
                </div>

                <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowOpenRegisterModal(false)}
                    className="min-h-[40px] px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg font-medium"
                  >
                    Consultar primeiro
                  </button>
                  <button
                    type="submit"
                    disabled={openingRegister}
                    className="min-h-[40px] px-4 py-2 bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-lg font-medium inline-flex items-center gap-1.5"
                  >
                    <Unlock className="w-4 h-4" />
                    {openingRegister ? 'A abrir caixa...' : 'Abrir caixa'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Printable Document Modal */}
      {printableDoc && (
        <PrintableDocumentModal
          payload={printableDoc}
          settings={settings}
          onClose={() => setPrintableDoc(null)}
        />
      )}
      </div>
    </ErrorBoundary>
  );
}
