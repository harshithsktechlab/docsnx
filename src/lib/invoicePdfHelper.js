import { jsPDF } from 'jspdf';
import { formatDate } from './dateHelper';

/**
 * Generates a GST compliant invoice PDF.
 * @param {Object} invoice - The invoice data from the database
 * @param {Object} platform - The platform system settings
 */
export async function generateInvoicePDF(invoice, platform) {
  try {
    const doc = new jsPDF();
    let yPos = 20;

    // Platform Logo & Header
    if (platform?.platformLogo) {
      try {
        // Use a generic format or auto-detect by just passing the data string
        doc.addImage(platform.platformLogo, 14, yPos - 10, 30, 15, undefined, 'FAST');
      } catch (err) {
        console.error('Failed to add logo to PDF:', err);
      }
    }

    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text('TAX INVOICE', 105, yPos, { align: 'center' });
    yPos += 15;

    // Platform Details (Left)
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text(platform?.platformName || 'Platform Name', 14, yPos);
    yPos += 6;
    
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    if (platform?.platformAddress) {
      const addressLines = doc.splitTextToSize(platform.platformAddress, 80);
      doc.text(addressLines, 14, yPos);
      yPos += (addressLines.length * 5);
    }
    
    if (platform?.platformGstin) doc.text(`GSTIN: ${platform.platformGstin}`, 14, yPos += 5);
    if (platform?.platformStateCode) doc.text(`State Code: ${platform.platformStateCode}`, 14, yPos += 5);
    if (platform?.platformEmail) doc.text(`Email: ${platform.platformEmail}`, 14, yPos += 5);
    if (platform?.platformPhone) doc.text(`Phone: ${platform.platformPhone}`, 14, yPos += 5);

    // Invoice Details (Right)
    let rightY = 35;
    doc.setFont('helvetica', 'bold');
    doc.text(`Invoice No: ${invoice.invoiceNumber}`, 120, rightY);
    doc.setFont('helvetica', 'normal');
    doc.text(`Issued Date: ${formatDate(invoice.issuedDate || invoice.createdAt)}`, 120, rightY += 6);
    doc.text(`Due Date: ${formatDate(invoice.dueDate)}`, 120, rightY += 6);
    doc.text(`Status: ${invoice.status.toUpperCase()}`, 120, rightY += 6);
    
    yPos = Math.max(yPos, rightY) + 15;
    
    // Line separator
    doc.line(14, yPos, 196, yPos);
    yPos += 10;

    // Client Details
    doc.setFont('helvetica', 'bold');
    doc.text('BILL TO:', 14, yPos);
    yPos += 6;
    
    doc.text(invoice.clientName || 'Client Name', 14, yPos);
    yPos += 6;
    
    doc.setFont('helvetica', 'normal');
    if (invoice.clientAddress) {
      const clientAddressLines = doc.splitTextToSize(invoice.clientAddress, 80);
      doc.text(clientAddressLines, 14, yPos);
      yPos += (clientAddressLines.length * 5);
    }
    if (invoice.clientEmail) doc.text(`Email: ${invoice.clientEmail}`, 14, yPos += 5);
    if (invoice.clientPhone) doc.text(`Phone: ${invoice.clientPhone}`, 14, yPos += 5);
    if (invoice.clientGstin) doc.text(`GSTIN: ${invoice.clientGstin}`, 14, yPos += 5);
    if (invoice.clientStateCode) doc.text(`State Code: ${invoice.clientStateCode}`, 14, yPos += 5);

    yPos += 15;
    
    // Items Table Header
    doc.setFillColor(240, 240, 240);
    doc.rect(14, yPos, 182, 10, 'F');
    doc.setFont('helvetica', 'bold');
    doc.text('Description', 16, yPos + 7);
    doc.text('Total', 170, yPos + 7);
    
    yPos += 15;

    // Items Details (assuming one generic item for now or from items array)
    doc.setFont('helvetica', 'normal');
    const currencySym = invoice.currency === 'USD' ? '$' : 'Rs.';
    
    let descriptionText = invoice.notes || 'Services rendered';
    if (invoice.items && invoice.items.length > 0) {
       descriptionText = invoice.items.map(i => i.description || '').join('\n');
    }

    const itemDescLines = doc.splitTextToSize(descriptionText, 140);
    doc.text(itemDescLines, 16, yPos);
    doc.text(`${currencySym} ${Number(invoice.amount).toFixed(2)}`, 170, yPos);
    
    yPos += (itemDescLines.length * 6) + 10;
    
    doc.line(14, yPos, 196, yPos);
    yPos += 10;
    
    // Calculation Totals
    const rightColX = 140;
    const valueColX = 170;
    
    doc.text('Base Amount:', rightColX, yPos);
    doc.text(`${currencySym} ${Number(invoice.baseAmount).toFixed(2)}`, valueColX, yPos);
    yPos += 7;
    
    if (invoice.gstType === 'CGST_SGST') {
        const halfGst = (Number(invoice.gstAmount) / 2).toFixed(2);
        doc.text('CGST (9%):', rightColX, yPos);
        doc.text(`${currencySym} ${halfGst}`, valueColX, yPos);
        yPos += 7;
        doc.text('SGST (9%):', rightColX, yPos);
        doc.text(`${currencySym} ${halfGst}`, valueColX, yPos);
        yPos += 7;
    } else if (invoice.gstType === 'IGST') {
        doc.text('IGST (18%):', rightColX, yPos);
        doc.text(`${currencySym} ${Number(invoice.gstAmount).toFixed(2)}`, valueColX, yPos);
        yPos += 7;
    } else {
        doc.text('GST (Exempt):', rightColX, yPos);
        doc.text(`${currencySym} 0.00`, valueColX, yPos);
        yPos += 7;
    }
    
    doc.setFont('helvetica', 'bold');
    doc.text('Total Amount:', rightColX, yPos);
    doc.text(`${currencySym} ${Number(invoice.amount).toFixed(2)}`, valueColX, yPos);
    
    yPos += 20;

    if (yPos > 260) {
      doc.addPage();
      yPos = 20;
    }

    // Footer / Payment Link
    if (invoice.paymentLink) {
        doc.setFont('helvetica', 'normal');
        doc.text('Payment Link:', 14, yPos);
        doc.setTextColor(0, 0, 255);
        doc.textWithLink(invoice.paymentLink, 40, yPos, { url: invoice.paymentLink });
        doc.setTextColor(0, 0, 0);
        yPos += 10;
    }

    doc.setFontSize(8);
    doc.text('This is a computer generated invoice and requires no physical signature.', 105, 280, { align: 'center' });

    const cleanTitle = invoice.invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, '_');
    doc.save(`Invoice_${cleanTitle}.pdf`);
  } catch (error) {
    console.error('Failed to generate PDF:', error);
  }
}
