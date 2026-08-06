import { useState } from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { DataState } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ApiError } from '@/lib/api';
import {
  useCreateRole,
  useDeleteRole,
  usePermissions,
  useRoles,
  useSaveRolePermissions,
  type PermissionCatalogue,
  type Role,
} from '@/lib/manage';

/**
 * The roles console - the screen that shows permissions really are data.
 *
 * Ticking a box writes a `RolePermission` row. Nothing is redeployed, no token is reissued,
 * and the change takes effect on the affected user's very next request, because permissions
 * are resolved per request rather than baked into the access token.
 *
 * Two refusals are worth watching for here, and both come from the server: granting a
 * permission the caller does not hold itself is ESCALATION_BLOCKED, and a system role cannot
 * be deleted. Neither is enforced in this file.
 */
export function AdminRoles() {
  const roles = useRoles();
  const permissions = usePermissions();
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Roles &amp; permissions</h1>
          <p className="text-sm text-muted-foreground">
            A role's permissions are rows in the database, resolved on every request. Revoke
            one and the holder loses it on their next click - no redeploy, no re-login.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(!creating)}>
          <Plus className="h-3.5 w-3.5" />
          New role
        </Button>
      </header>

      {creating && <CreateRole onDone={() => setCreating(false)} />}

      <DataState
        isLoading={roles.isLoading || permissions.isLoading}
        isError={roles.isError || permissions.isError}
        error={(roles.error ?? permissions.error) as ApiError}
        isEmpty={roles.data?.length === 0}
        emptyTitle="No roles"
        onRetry={() => {
          void roles.refetch();
          void permissions.refetch();
        }}
      >
        <ul className="space-y-3">
          {(roles.data ?? []).map((role) => (
            <RoleCard key={role.id} role={role} catalogue={permissions.data ?? {}} />
          ))}
        </ul>
      </DataState>
    </div>
  );
}

function RoleCard({ role, catalogue }: { role: Role; catalogue: PermissionCatalogue }) {
  const save = useSaveRolePermissions();
  const remove = useDeleteRole();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(role.permissions ?? []);

  // SUPER_ADMIN holds zero permission rows on purpose - it bypasses by role slug. Granting
  // it every slug would stop being "every" the moment a permission is added, so the grid
  // would be actively misleading here rather than merely empty.
  const bypasses = role.slug === 'SUPER_ADMIN';

  const total = Object.values(catalogue).flat().length;
  const dirty =
    selected.length !== (role.permissions?.length ?? 0) ||
    selected.some((s) => !role.permissions?.includes(s));

  const toggle = (slug: string): void =>
    setSelected((s) => (s.includes(slug) ? s.filter((x) => x !== slug) : [...s, slug]));

  return (
    <li className="glass space-y-3 rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {bypasses && <ShieldCheck className="h-4 w-4 text-indigo-500" />}
            <span className="truncate">{role.name}</span>
            <code className="rounded bg-white/50 px-1.5 py-0.5 text-xs text-muted-foreground dark:bg-white/5">
              {role.slug}
            </code>
            {role.isSystem && (
              <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-xs">system</span>
            )}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {bypasses
              ? 'Holds zero permission rows and bypasses every check by role slug'
              : `${role.permissions?.length ?? 0} of ${total} permissions`}
            {role.userCount !== undefined &&
              ` · ${role.userCount} ${role.userCount === 1 ? 'user' : 'users'}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!bypasses && (
            <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
              {open ? 'Close' : 'Edit permissions'}
            </Button>
          )}
          {!role.isSystem && (
            <Button
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: role.id })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {(save.isError || remove.isError) && (
        <Alert variant="destructive">
          <AlertTitle>
            {((save.error ?? remove.error) as ApiError).code === 'ESCALATION_BLOCKED'
              ? 'You cannot grant a permission you do not hold yourself'
              : ((save.error ?? remove.error) as ApiError).code === 'ROLE_IS_SYSTEM'
                ? 'System roles cannot be changed this way'
                : 'That change was refused'}
          </AlertTitle>
          <AlertDescription>
            {((save.error ?? remove.error) as ApiError).message}
          </AlertDescription>
        </Alert>
      )}

      {open && !bypasses && (
        <div className="space-y-4 border-t border-white/40 pt-3 dark:border-white/10">
          {Object.entries(catalogue).map(([resource, slugs]) => (
            <fieldset key={resource} className="space-y-1.5">
              <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {resource}
              </legend>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {slugs.map((slug) => (
                  <label
                    key={slug}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-white/40 dark:hover:bg-white/5"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(slug)}
                      onChange={() => toggle(slug)}
                    />
                    {/* The action, since the resource is already the legend. The full slug
                        is what the server compares, so it stays visible in the title. */}
                    <span className="min-w-0 truncate" title={slug}>
                      {slug.slice(resource.length + 1) || slug}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate({ id: role.id, permissionSlugs: selected })}
            >
              {save.isPending ? 'Saving...' : 'Save permissions'}
            </Button>
            <Button
              variant="outline"
              disabled={!dirty}
              onClick={() => setSelected(role.permissions ?? [])}
            >
              Reset
            </Button>
            {save.isSuccess && !dirty && (
              <p className="text-sm text-muted-foreground">
                Saved. Anyone holding this role is affected on their next request.
              </p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function CreateRole({ onDone }: { onDone: () => void }) {
  const create = useCreateRole();
  const [form, setForm] = useState({ slug: '', name: '' });

  return (
    <form
      className="glass flex flex-wrap items-end gap-2 rounded-xl p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          {
            slug: form.slug.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_'),
            name: form.name.trim(),
            // Deliberately none: a new role starts with nothing and is granted what it
            // needs. Cloning an existing role's set is how a "read-only" role quietly
            // ships with write access.
            permissionSlugs: [],
          },
          { onSuccess: onDone },
        );
      }}
    >
      <div className="min-w-[10rem] flex-1 space-y-1.5">
        <Label htmlFor="role-name">Name</Label>
        <Input
          id="role-name"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Support agent"
        />
      </div>
      <div className="min-w-[10rem] flex-1 space-y-1.5">
        <Label htmlFor="role-slug">Slug</Label>
        <Input
          id="role-slug"
          required
          value={form.slug}
          onChange={(e) => setForm({ ...form, slug: e.target.value })}
          placeholder="SUPPORT_AGENT"
        />
      </div>
      <Button type="submit" size="sm" disabled={create.isPending}>
        Create role
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={onDone}>
        Cancel
      </Button>
      {create.isError && (
        <Alert variant="destructive" className="w-full">
          <AlertTitle>That role was refused</AlertTitle>
          <AlertDescription>{(create.error as ApiError).message}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
