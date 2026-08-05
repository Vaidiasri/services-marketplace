import { Link, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Home } from './routes/Home';
import { Login } from './routes/Login';
import { RegisterCustomer, RegisterVendor } from './routes/Register';

export function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
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
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
        <Link to="/" className="font-semibold">
          Services Marketplace
        </Link>
        {me ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-500">{me.role.name}</span>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50"
            >
              Sign out
            </button>
          </div>
        ) : (
          <Link to="/login" className="text-sm font-medium underline">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}

function NotFound() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Not found</h1>
      <Link to="/" className="mt-4 inline-block text-sm underline">
        Back home
      </Link>
    </div>
  );
}
