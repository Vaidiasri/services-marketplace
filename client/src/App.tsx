import { Link, Route, Routes } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Home } from '@/routes/Home';
import { Login } from '@/routes/Login';
import { RegisterCustomer, RegisterVendor } from '@/routes/Register';

export function App() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-4xl px-4 py-8">
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
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
        <Link to="/" className="font-semibold">
          Services Marketplace
        </Link>
        {me ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{me.role.name}</span>
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/login">Sign in</Link>
          </Button>
        )}
      </div>
    </header>
  );
}

function NotFound() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <Button variant="outline" asChild>
        <Link to="/">Back home</Link>
      </Button>
    </div>
  );
}
