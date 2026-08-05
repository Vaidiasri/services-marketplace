import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { useRegisterCustomer, useRegisterVendor } from '@/lib/auth';
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
import { Field } from './Login';

/** Maps the server's Zod issue list onto the form so errors land on the right input. */
function fieldErrors(err: ApiError | null): Record<string, string> {
  const issues = (err?.details as { issues?: { path: string; message: string }[] })?.issues;
  if (!issues) return {};
  return Object.fromEntries(issues.map((i) => [i.path, i.message]));
}

export function RegisterCustomer() {
  const reg = useRegisterCustomer();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: '', email: '', password: '' });
  const err = reg.error as ApiError | null;
  const fe = fieldErrors(err);
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card className="mx-auto max-w-sm">
      <CardHeader>
        <CardTitle>Create a customer account</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            reg.mutate(form, { onSuccess: () => navigate('/') });
          }}
        >
          <Field id="fullName" label="Full name" value={form.fullName} onChange={set('fullName')} error={fe.fullName} />
          <Field id="email" label="Email" type="email" value={form.email} onChange={set('email')} error={fe.email} />
          <Field
            id="password"
            label="Password"
            type="password"
            value={form.password}
            onChange={set('password')}
            error={fe.password}
          />

          {err && !Object.keys(fe).length && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{err.message}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" className="w-full" disabled={reg.isPending}>
            {reg.isPending ? 'Creating...' : 'Create account'}
          </Button>
        </form>

        <p className="mt-4 text-sm text-muted-foreground">
          Already have one?{' '}
          <Link to="/login" className="font-medium text-foreground underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Registers into a PENDING vendor profile. There is no field here for status or role -
 * both are set server-side, and the strict schema rejects them if sent.
 */
export function RegisterVendor() {
  const reg = useRegisterVendor();
  const navigate = useNavigate();
  const [form, setForm] = useState<Record<string, string>>({
    fullName: '',
    email: '',
    password: '',
    businessName: '',
    contactName: '',
    contactPhone: '',
    addressLine1: '',
    city: '',
    state: '',
    postalCode: '',
    // Defaulted from the browser, but sent explicitly and validated against the
    // server's own tz database - slot maths depends on this being a real IANA name.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const err = reg.error as ApiError | null;
  const fe = fieldErrors(err);
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const fields: [string, string, string?][] = [
    ['fullName', 'Your name'],
    ['email', 'Email', 'email'],
    ['password', 'Password', 'password'],
    ['businessName', 'Business name'],
    ['contactName', 'Contact name'],
    ['contactPhone', 'Contact phone'],
    ['addressLine1', 'Address'],
    ['city', 'City'],
    ['state', 'State'],
    ['postalCode', 'Postal code'],
    ['timezone', 'Timezone (IANA)'],
  ];

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>Apply as a vendor</CardTitle>
        <CardDescription>
          Your account starts as pending. An admin reviews it before you can publish
          anything.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            reg.mutate(form, { onSuccess: () => navigate('/') });
          }}
        >
          {fields.map(([key, label, type]) => (
            <Field
              key={key}
              id={key}
              label={label}
              type={type}
              value={form[key]}
              onChange={set(key)}
              error={fe[key]}
            />
          ))}

          <div className="space-y-3 sm:col-span-2">
            {err && !Object.keys(fe).length && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{err.message}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={reg.isPending}>
              {reg.isPending ? 'Submitting...' : 'Submit application'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
