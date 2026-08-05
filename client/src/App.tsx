import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { LogOut, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Aurora } from '@/components/Aurora';
import { Button } from '@/components/ui/button';
import { Home } from '@/routes/Home';
import { Login } from '@/routes/Login';
import { RegisterCustomer, RegisterVendor } from '@/routes/Register';

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
        className="mx-auto max-w-4xl animate-in px-4 py-10 fade-in slide-in-from-bottom-3 duration-500"
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<RegisterCustomer />} />
          <Route path="/register/vendor" element={<RegisterVendor />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function Header() {
  const { me, logout } = useAuth();
  return (
    // Sticky rather than static: the blur has content moving behind it as you scroll,
    // which is the only time glassmorphism actually reads as glass.
    <header className="sticky top-0 z-40 border-b border-white/40 bg-white/60 backdrop-blur-xl backdrop-saturate-150 dark:border-white/10 dark:bg-slate-900/50">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
        <Link
          to="/"
          className="group flex items-center gap-2 font-semibold tracking-tight transition-opacity hover:opacity-80"
        >
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-sky-500 text-white shadow-md shadow-indigo-500/30 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6">
            <Sparkles className="h-4 w-4" />
          </span>
          Services Marketplace
        </Link>

        {me ? (
          <div className="flex items-center gap-3">
            <span className="hidden rounded-full border border-white/50 bg-white/50 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-md sm:inline dark:border-white/10 dark:bg-white/5">
              {me.role.name}
            </span>
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link to="/login">Sign in</Link>
          </Button>
        )}
      </div>
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
