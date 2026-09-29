import 'dotenv/config';
import { db } from '../src/db/db'; // adjust path if needed
import { passwords, bankInfos } from '../src/db/schema';
import { encrypt, decrypt } from '../src/lib/encryption';
import { eq } from 'drizzle-orm';

async function migrate() {
  console.log('Starting encryption migration...');

  // 1. Migrate Passwords
  const allPasswords = await db.select().from(passwords);
  let pwMigrated = 0;
  for (const p of allPasswords) {
    if (p.passwordEncrypted) {
      // Check if it's already using the new format (4 parts)
      const parts = p.passwordEncrypted.split(':');
      if (parts.length === 3) {
        // It's the old format. Decrypt and re-encrypt
        const plain = decrypt(p.passwordEncrypted);
        if (plain && plain !== '[Decryption Failed]') {
          const newCipher = encrypt(plain);
          await db.update(passwords).set({ passwordEncrypted: newCipher }).where(eq(passwords.id, p.id));
          pwMigrated++;
        } else {
          console.error(`Failed to decrypt password ID: ${p.id}`);
        }
      }
    }
  }
  console.log(`Migrated ${pwMigrated} passwords.`);

  // 2. Migrate Bank Infos
  const allBankInfos = await db.select().from(bankInfos);
  let bankMigrated = 0;
  for (const b of allBankInfos) {
    let updated = false;
    const updates: any = {};

    if (b.accountNumber) {
      const parts = b.accountNumber.split(':');
      if (parts.length === 3) {
        const plain = decrypt(b.accountNumber);
        if (plain && plain !== '[Decryption Failed]') {
          updates.accountNumber = encrypt(plain);
          updated = true;
        }
      }
    }

    if (b.ifscCode) {
      const parts = b.ifscCode.split(':');
      if (parts.length === 3) {
        const plain = decrypt(b.ifscCode);
        if (plain && plain !== '[Decryption Failed]') {
          updates.ifscCode = encrypt(plain);
          updated = true;
        }
      }
    }
    
    // Process cards if any
    if (b.cards && Array.isArray(b.cards)) {
      let cardsUpdated = false;
      const newCards = b.cards.map((card: any) => {
        let newCard = { ...card };
        if (card.cardNumber) {
          const parts = card.cardNumber.split(':');
          if (parts.length === 3) {
            const plain = decrypt(card.cardNumber);
            if (plain && plain !== '[Decryption Failed]') {
              newCard.cardNumber = encrypt(plain);
              cardsUpdated = true;
            }
          }
        }
        if (card.cvv) {
          const parts = card.cvv.split(':');
          if (parts.length === 3) {
            const plain = decrypt(card.cvv);
            if (plain && plain !== '[Decryption Failed]') {
              newCard.cvv = encrypt(plain);
              cardsUpdated = true;
            }
          }
        }
        return newCard;
      });

      if (cardsUpdated) {
        updates.cards = newCards;
        updated = true;
      }
    }

    if (updated) {
      await db.update(bankInfos).set(updates).where(eq(bankInfos.id, b.id));
      bankMigrated++;
    }
  }
  console.log(`Migrated ${bankMigrated} bank infos.`);
  
  console.log('Migration complete.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
