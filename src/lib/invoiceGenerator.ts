import PDFDocument from 'pdfkit';
import { db } from './db';
import { tenants, systemConfigs, payments, subscriptionPlans, addons } from '../db/schema';
import { eq } from 'drizzle-orm';
import { uploadToAzureBlob } from './azureBlob';

export async function generateInvoiceBuffer(paymentId: string): Promise<{ buffer: Buffer; fileName: string; payment: any; tenant: any } | null> {
  try {
    const paymentRecords = await db.select({
      id: payments.id,
      amount: payments.amount,
      currency: payments.currency,
      status: payments.status,
      createdAt: payments.createdAt,
      razorpayOrderId: payments.razorpayOrderId,
      tenantId: payments.tenantId,
      planName: subscriptionPlans.name,
      addonName: addons.name
    })
    .from(payments)
    .leftJoin(subscriptionPlans, eq(payments.planId, subscriptionPlans.id))
    .leftJoin(addons, eq(payments.addonId, addons.id))
    .where(eq(payments.id, paymentId));

    if (!paymentRecords.length) return null;
    const payment = paymentRecords[0];

    const tenantRecords = await db.select().from(tenants).where(eq(tenants.id, payment.tenantId));
    if (!tenantRecords.length) return null;
    const tenant = tenantRecords[0];

    const configRecords = await db.select().from(systemConfigs).limit(1);
    const config = configRecords[0];

    return await new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        doc.on('error', reject);
        const buffers: Buffer[] = [];
        
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
          const pdfBuffer = Buffer.concat(buffers);
          const fileName = `invoice_${payment.id}.pdf`;
          resolve({ buffer: pdfBuffer, fileName, payment, tenant });
        });

        // Invoice Header
        doc.fontSize(20).text('INVOICE', { align: 'right' });
        
        // Platform Logo & Header
        if (config?.platformLogo) {
          try {
            // Check if it's base64 data url
            if (config.platformLogo.startsWith('data:image/')) {
              doc.image(config.platformLogo, 50, doc.y - 20, { height: 30 });
            }
          } catch (err) {
            console.error('Failed to add logo to PDF:', err);
          }
        }
        
        doc.moveDown();

        // Platform Details
        doc.fontSize(12).text(config?.platformName || 'Platform Name', { align: 'left' });
        if (config?.platformAddress) doc.fontSize(10).text(config.platformAddress);
        if (config?.platformGstin) doc.fontSize(10).text(`GSTIN: ${config.platformGstin}`);
        doc.moveDown();

        // Bill To
        doc.fontSize(12).text('Bill To:');
        doc.fontSize(10).text(tenant.billingName || tenant.name);
        if (tenant.billingAddress) doc.text(tenant.billingAddress);
        if (tenant.billingGst) doc.text(`GSTIN: ${tenant.billingGst}`);
        doc.moveDown();

        // Invoice Details
        doc.text(`Invoice Number: ${payment.razorpayOrderId || payment.id}`);
        doc.text(`Date: ${new Date(payment.createdAt).toLocaleDateString()}`);
        doc.text(`Status: ${payment.status.toUpperCase()}`);
        doc.moveDown(2);

        // Itemized
        const itemDescription = payment.planName || payment.addonName || 'Subscription / Add-on';
        
        doc.fontSize(12).text('Description', 50, doc.y, { continued: true });
        doc.text('Amount', 450, doc.y, { align: 'right' });
        doc.moveTo(50, doc.y + 5).lineTo(550, doc.y + 5).stroke();
        doc.moveDown();

        doc.fontSize(10).text(itemDescription, 50, doc.y, { continued: true });
        doc.text(`${payment.currency} ${Number(payment.amount).toFixed(2)}`, 450, doc.y, { align: 'right' });
        doc.moveDown(2);

        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown();
        doc.fontSize(12).text('Total', 50, doc.y, { continued: true });
        doc.text(`${payment.currency} ${Number(payment.amount).toFixed(2)}`, 450, doc.y, { align: 'right' });

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  } catch (error) {
    console.error("Error generating invoice buffer:", error);
    return null;
  }
}

export async function generateAndUploadInvoice(paymentId: string): Promise<string | null> {
  try {
    const invoiceData = await generateInvoiceBuffer(paymentId);
    if (!invoiceData) return null;
    
    const { buffer, fileName } = invoiceData;
    const file = new File([buffer as any], fileName, { type: 'application/pdf' });
    const url = await uploadToAzureBlob(file, fileName);
    
    return url;
  } catch (error) {
    console.error("Error generating and uploading invoice:", error);
    return null;
  }
}
