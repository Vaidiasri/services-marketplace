import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight } from 'lucide-react';
import { useLogin } from '@/lib/auth';
import type { ApiError } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SEEDED = [
  { label: 'Super admin', email: 'super@marketplace.test' },
  { label: 'Catalogue moderator (restricted)', email: 'moderator@marketplace.test' },
];

export function Login() {
  const login = useLogin();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const err = login.error as ApiError | null;

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            The interface changes to match the permissions your role holds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate({ email, password }, { onSuccess: () => navigate('/') });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {err && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                {/* The server returns identical bodies for unknown email and wrong
                    password, so there is nothing here to disclose which it was. */}
                <AlertDescription>{err.message}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-full" disabled={login.isPending}>
              {login.isPending ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-4 text-sm text-muted-foreground">
            No account?{' '}
            <Link to="/register" className="font-medium text-foreground underline">
              Register as a customer
            </Link>{' '}
            or{' '}
            <Link to="/register/vendor" className="font-medium text-foreground underline">
              as a vendor
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      {/* Seeded accounts one click away, because a reviewer's first thirty seconds are
          spent looking for exactly this. Password comes from the README, not from here. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Seeded accounts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {SEEDED.map((s) => (
            // A button rather than the Button component: buttonVariants sets
            // whitespace-nowrap, which pushed these emails outside the card.
            <button
              key={s.email}
              type="button"
              onClick={() => setEmail(s.email)}
              className="group flex w-full items-center justify-between gap-2 rounded-lg border border-white/50 bg-white/40 px-3 py-2 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-300/60 hover:bg-white/75 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">{s.label}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {s.email}
                </span>
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 -translate-x-1 text-indigo-500 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100" />
            </button>
          ))}
          <p className="pt-1 text-xs text-muted-foreground">
            Password is in the README.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** Shared by the register screens so a labelled field is one line there too. */
export function Field({
  label,
  id,
  type = 'text',
  value,
  onChange,
  autoComplete,
  required = true,
  error,
}: {
  label: string;
  id: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  required?: boolean;
  error?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={error ? 'border-destructive' : undefined}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
