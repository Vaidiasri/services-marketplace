import { useAuth } from '@/lib/auth';

/**
 * Hiding is cosmetic. Every action these gate maps to a server-guarded endpoint, and
 * the server is the enforcement - see doc/features/M2_PERMISSIONS/plan.md. This exists
 * so a caller is not shown buttons that will 403, not to protect anything.
 */
export function useCan(...slugs: string[]): boolean {
  const { me } = useAuth();
  if (!me) return false;
  // SUPER_ADMIN bypasses server-side by role slug; /me reports '*' to say so.
  if (me.permissions.includes('*')) return true;
  return slugs.every((s) => me.permissions.includes(s));
}

export type NavSection = { label: string; to: string; permission: string };

/**
 * Data, not markup, so adding a section is one entry and the shrinking-UI demo needs no
 * code change - a role invented at runtime gets a sensible nav for free.
 */
const ADMIN_NAV: NavSection[] = [
  { label: 'Dashboard', to: '/admin', permission: 'admin.dashboard.read' },
  { label: 'Vendor applications', to: '/admin/vendors', permission: 'vendor.read_all' },
  { label: 'Categories', to: '/admin/categories', permission: 'category.read' },
  { label: 'Services', to: '/admin/services', permission: 'service.read_all' },
  { label: 'Bookings', to: '/admin/bookings', permission: 'booking.read_all' },
  { label: 'Roles & permissions', to: '/admin/roles', permission: 'role.read' },
  { label: 'Users', to: '/admin/users', permission: 'user.read_all' },
];

const VENDOR_NAV: NavSection[] = [
  { label: 'My services', to: '/vendor/services', permission: 'service.create' },
  { label: 'Booking queue', to: '/vendor/bookings', permission: 'booking.confirm' },
];

const CUSTOMER_NAV: NavSection[] = [
  { label: 'Browse services', to: '/services', permission: 'service.read' },
  { label: 'My bookings', to: '/my/bookings', permission: 'booking.read' },
];

export function buildNav(permissions: string[]): {
  admin: NavSection[];
  vendor: NavSection[];
  customer: NavSection[];
} {
  const has = (slug: string): boolean =>
    permissions.includes('*') || permissions.includes(slug);
  return {
    admin: ADMIN_NAV.filter((s) => has(s.permission)),
    vendor: VENDOR_NAV.filter((s) => has(s.permission)),
    customer: CUSTOMER_NAV.filter((s) => has(s.permission)),
  };
}
