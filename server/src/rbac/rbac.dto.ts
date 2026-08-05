import { z } from 'zod';

const slug = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Role slug must be UPPER_SNAKE_CASE');

export const CreateRoleSchema = z
  .object({
    slug,
    name: z.string().trim().min(1).max(120),
    permissionSlugs: z.array(z.string().trim()).default([]),
  })
  .strict();

export const UpdateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    // Sending this replaces the WHOLE set. The client always sends the complete
    // checkbox state; the single-slug revoke route exists so the live demo never has to
    // go through here and risk wiping a role.
    permissionSlugs: z.array(z.string().trim()).optional(),
  })
  .strict();

export const AssignRoleSchema = z.object({ roleId: z.string().min(1) }).strict();

export type CreateRoleDto = z.infer<typeof CreateRoleSchema>;
export type UpdateRoleDto = z.infer<typeof UpdateRoleSchema>;
export type AssignRoleDto = z.infer<typeof AssignRoleSchema>;
