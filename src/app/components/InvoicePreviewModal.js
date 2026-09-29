import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, FileText, X } from 'lucide-react';
import { formatDate } from '@/lib/dateHelper';
import { generateInvoicePDF } from '@/lib/invoicePdfHelper';

export default function InvoicePreviewModal({ invoice, platformConfig, open, onOpenChange }) {
  if (!invoice) return null;

  const handleDownload = () => {
    generateInvoicePDF(invoice, platformConfig || { 
      platformName: 'DocsNX', 
      platformEmail: 'billing@docsnx.com' 
    });
  };

  const currencySymbol = invoice.currency === 'USD' ? '$' : '₹';

  // Calculate GST components based on GST Type
  const amount = Number(invoice.amount) || 0;
  let cgst = 0, sgst = 0, igst = 0, taxableValue = amount;

  if (invoice.gstType === 'CGST_SGST') {
    taxableValue = amount / 1.18;
    cgst = taxableValue * 0.09;
    sgst = taxableValue * 0.09;
  } else if (invoice.gstType === 'IGST') {
    taxableValue = amount / 1.18;
    igst = taxableValue * 0.18;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-3xl border border-border/80 bg-card rounded-2xl shadow-2xl p-0 overflow-hidden flex flex-col max-h-[90vh]">
        <DialogHeader className="p-4 border-b border-border/50 bg-muted/30 flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2 text-xl font-black">
              <FileText className="text-primary" />
              Invoice #{invoice.invoiceNumber}
            </DialogTitle>
            <div className="flex gap-2">
              <Button onClick={handleDownload} size="sm" className="bg-primary hover:bg-primary/90 text-white font-bold rounded-lg px-4 shadow-md">
                <Download size={14} className="mr-2" /> Download PDF
              </Button>
            </div>
          </div>
        </DialogHeader>
        
        <DialogBody className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-background">
          <div className="max-w-2xl mx-auto bg-white text-black p-8 rounded-lg shadow-sm border border-gray-200" id="invoice-html-preview">
            
            <div className="text-center mb-8">
              <h2 className="text-3xl font-black tracking-tight text-gray-900">TAX INVOICE</h2>
            </div>
            
            <div className="flex justify-between items-start mb-10 pb-6 border-b border-gray-200">
              <div className="flex flex-col gap-1">
                {platformConfig?.platformLogo && (
                  <img src={platformConfig.platformLogo} alt="Logo" className="h-12 w-auto mb-2 object-contain" />
                )}
                <h3 className="font-bold text-lg text-gray-800">{platformConfig?.platformName || 'Platform Name'}</h3>
                {platformConfig?.platformAddress && <p className="text-sm text-gray-600 whitespace-pre-wrap">{platformConfig.platformAddress}</p>}
                {platformConfig?.platformGstin && <p className="text-sm text-gray-600 font-semibold mt-1">GSTIN: {platformConfig.platformGstin}</p>}
                {platformConfig?.platformStateCode && <p className="text-sm text-gray-600">State Code: {platformConfig.platformStateCode}</p>}
                {platformConfig?.platformEmail && <p className="text-sm text-gray-600">Email: {platformConfig.platformEmail}</p>}
                {platformConfig?.platformPhone && <p className="text-sm text-gray-600">Phone: {platformConfig.platformPhone}</p>}
              </div>
              <div className="flex flex-col gap-1 text-right">
                <p className="text-sm text-gray-600"><span className="font-semibold text-gray-800">Invoice No:</span> {invoice.invoiceNumber}</p>
                <p className="text-sm text-gray-600"><span className="font-semibold text-gray-800">Date:</span> {formatDate(invoice.issuedDate || invoice.createdAt)}</p>
                <p className="text-sm text-gray-600"><span className="font-semibold text-gray-800">Due Date:</span> {formatDate(invoice.dueDate)}</p>
                <div className="mt-2 inline-block px-3 py-1 bg-gray-100 text-gray-800 text-xs font-bold rounded-full ml-auto">
                  {invoice.status.toUpperCase()}
                </div>
              </div>
            </div>

            <div className="mb-10">
              <h4 className="text-sm font-bold text-gray-500 uppercase tracking-widest mb-3">Bill To</h4>
              <div className="flex flex-col gap-1">
                <p className="font-bold text-lg text-gray-800">{invoice.clientName}</p>
                {invoice.clientAddress && <p className="text-sm text-gray-600 whitespace-pre-wrap">{invoice.clientAddress}</p>}
                {invoice.clientGstin && <p className="text-sm text-gray-600 font-semibold mt-1">GSTIN: {invoice.clientGstin}</p>}
                {invoice.clientStateCode && <p className="text-sm text-gray-600">State Code: {invoice.clientStateCode}</p>}
                {invoice.clientEmail && <p className="text-sm text-gray-600">Email: {invoice.clientEmail}</p>}
                {invoice.clientPhone && <p className="text-sm text-gray-600">Phone: {invoice.clientPhone}</p>}
              </div>
            </div>

            <div className="mb-8 overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b-2 border-gray-800 text-gray-800">
                    <th className="py-3 px-2 font-bold text-sm uppercase">Description</th>
                    <th className="py-3 px-2 font-bold text-sm uppercase text-right w-32">Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-200">
                    <td className="py-4 px-2 text-sm text-gray-700 whitespace-pre-wrap">
                      {invoice.notes || 'Subscription / Services'}
                    </td>
                    <td className="py-4 px-2 text-sm text-gray-900 font-medium text-right">
                      {currencySymbol}{taxableValue.toFixed(2)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="flex justify-end mb-10">
              <div className="w-64 flex flex-col gap-2">
                <div className="flex justify-between text-sm text-gray-600">
                  <span>Taxable Value:</span>
                  <span>{currencySymbol}{taxableValue.toFixed(2)}</span>
                </div>
                {invoice.gstType === 'CGST_SGST' && (
                  <>
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>CGST (9%):</span>
                      <span>{currencySymbol}{cgst.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>SGST (9%):</span>
                      <span>{currencySymbol}{sgst.toFixed(2)}</span>
                    </div>
                  </>
                )}
                {invoice.gstType === 'IGST' && (
                  <div className="flex justify-between text-sm text-gray-600">
                    <span>IGST (18%):</span>
                    <span>{currencySymbol}{igst.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-black text-gray-900 border-t-2 border-gray-800 pt-2 mt-1">
                  <span>Total Amount:</span>
                  <span>{currencySymbol}{amount.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {invoice.paymentLink && invoice.status !== 'paid' && (
              <div className="text-center mt-8 p-6 bg-blue-50 rounded-xl border border-blue-100">
                <p className="text-sm text-blue-800 font-medium mb-3">Please proceed to pay online using the secure payment link.</p>
                <a href={invoice.paymentLink} target="_blank" rel="noreferrer" className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg transition-colors shadow-sm">
                  Pay Now {currencySymbol}{amount.toFixed(2)}
                </a>
              </div>
            )}
            
            <div className="mt-12 pt-6 border-t border-gray-200 text-center">
              <p className="text-xs text-gray-500 font-medium">This is a computer-generated invoice and does not require a physical signature.</p>
              <p className="text-xs text-gray-500 mt-1 font-bold tracking-wider uppercase">Thank you for your business!</p>
            </div>
            
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
