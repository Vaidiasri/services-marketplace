require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const argon2 = require("argon2");
const p = new PrismaClient();
const PW = process.env.TEST_ADMIN_PASSWORD ?? "TestPass!2026";
(async () => {
  const hash = await argon2.hash(PW, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  for (const [email, roleSlug, name] of [
    ["super@marketplace.test", "SUPER_ADMIN", "Super Admin"],
    ["moderator@marketplace.test", "CATALOGUE_MODERATOR", "Catalogue Moderator"],
  ]) {
    const role = await p.role.findUnique({ where: { slug: roleSlug } });
    await p.user.upsert({
      where: { email },
      update: { roleId: role.id, passwordHash: hash, isActive: true },
      create: { email, fullName: name, passwordHash: hash, roleId: role.id },
    });
    console.log("upserted", email, "->", roleSlug);
  }
  await p.$disconnect();
})();
