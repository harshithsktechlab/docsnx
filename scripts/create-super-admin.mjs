import { prisma } from '../src/lib/db.js';
import bcrypt from 'bcryptjs';

async function createOrPromoteSuperAdmin() {
  const email = process.argv[2];
  const password = process.argv[3];
  const name = process.argv[4] || 'Super Admin';
  const tenantSlug = process.argv[5] || 'admin';

  if (!email) {
    console.log('Usage: node scripts/create-super-admin.mjs <email> [password] [name] [tenant-slug]');
    process.exit(1);
  }

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existingUser) {
      console.log(`User with email "${email}" found. Promoting to SUPER_ADMIN...`);
      const updatedUser = await prisma.user.update({
        where: { id: existingUser.id },
        data: { role: 'SUPER_ADMIN' },
      });
      console.log(`Success! User "${updatedUser.name}" has been promoted to SUPER_ADMIN.`);
    } else {
      if (!password) {
        console.error('Error: User does not exist, and no password was provided.');
        process.exit(1);
      }

      console.log(`Creating new tenant/slug "${tenantSlug}"...`);
      // Upsert tenant not directly supported by our proxy proxy, but create might work
      // Let's just create tenant
      let tenant;
      try {
          tenant = await prisma.tenant.create({
            data: { name: `${name}'s Organization`, slug: tenantSlug.toLowerCase() },
          });
      } catch(e) {
          tenant = await prisma.tenant.findUnique({where: {slug: tenantSlug.toLowerCase()}});
      }

      console.log(`Hashing password and creating new SUPER_ADMIN user...`);
      const passwordHash = await bcrypt.hash(password, 10);
      const newUser = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: email.toLowerCase(),
          passwordHash,
          name,
          role: 'SUPER_ADMIN',
        },
      });

      await prisma.profile.create({
        data: {
          userId: newUser.id,
        },
      });

      console.log(`Success! Super Admin user "${newUser.name}" (${newUser.email}) created successfully.`);
    }
  } catch (error) {
    console.error('Error creating/promoting Super Admin:', error);
  }
}

createOrPromoteSuperAdmin();
