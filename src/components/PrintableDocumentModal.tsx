import React from 'react';
import { FileDown, Printer, X } from 'lucide-react';
import {
  buyerAckMethodLabel,
  exportTableToPDF,
  fiscalStatusLabel,
  formatDatePT,
  formatDateTimePT,
  formatMoney,
  paymentMethodLabel,
  roundMoney,
  saleDocTypeLabel,
  saleStatusLabel,
  taxCodeLabel,
  valorPorExtensoAOA,
  vatRegimeLabel,
} from '../lib/format';
import type { PharmacySettings, Purchase, Sale, SaleReturn } from '../types';
import { ANCORA_LOGO_SRC } from './BrandLogo';

export type PrintableDocPayload =
  | { kind: 'SALE'; doc: Sale }
  | { kind: 'RETURN'; doc: SaleReturn }
  | { kind: 'PURCHASE'; doc: Purchase };

interface PrintableDocumentModalProps {
  payload: PrintableDocPayload;
  settings: PharmacySettings;
  onClose: () => void;
}

export const PrintableDocumentModal: React.FC<PrintableDocumentModalProps> = ({
  payload,
  settings,
  onClose,
}) => {
  const cur = settings.currencySymbol || 'Kz';

  const handleDownloadPdf = () => {
    if (payload.kind === 'SALE') {
      const s = payload.doc;
      const title = `${saleDocTypeLabel(s.type)} ${s.documentNumber}`;
      const headers =
        s.type === 'RECIBO'
          ? ['Documento Liquidado', 'Descrição', 'Valor Liquidado']
          : ['Código', 'Produto', 'Qtd', 'P. Unit.', 'Desc.%', 'IVA / Isenção', 'Base Trib.', 'Valor IVA', 'Total'];
      const rows: Array<Array<string | number>> =
        s.type === 'RECIBO'
          ? [
              [
                s.relatedInvoiceNumber || '—',
                s.notes || 'Liquidação de fatura',
                formatMoney(s.totalAmount, cur),
              ],
            ]
          : [
              ...s.items.map((i) => [
                i.productCode,
                i.productName,
                i.quantity,
                formatMoney(i.unitPrice, cur),
                `${i.discountPercent}%`,
                `${taxCodeLabel(i.taxCode, i.taxRate)}${i.taxExemptionCode ? ` (${i.taxExemptionCode})` : ''}`,
                formatMoney(i.taxableBase ?? i.subtotal, cur),
                formatMoney(i.taxAmount ?? 0, cur),
                formatMoney(i.subtotal, cur),
              ]),
              ...(s.taxBreakdown || []).map((tb) => [
                'RESUMO IVA',
                `${taxCodeLabel(tb.taxCode, tb.taxRate)}${tb.taxExemptionCode ? ` (${tb.taxExemptionCode})` : ''}`,
                tb.itemsCount,
                '—',
                '—',
                tb.taxExemptionReason || '—',
                formatMoney(tb.taxableBase, cur),
                formatMoney(tb.taxAmount, cur),
                formatMoney(tb.total, cur),
              ]),
              [
                'TOTAIS',
                `Base Tributável: ${formatMoney(
                  s.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0),
                  cur
                )}`,
                '',
                '',
                `Desc: -${formatMoney(s.discountTotal, cur)}`,
                '',
                formatMoney(
                  s.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0),
                  cur
                ),
                formatMoney(s.taxTotal || 0, cur),
                formatMoney(s.totalAmount, cur),
              ],
            ];
      exportTableToPDF(
        `${s.documentNumber.replace(/[\/\s]/g, '_')}.pdf`,
        title,
        `Emitente: ${settings.legalName || settings.pharmacyName} (NIF: ${settings.nif}) · Cliente: ${s.customerName} (NIF: ${s.customerNif}) · ${fiscalStatusLabel(s.fiscalValidationStatus)}`,
        headers,
        rows,
        settings.pharmacyName
      );
    } else if (payload.kind === 'RETURN') {
      const r = payload.doc;
      const nature = r.rectificationNature || (r.type === 'ANULACAO' ? 'ANULACAO' : 'RECTIFICACAO');
      const title = `${nature} — ${r.documentNumber}`;
      const baseCredited = roundMoney(r.totalRefund - (r.taxTotal || 0));
      const rows: Array<Array<string | number>> = [
        ...r.items.map((i) => [
          i.productCode,
          i.productName,
          i.quantity,
          i.condition === 'APT' ? 'Apto para venda' : 'Quarentena / Não vendável',
          `${taxCodeLabel(i.taxCode, i.taxRate)}${i.taxExemptionCode ? ` (${i.taxExemptionCode})` : ''}`,
          formatMoney(i.taxableBase ?? i.refundAmount, cur),
          formatMoney(i.taxAmount ?? 0, cur),
          formatMoney(i.refundAmount, cur),
        ]),
        ...(r.taxBreakdown || []).map((tb) => [
          'RESUMO IVA',
          `${taxCodeLabel(tb.taxCode, tb.taxRate)}${tb.taxExemptionCode ? ` (${tb.taxExemptionCode})` : ''}`,
          tb.itemsCount,
          tb.taxExemptionReason || '—',
          '—',
          formatMoney(tb.taxableBase, cur),
          formatMoney(tb.taxAmount, cur),
          formatMoney(tb.total, cur),
        ]),
        [
          'TOTAIS NC',
          `Ref.: ${r.originalDocumentNumber}`,
          '',
          '',
          '',
          formatMoney(baseCredited, cur),
          formatMoney(r.taxTotal || 0, cur),
          formatMoney(r.totalRefund, cur),
        ],
      ];
      exportTableToPDF(
        `${r.documentNumber.replace(/[\/\s]/g, '_')}.pdf`,
        title,
        `Ref. Original: ${r.originalDocumentNumber} · Motivo: ${r.reason} · Prova Adquirente: ${
          r.buyerAcknowledgement?.confirmed
            ? buyerAckMethodLabel(r.buyerAcknowledgement.method)
            : 'Pendente'
        }`,
        ['Código', 'Produto', 'Qtd', 'Destino Stock', 'IVA / Isenção', 'Base Creditada', 'IVA Creditado', 'Total'],
        rows,
        settings.pharmacyName
      );
    } else {
      const p = payload.doc;
      const baseTotal =
        p.subtotal !== undefined
          ? p.subtotal
          : roundMoney(p.items.reduce((acc, it) => acc + (it.taxableBase ?? it.subtotal), 0));
      const taxTotal =
        p.taxTotal !== undefined
          ? p.taxTotal
          : roundMoney(p.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0));
      const rows: Array<Array<string | number>> = [
        ...p.items.map((i) => [
          i.productCode,
          i.productName,
          i.quantity,
          `${i.batch || '—'} · ${formatDatePT(i.expiryDate)}`,
          formatMoney(i.unitCost, cur),
          `${taxCodeLabel(i.taxCode, i.taxRate)}${i.taxExemptionCode ? ` (${i.taxExemptionCode})` : ''}`,
          formatMoney(i.taxableBase ?? i.subtotal, cur),
          formatMoney(i.taxAmount ?? 0, cur),
          formatMoney(i.subtotal, cur),
        ]),
        ...(p.taxBreakdown || []).map((tb) => [
          'RESUMO IVA',
          `${taxCodeLabel(tb.taxCode, tb.taxRate)}${tb.taxExemptionCode ? ` (${tb.taxExemptionCode})` : ''}`,
          tb.itemsCount,
          tb.taxExemptionReason || '—',
          '—',
          '—',
          formatMoney(tb.taxableBase, cur),
          formatMoney(tb.taxAmount, cur),
          formatMoney(tb.total, cur),
        ]),
        [
          'TOTAIS COMPRA',
          p.supplierName,
          '',
          '',
          '',
          '',
          formatMoney(baseTotal, cur),
          formatMoney(taxTotal, cur),
          formatMoney(p.totalAmount, cur),
        ],
      ];
      exportTableToPDF(
        `${p.internalNumber.replace(/[\/\s]/g, '_')}.pdf`,
        `Registo de Compra ${p.internalNumber}`,
        `Fornecedor: ${p.supplierName} · Doc. Forn.: ${p.documentNumber} · Data: ${formatDatePT(p.documentDate)}`,
        ['Código', 'Produto', 'Qtd', 'Lote / Validade', 'Custo Unit.', 'IVA / Isenção', 'Base Trib.', 'Valor IVA', 'Total'],
        rows,
        settings.pharmacyName
      );
    }
  };

  const renderNonCertifiedBanner = () => {
    if (payload.kind === 'PURCHASE') return null;
    if (payload.kind === 'SALE' && payload.doc.type === 'PROFORMA') {
      return (
        <div className="p-3 rounded-lg bg-slate-100 border border-slate-300 text-xs font-semibold text-slate-800 text-center">
          DOCUMENTO NÃO FISCAL / PROFORMA — NÃO SERVE DE FACTURA VÁLIDA E NÃO MOVIMENTA STOCK
        </div>
      );
    }
    const status = payload.doc.fiscalValidationStatus;
    if (status === 'VALIDADO_AGT') {
      return (
        <div className="p-2.5 rounded-lg bg-sky-50 border border-sky-300 text-xs text-sky-950 space-y-1">
          <div className="flex flex-wrap justify-between gap-2">
            <span className="font-semibold">
              VALIDADO PELA AGT
            </span>
            {payload.doc.agtRequestId && (
              <span className="font-mono">requestID AGT: {payload.doc.agtRequestId}</span>
            )}
          </div>
          {(payload.doc.agtHash || payload.doc.agtQrCode) && (
            <div className="text-[11px] font-mono text-sky-900">
              {payload.doc.agtHash ? `Hash: ${payload.doc.agtHash}` : ''}
              {payload.doc.agtHash && payload.doc.agtQrCode ? ' · ' : ''}
              {payload.doc.agtQrCode ? `QR: ${payload.doc.agtQrCode}` : ''}
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="p-3 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-950 text-center space-y-0.5">
        <div className="font-bold">
          {status === 'REJEITADO_AGT'
            ? 'DOCUMENTO REJEITADO PELA AGT — REQUER RECTIFICAÇÃO / REENVIO'
            : 'RASCUNHO INTERNO — SEM VALIDAÇÃO AGT CONCLUÍDA'}
        </div>
        <div className="text-[11px]">
          Estado: {fiscalStatusLabel(status)} · Série:{' '}
          {payload.doc.seriesSource === 'AGT_OFICIAL'
            ? 'Série AGT'
            : 'Numeração Interna (Não Oficial)'}
          {payload.doc.agtRejectionReason ? ` · Motivo AGT: ${payload.doc.agtRejectionReason}` : ''}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden my-8 shadow-2xl">
        {/* Toolbar (hidden on print) */}
        <div className="no-print px-6 py-4 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Pré-visualização de Documento</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
            >
              <FileDown className="w-4 h-4" />
              Guardar PDF
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="px-3.5 py-2 text-xs font-medium text-white bg-green-800 hover:bg-green-900 dark:bg-green-700 dark:hover:bg-green-600 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
            >
              <Printer className="w-4 h-4" />
              Imprimir
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 rounded-lg"
              aria-label="Fechar pré-visualização"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Printable Document Content */}
        <div className="print-area bg-white p-6 sm:p-8 space-y-5 text-slate-900">
          {renderNonCertifiedBanner()}

          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-slate-200 pb-5">
            <div className="flex items-start gap-3">
              <div className="w-14 h-14 bg-white border border-slate-200 rounded-lg p-1 shrink-0 flex items-center justify-center">
                <img
                  src={ANCORA_LOGO_SRC}
                  alt="Logotipo Âncora SMS"
                  className="w-full h-full object-contain"
                />
              </div>
              <div>
                <h2 className="text-lg font-display font-bold text-green-800">
                  {settings.legalName || settings.pharmacyName}
                </h2>
                {settings.legalName && settings.legalName !== settings.pharmacyName && (
                  <p className="text-xs font-medium text-slate-700">{settings.pharmacyName}</p>
                )}
                <p className="text-[11px] text-slate-600 mt-0.5">
                  Estabelecimento: {settings.establishmentName || 'Sede'}
                  {settings.establishmentCode ? ` (${settings.establishmentCode})` : ''}
                </p>
                <p className="text-xs text-slate-600">
                  NIF: <span className="font-mono font-semibold">{settings.nif || 'Não registado'}</span> · Tel: {settings.phone || '—'}
                  {settings.email ? ` · ${settings.email}` : ''}
                </p>
                <p className="text-xs text-slate-600">
                  Sede: {settings.address || 'Não registada'}
                  {settings.city ? ` · ${settings.city}` : ''}
                  {settings.country ? ` (${settings.country})` : ''}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Enquadramento IVA: {vatRegimeLabel(settings.vatRegime)}
                  {payload.kind !== 'PURCHASE' &&
                    ` · Preços: ${settings.pricesIncludeTax ? 'IVA incluído' : 'IVA acrescido'}`}
                </p>
              </div>
            </div>

            <div className="sm:text-right">
              {payload.kind === 'SALE' && (
                <>
                  <p className="text-xs font-semibold uppercase text-slate-600">
                    {saleDocTypeLabel(payload.doc.type)}
                  </p>
                  <p className="text-lg font-mono font-bold text-slate-900">
                    {payload.doc.documentNumber}
                  </p>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Operação: {formatDatePT(payload.doc.date)} {payload.doc.time} ·{' '}
                    {saleStatusLabel(payload.doc.status)}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Emitido em: {formatDateTimePT(payload.doc.issuedAt || payload.doc.createdAt)}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {payload.doc.seriesSource === 'AGT_OFICIAL'
                      ? 'Série Oficial AGT'
                      : 'Série Interna (Não Oficial)'}
                  </p>
                  {payload.doc.locationOfOperation && (
                    <p className="text-[11px] text-slate-500">
                      Local: {payload.doc.locationOfOperation}
                    </p>
                  )}
                </>
              )}
              {payload.kind === 'RETURN' && (
                <>
                  <p className="text-xs font-bold uppercase text-red-700">
                    «{payload.doc.rectificationNature || (payload.doc.type === 'ANULACAO' ? 'ANULAÇÃO' : 'RECTIFICAÇÃO')}»
                  </p>
                  <p className="text-[11px] text-slate-600">
                    Nota de Crédito (NC){' '}
                    {payload.doc.type === 'ANULACAO' ? '— Anulação Total' : '— Rectificação / Devolução'}
                  </p>
                  <p className="text-lg font-mono font-bold text-slate-900">
                    {payload.doc.documentNumber}
                  </p>
                  {payload.doc.internalCancellationRef && (
                    <p className="text-[10px] font-mono text-slate-500">
                      Registo interno de anulação: {payload.doc.internalCancellationRef}
                    </p>
                  )}
                  <p className="text-xs text-slate-600 mt-0.5">
                    Ref. Documento Original:{' '}
                    <span className="font-mono font-semibold">{payload.doc.originalDocumentNumber}</span>
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Emitido em: {formatDateTimePT(payload.doc.createdAt)}
                  </p>
                </>
              )}
              {payload.kind === 'PURCHASE' && (
                <>
                  <p className="text-xs font-medium text-slate-500">ENTRADA DE COMPRA</p>
                  <p className="text-lg font-mono font-semibold text-slate-900">
                    {payload.doc.internalNumber}
                  </p>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Doc. Fornecedor: <span className="font-mono">{payload.doc.documentNumber}</span> ·{' '}
                    {formatDatePT(payload.doc.documentDate)}
                  </p>
                </>
              )}
            </div>
          </div>

          {payload.kind === 'SALE' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs bg-slate-50 border border-slate-200 rounded-lg p-4">
                <div>
                  <p className="text-slate-500">Adquirente / Cliente</p>
                  <p className="font-semibold text-slate-900 mt-0.5">{payload.doc.customerName}</p>
                  <p className="text-slate-600 font-mono">NIF: {payload.doc.customerNif}</p>
                </div>
                <div className="sm:text-right">
                  <p className="text-slate-500">Operador / Pagamento</p>
                  <p className="font-semibold text-slate-900 mt-0.5">{payload.doc.sellerName}</p>
                  <p className="text-slate-600">{paymentMethodLabel(payload.doc.paymentMethod)}</p>
                  {payload.doc.type === 'FACTURA' && (
                    <p className="text-[11px] font-mono text-slate-700 mt-0.5">
                      Liquidado: {formatMoney(payload.doc.paidAmount || 0, cur)} /{' '}
                      {formatMoney(payload.doc.totalAmount, cur)} · Saldo:{' '}
                      {formatMoney(
                        Math.max(0, roundMoney(payload.doc.totalAmount - (payload.doc.paidAmount || 0))),
                        cur
                      )}
                    </p>
                  )}
                  {payload.doc.relatedInvoiceNumber && (
                    <p className="text-[11px] font-mono text-slate-700 mt-0.5">
                      Liquidação referente a: {payload.doc.relatedInvoiceNumber}
                    </p>
                  )}
                </div>
              </div>

              {payload.doc.type === 'RECIBO' ? (
                <div className="p-4 border border-slate-200 rounded-lg text-xs space-y-1.5">
                  <div className="font-semibold text-slate-800">
                    Recibo de Liquidação — Fatura {payload.doc.relatedInvoiceNumber || '—'}
                  </div>
                  <div className="text-slate-600">{payload.doc.notes || 'Recebimento registado no caixa.'}</div>
                  <div className="text-[11px] text-slate-500">
                    Documento de quitação financeira referente à fatura original (sem nova liquidação de IVA).
                  </div>
                  <div className="text-sm font-mono font-bold text-slate-900 pt-2">
                    Valor Recebido: {formatMoney(payload.doc.totalAmount, cur)}
                  </div>
                  <div className="text-[11px] text-slate-600">
                    Por extenso: <span className="font-medium">{valorPorExtensoAOA(payload.doc.totalAmount, cur)}</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-slate-300 text-slate-600 text-left">
                          <th className="py-2 pr-3 font-medium">Artigo</th>
                          <th className="py-2 px-2 font-medium">Lote / Val.</th>
                          <th className="py-2 px-2 font-medium text-right">Qtd</th>
                          <th className="py-2 px-2 font-medium text-right">P. Unit.</th>
                          <th className="py-2 px-2 font-medium text-right">Desc.</th>
                          <th className="py-2 px-2 font-medium text-right">IVA</th>
                          <th className="py-2 px-2 font-medium text-right">Base</th>
                          <th className="py-2 px-2 font-medium text-right">Imposto</th>
                          <th className="py-2 pl-2 font-medium text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {payload.doc.items.map((item, idx) => (
                          <tr key={idx}>
                            <td className="py-2.5 pr-3">
                              <div className="font-medium text-slate-900">{item.productName}</div>
                              <div className="text-slate-500 font-mono text-[11px]">
                                {item.productCode}
                                {item.taxCode === 'ISE' && item.taxExemptionCode
                                  ? ` · Isenção ${item.taxExemptionCode}`
                                  : item.taxCode === 'OUT' && Number(item.taxRate ?? 0) === 0 && item.taxExemptionReason
                                  ? ` · ${item.taxExemptionReason}`
                                  : ''}
                              </div>
                            </td>
                            <td className="py-2.5 px-2 font-mono text-slate-600">
                              {item.batch || '—'} · {formatDatePT(item.expiryDate)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono">{item.quantity}</td>
                            <td className="py-2.5 px-2 text-right font-mono">
                              <div>{formatMoney(item.unitPrice, cur)}</div>
                              {item.priceIncludesTax !== undefined && (
                                <div className="text-[10px] text-slate-400">
                                  {item.priceIncludesTax ? 'c/ IVA' : '+ IVA'}
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono">{item.discountPercent}%</td>
                            <td className="py-2.5 px-2 text-right font-mono text-[11px]">
                              {taxCodeLabel(item.taxCode, item.taxRate)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-slate-600">
                              {formatMoney(item.taxableBase ?? item.subtotal, cur)}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono text-slate-600">
                              {formatMoney(item.taxAmount ?? 0, cur)}
                            </td>
                            <td className="py-2.5 pl-2 text-right font-mono font-medium">
                              {formatMoney(item.subtotal, cur)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {payload.doc.taxBreakdown && payload.doc.taxBreakdown.length > 0 && (
                    <div className="border border-slate-200 rounded-lg p-3 space-y-1.5 text-[11px]">
                      <div className="font-semibold text-slate-700">Quadro Resumo de Impostos (IVA)</div>
                      <table className="w-full">
                        <thead>
                          <tr className="text-left text-slate-500 border-b border-slate-200">
                            <th className="py-1 font-medium">Código / Taxa</th>
                            <th className="py-1 font-medium">Motivo Legal Isenção</th>
                            <th className="py-1 font-medium text-right">Incidência</th>
                            <th className="py-1 font-medium text-right">Imposto</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {payload.doc.taxBreakdown.map((tb, idx) => (
                            <tr key={idx}>
                              <td className="py-1 font-mono">
                                {taxCodeLabel(tb.taxCode, tb.taxRate)}
                                {tb.taxExemptionCode ? ` (${tb.taxExemptionCode})` : ''}
                              </td>
                              <td className="py-1 text-slate-600">
                                {tb.taxExemptionReason || '—'}
                              </td>
                              <td className="py-1 text-right font-mono">{formatMoney(tb.taxableBase, cur)}</td>
                              <td className="py-1 text-right font-mono">{formatMoney(tb.taxAmount, cur)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="flex flex-col items-end space-y-1 border-t border-slate-200 pt-4 text-xs">
                    <div className="flex justify-between w-64 text-slate-600">
                      <span>Subtotal (Catálogo):</span>
                      <span className="font-mono">{formatMoney(payload.doc.subtotal, cur)}</span>
                    </div>
                    <div className="flex justify-between w-64 text-slate-600">
                      <span>Descontos:</span>
                      <span className="font-mono">-{formatMoney(payload.doc.discountTotal, cur)}</span>
                    </div>
                    <div className="flex justify-between w-64 text-slate-600">
                      <span>Base Tributável Total:</span>
                      <span className="font-mono">
                        {formatMoney(
                          payload.doc.items.reduce(
                            (acc, it) => acc + (it.taxableBase ?? it.subtotal),
                            0
                          ),
                          cur
                        )}
                      </span>
                    </div>
                    <div className="flex justify-between w-64 text-slate-600">
                      <span>Total IVA / Imposto:</span>
                      <span className="font-mono">{formatMoney(payload.doc.taxTotal || 0, cur)}</span>
                    </div>
                    <div className="flex justify-between w-64 text-sm font-semibold text-slate-900 pt-1 border-t border-slate-200">
                      <span>Total do Documento:</span>
                      <span className="font-mono">{formatMoney(payload.doc.totalAmount, cur)}</span>
                    </div>
                    <p className="text-[11px] text-slate-600 pt-1 text-right">
                      Valor por extenso (Art. 10.º DP 71/25):{' '}
                      <span className="font-medium text-slate-800">
                        {valorPorExtensoAOA(payload.doc.totalAmount, cur)}
                      </span>
                    </p>
                  </div>
                </>
              )}
            </>
          )}

          {payload.kind === 'RETURN' && (
            <>
              <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-1">
                <p>
                  <span className="text-slate-500">Natureza Legal (Art. 8.º DP 71/25):</span>{' '}
                  <span className="font-bold">
                    «{payload.doc.rectificationNature || (payload.doc.type === 'ANULACAO' ? 'ANULAÇÃO' : 'RECTIFICAÇÃO')}»
                  </span>
                </p>
                <p>
                  <span className="text-slate-500">Adquirente / NIF:</span>{' '}
                  <span className="font-medium">
                    {payload.doc.customerName || 'Consumidor Final'} (NIF: {payload.doc.customerNif || '999999999'})
                  </span>
                </p>
                <p>
                  <span className="text-slate-500">Registado por:</span>{' '}
                  <span className="font-medium">{payload.doc.userName}</span>
                </p>
                <p>
                  <span className="text-slate-500">Motivo:</span>{' '}
                  <span className="font-medium">{payload.doc.reason}</span>
                </p>
                <p>
                  <span className="text-slate-500">Prova de Conhecimento do Adquirente:</span>{' '}
                  <span className="font-medium">
                    {payload.doc.buyerAcknowledgement?.confirmed
                      ? `Confirmada — ${buyerAckMethodLabel(payload.doc.buyerAcknowledgement.method)}${
                          payload.doc.buyerAcknowledgement.reference
                            ? ` (Ref.: ${payload.doc.buyerAcknowledgement.reference})`
                            : ''
                        }`
                      : 'Pendente de registo / assinatura do adquirente'}
                  </span>
                </p>
              </div>

              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-300 text-slate-600 text-left">
                    <th className="py-2 pr-3 font-medium">Produto</th>
                    <th className="py-2 px-2 font-medium">Destino Stock</th>
                    <th className="py-2 px-2 font-medium text-right">Qtd</th>
                    <th className="py-2 px-2 font-medium text-right">IVA</th>
                    <th className="py-2 pl-2 font-medium text-right">Valor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {payload.doc.items.map((item, idx) => (
                    <tr key={idx}>
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-slate-900">
                          {item.productName}{' '}
                          <span className="text-slate-500 font-mono">({item.productCode})</span>
                        </div>
                        {(item.taxExemptionCode || item.taxExemptionReason) && (
                          <div className="text-[11px] text-slate-500 font-mono">
                            {item.taxExemptionCode ? `${item.taxExemptionCode} · ` : ''}
                            {item.taxExemptionReason || ''}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-2">
                        {item.condition === 'APT'
                          ? 'Devolvido ao stock vendável'
                          : 'Quarentena / Não vendável'}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono">{item.quantity}</td>
                      <td className="py-2.5 px-2 text-right font-mono text-[11px]">
                        {taxCodeLabel(item.taxCode, item.taxRate)}
                      </td>
                      <td className="py-2.5 pl-2 text-right font-mono font-medium">
                        {formatMoney(item.refundAmount, cur)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {payload.doc.taxBreakdown && payload.doc.taxBreakdown.length > 0 && (
                <div className="border border-slate-200 rounded-lg p-3 space-y-1.5 text-[11px]">
                  <div className="font-semibold text-slate-700">Quadro Resumo de Impostos (IVA Creditado)</div>
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-200">
                        <th className="py-1 font-medium">Código / Taxa</th>
                        <th className="py-1 font-medium">Motivo Legal Isenção</th>
                        <th className="py-1 font-medium text-right">Incidência</th>
                        <th className="py-1 font-medium text-right">IVA Creditado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {payload.doc.taxBreakdown.map((tb, idx) => (
                        <tr key={idx}>
                          <td className="py-1 font-mono">
                            {taxCodeLabel(tb.taxCode, tb.taxRate)}
                            {tb.taxExemptionCode ? ` (${tb.taxExemptionCode})` : ''}
                          </td>
                          <td className="py-1 text-slate-600">{tb.taxExemptionReason || '—'}</td>
                          <td className="py-1 text-right font-mono">{formatMoney(tb.taxableBase, cur)}</td>
                          <td className="py-1 text-right font-mono">{formatMoney(tb.taxAmount, cur)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-col items-end space-y-1 border-t border-slate-200 pt-4 text-xs">
                <div className="flex justify-between w-64 text-slate-600">
                  <span>Base Tributável Creditada:</span>
                  <span className="font-mono">
                    {formatMoney(
                      payload.doc.items.reduce(
                        (acc, it) => acc + (it.taxableBase ?? it.refundAmount),
                        0
                      ),
                      cur
                    )}
                  </span>
                </div>
                <div className="flex justify-between w-64 text-slate-600">
                  <span>IVA Creditado / Anulado:</span>
                  <span className="font-mono">{formatMoney(payload.doc.taxTotal || 0, cur)}</span>
                </div>
                <div className="flex justify-between w-64 text-sm font-semibold">
                  <span>Total Creditado / Anulado:</span>
                  <span className="font-mono">{formatMoney(payload.doc.totalRefund, cur)}</span>
                </div>
                <p className="text-[11px] text-slate-600 pt-1 text-right">
                  Valor por extenso: <span className="font-medium text-slate-800">{valorPorExtensoAOA(payload.doc.totalRefund, cur)}</span>
                </p>
              </div>
            </>
          )}

          {payload.kind === 'PURCHASE' && (
            <>
              <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <p className="text-slate-500">Fornecedor</p>
                  <p className="font-semibold text-slate-900">{payload.doc.supplierName}</p>
                </div>
                <div className="sm:text-right">
                  <p className="text-slate-500">Utilizador Responsável</p>
                  <p className="font-semibold text-slate-900">{payload.doc.userName}</p>
                  <p className="text-[11px] text-slate-500">
                    Custos lançados: {payload.doc.pricesIncludeTax ? 'Com IVA incluído' : 'Sem IVA (IVA acrescido)'}
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-300 text-slate-600 text-left">
                      <th className="py-2 pr-3 font-medium">Produto</th>
                      <th className="py-2 px-2 font-medium">Lote / Validade</th>
                      <th className="py-2 px-2 font-medium text-right">Qtd</th>
                      <th className="py-2 px-2 font-medium text-right">Custo Unit.</th>
                      <th className="py-2 px-2 font-medium text-right">IVA</th>
                      <th className="py-2 px-2 font-medium text-right">Base</th>
                      <th className="py-2 px-2 font-medium text-right">Imposto</th>
                      <th className="py-2 pl-2 font-medium text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {payload.doc.items.map((item, idx) => (
                      <tr key={idx}>
                        <td className="py-2.5 pr-3">
                          <div className="font-medium">{item.productName}</div>
                          <div className="text-slate-500 font-mono text-[11px]">
                            {item.productCode}
                            {item.taxExemptionCode ? ` · ${item.taxExemptionCode}` : ''}
                          </div>
                        </td>
                        <td className="py-2.5 px-2 font-mono text-slate-600">
                          {item.batch || '—'} · {formatDatePT(item.expiryDate)}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono">{item.quantity}</td>
                        <td className="py-2.5 px-2 text-right font-mono">
                          {formatMoney(item.unitCost, cur)}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono text-[11px]">
                          {taxCodeLabel(item.taxCode, item.taxRate)}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono text-slate-600">
                          {formatMoney(item.taxableBase ?? item.subtotal, cur)}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono text-slate-600">
                          {formatMoney(item.taxAmount ?? 0, cur)}
                        </td>
                        <td className="py-2.5 pl-2 text-right font-mono font-medium">
                          {formatMoney(item.subtotal, cur)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {payload.doc.taxBreakdown && payload.doc.taxBreakdown.length > 0 && (
                <div className="border border-slate-200 rounded-lg p-3 space-y-1.5 text-[11px]">
                  <div className="font-semibold text-slate-700">Quadro Resumo de IVA Suportado na Compra</div>
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-200">
                        <th className="py-1 font-medium">Código / Taxa</th>
                        <th className="py-1 font-medium">Motivo Legal Isenção</th>
                        <th className="py-1 font-medium text-right">Incidência</th>
                        <th className="py-1 font-medium text-right">IVA Suportado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {payload.doc.taxBreakdown.map((tb, idx) => (
                        <tr key={idx}>
                          <td className="py-1 font-mono">
                            {taxCodeLabel(tb.taxCode, tb.taxRate)}
                            {tb.taxExemptionCode ? ` (${tb.taxExemptionCode})` : ''}
                          </td>
                          <td className="py-1 text-slate-600">{tb.taxExemptionReason || '—'}</td>
                          <td className="py-1 text-right font-mono">{formatMoney(tb.taxableBase, cur)}</td>
                          <td className="py-1 text-right font-mono">{formatMoney(tb.taxAmount, cur)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-col items-end space-y-1 border-t border-slate-200 pt-4 text-xs">
                <div className="flex justify-between w-64 text-slate-600">
                  <span>Base Tributável (sem IVA):</span>
                  <span className="font-mono">
                    {formatMoney(
                      payload.doc.subtotal !== undefined
                        ? payload.doc.subtotal
                        : roundMoney(
                            payload.doc.items.reduce(
                              (acc, it) => acc + (it.taxableBase ?? it.subtotal),
                              0
                            )
                          ),
                      cur
                    )}
                  </span>
                </div>
                <div className="flex justify-between w-64 text-slate-600">
                  <span>Total IVA Suportado:</span>
                  <span className="font-mono">
                    {formatMoney(
                      payload.doc.taxTotal !== undefined
                        ? payload.doc.taxTotal
                        : roundMoney(
                            payload.doc.items.reduce((acc, it) => acc + (it.taxAmount ?? 0), 0)
                          ),
                      cur
                    )}
                  </span>
                </div>
                <div className="flex justify-between w-64 text-sm font-semibold text-slate-900 pt-1 border-t border-slate-200">
                  <span>Total da Compra (c/ IVA):</span>
                  <span className="font-mono">{formatMoney(payload.doc.totalAmount, cur)}</span>
                </div>
              </div>
            </>
          )}

          <p className="text-[11px] text-slate-500 border-t border-slate-200 pt-4">
            Processado por programa informático ({settings.pharmacyName} · Stock Management System)
            {payload.kind !== 'PURCHASE' && payload.doc.fiscalValidationStatus !== 'VALIDADO_AGT'
              ? ' — Software NÃO certificado pela AGT (documento sem valor fiscal oficial AGT).'
              : '.'}
          </p>
        </div>
      </div>
    </div>
  );
};
