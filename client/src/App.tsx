import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { LogOut, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { buildNav } from '@/lib/permissions';
import { Aurora } from '@/components/Aurora';
import { Button } from '@/components/ui/button';
import { Home } from '@/routes/Home';
import { Login } from '@/routes/Login';
import { RegisterCustomer, RegisterVendor } from '@/routes/Register';
import { Catalogue } from '@/routes/Catalogue';
import { ServiceDetail } from '@/routes/ServiceDetail';
import { BookingDetail, MyBookings } from '@/routes/MyBookings';
import { VendorQueue } from '@/routes/VendorQueue';
import { AdminVendors } from '@/routes/AdminVendors';

export function App() {
  const location = useLocation();

  return (
    <div className="min-h-screen">
      <Aurora />
      <Header />
      {/* Keyed on pathname so each navigation replays the entrance animation - without
          the key React reuses the element and the transition only ever plays once. */}
      <main
        key={location.pathname}
        className="mx-auto max-w-5xl animate-in px-4 py-10 fade-in slide-in-from-bottom-3 duration-500"
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<RegisterCustomer />} />
          <Route path="/register/vendor" element={<RegisterVendor />} />

          {/* Public. The server widens the response for a signed-in owner rather than
              needing a second route, so these work either way. */}
          <Route path="/services" element={<Catalogue />} />
          <Route path="/services/:id" element={<ServiceDetail />} />

          <Route path="/my/bookings" element={<MyBookings />} />
          <Route path="/my/bookings/:id" element={<BookingDetail />} />
          <Route path="/vendor/bookings" element={<VendorQueue />} />
          <Route path="/admin/vendors" element={<AdminVendors />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function Header() {
  const { me, logout } = useAuth();

  /**
   * Built from the caller's actual permissions, so the navigation shrinks for a restricted
   * role with no per-role conditionals here. Hiding is cosmetic - every destination is
   * server-guarded - but it means nobody is offered a link that will 403.
   *
   * Signed out, only the catalogue is offered, which is genuinely public.
   */
  const nav = buildNav(me?.permissions ?? ['service.read']);
  const sections = [...nav.customer, ...nav.vendor, ...nav.admin];

  return (
    // Sticky rather than static: the blur has content moving behind it as you scroll,
    // which is the only time glassmorphism actually reads as glass.
    <header className="sticky top-0 z-40 border-b border-white/40 bg-white/60 backdrop-blur-xl backdrop-saturate-150 dark:border-white/10 dark:bg-slate-900/50">
      {/*
        Two deliberate rows rather than one wrapping row. A super admin has seven nav
        sections, and on a single row those wrap and push the sign-out control onto a third
        line - the header ate 180px of a 720px-tall viewport. Nav gets its own row that
        scrolls horizontally instead of wrapping, so the height is fixed whatever the role.
      */}
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5">
        <Link
          to="/"
          className="group flex items-center gap-2 font-semibold tracking-tight transition-opacity hover:opacity-80"
        >
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-sky-500 text-white shadow-md shadow-indigo-500/30 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6">
            <Sparkles className="h-4 w-4" />
          </span>
          <span className="hidden sm:inline">Services Marketplace</span>
        </Link>

        {me ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden max-w-[14rem] truncate rounded-full border border-white/50 bg-white/50 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-md sm:inline dark:border-white/10 dark:bg-white/5">
              {me.email}
            </span>
            <span className="rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-600 dark:text-indigo-300">
              {me.role.name}
            </span>
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link to="/login">Sign in</Link>
          </Button>
        )}
      </div>

      {sections.length > 0 && (
        <nav className="mx-auto max-w-5xl overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex items-center gap-1">
            {sections.map((s) => (
              <NavLink
                key={s.to}
                to={s.to}
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                    isActive
                      ? 'bg-indigo-500/10 font-medium text-indigo-600 dark:text-indigo-300'
                      : 'text-muted-foreground hover:text-foreground'
                  }`
                }
              >
                {s.label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}

function NotFound() {
  return (
    <div className="space-y-4 text-center">
      <p className="text-6xl font-semibold tracking-tighter text-muted-foreground/40">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <Button variant="outline" asChild>
        <Link to="/">Back home</Link>
      </Button>
    </div>
  );
}
