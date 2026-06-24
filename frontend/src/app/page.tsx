"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Icon } from "@/components/icon";
import * as auth from "@/lib/api/auth";

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [agreed, setAgreed] = React.useState(false);
  const [loading, setLoading] = React.useState<null | "form">(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Please enter your full name.");
    if (!email.includes("@")) return setError("Please enter a valid work email.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (!agreed) return setError("Please accept the Terms and Privacy Policy.");

    setLoading("form");
    try {
      await auth.signUp({ name, email, password });
      toast.success(`Welcome, ${name.split(" ")[0]}`);
      router.push("/browser");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-app-bg text-on-surface">
      {/* Left: branding */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden border-r border-border-subtle bg-[#ECEEF2] p-xxl lg:flex">
        <div className="relative z-10 flex items-center gap-sm">
          <Icon name="note_stack" className="text-[32px] text-primary-container" />
          <span className="font-display-sm text-display-sm font-bold tracking-tight text-text-primary">
            Docflow
          </span>
        </div>
        <div className="relative z-10 max-w-md">
          <h1 className="mb-md font-display-lg text-display-lg text-text-primary">
            Documents that move at your team&apos;s speed
          </h1>
          <p className="font-body-base text-body-base text-text-secondary">
            Professional collaborative environments where precision, trust, and
            high-information density are paramount.
          </p>
          <ul className="mt-xl flex flex-col gap-md">
            {[
              { icon: "groups", text: "Real-time multi-user editing" },
              { icon: "history", text: "Versioning with review & approval" },
              { icon: "lock", text: "Role-based access control" },
            ].map((f) => (
              <li key={f.icon} className="flex items-center gap-sm font-ui-base text-ui-base text-text-secondary">
                <Icon name={f.icon} className="text-[20px] text-primary-container" />
                {f.text}
              </li>
            ))}
          </ul>
        </div>
        <div className="pointer-events-none absolute bottom-0 right-0 translate-x-1/3 translate-y-1/3 opacity-10">
          <Icon name="description" className="text-[400px] text-primary" />
        </div>
      </div>

      {/* Right: form */}
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto bg-document-surface px-lg py-xl">
        <div className="mb-xl flex items-center gap-sm lg:hidden">
          <Icon name="note_stack" className="text-[28px] text-primary-container" />
          <span className="font-display-sm text-display-sm font-bold tracking-tight text-text-primary">
            Docflow
          </span>
        </div>
        <div className="w-full max-w-[400px]">
          <div className="mb-xl text-center lg:text-left">
            <h2 className="mb-xs font-h1 text-h1 text-text-primary">Create your account</h2>
            <p className="font-ui-base text-ui-base text-text-secondary">
              Start collaborating with precision today.
            </p>
          </div>

          {error && (
            <div className="mb-lg flex items-center gap-2 rounded-lg border border-status-destructive/30 bg-deletion-bg px-3 py-2 font-ui-sm text-ui-sm text-deletion-text">
              <Icon name="error" size={18} />
              {error}
            </div>
          )}

          <form className="space-y-lg" onSubmit={handleSubmit} noValidate>
            <Field
              id="name"
              label="Full Name"
              icon="person"
              placeholder="Jane Doe"
              type="text"
              value={name}
              onChange={setName}
            />
            <Field
              id="email"
              label="Work Email"
              icon="mail"
              placeholder="jane@company.com"
              type="email"
              value={email}
              onChange={setEmail}
            />
            <div>
              <label
                className="mb-xs block font-ui-sm text-ui-sm font-medium text-text-primary"
                htmlFor="password"
              >
                Password
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-sm">
                  <Icon name="lock" className="text-[20px] text-outline" />
                </div>
                <input
                  className="block w-full rounded-lg border border-border-subtle bg-surface-bright py-sm pl-[36px] pr-[36px] font-ui-base text-ui-base text-text-primary transition-colors placeholder:text-text-muted focus:border-primary-container focus:ring-1 focus:ring-primary-container"
                  id="password"
                  name="password"
                  placeholder="••••••••"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center pr-sm text-outline transition-colors hover:text-text-primary focus:outline-none"
                >
                  <Icon name={showPassword ? "visibility" : "visibility_off"} className="text-[20px]" />
                </button>
              </div>
              <p className="mt-xs font-ui-xs text-ui-xs font-normal tracking-normal text-text-secondary">
                Must be at least 8 characters long.
              </p>
            </div>
            <div className="mt-md flex items-start">
              <div className="flex h-5 items-center">
                <input
                  className="size-4 rounded border-border-subtle bg-surface-bright text-primary-container focus:ring-primary-container"
                  id="terms"
                  name="terms"
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
              </div>
              <div className="ml-sm font-ui-sm text-ui-sm text-text-secondary">
                <label htmlFor="terms">
                  I agree to the{" "}
                  <a className="font-medium text-primary-container underline-offset-2 hover:text-accent-hover hover:underline" href="#">
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a className="font-medium text-primary-container underline-offset-2 hover:text-accent-hover hover:underline" href="#">
                    Privacy Policy
                  </a>
                  .
                </label>
              </div>
            </div>
            <button
              type="submit"
              disabled={loading !== null}
              className="mt-lg flex w-full justify-center rounded-lg border border-transparent bg-primary-container px-lg py-md font-ui-base text-ui-base font-medium text-on-primary shadow-sm transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-primary-container focus:ring-offset-2 disabled:opacity-70"
            >
              {loading === "form" ? "Creating account…" : "Create Account"}
            </button>
          </form>

          <div className="mt-xl text-center">
            <p className="font-ui-sm text-ui-sm text-text-secondary">
              Already have an account?{" "}
              <Link
                className="font-medium text-primary-container underline-offset-2 hover:text-accent-hover hover:underline"
                href="/login"
              >
                Sign in
              </Link>
            </p>
          </div>
          <div className="relative mt-lg">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border-subtle" />
            </div>
            <div className="relative flex justify-center text-ui-sm">
              <span className="bg-document-surface px-sm text-text-muted">Single sign-on (coming soon)</span>
            </div>
          </div>
          <div className="mt-lg grid grid-cols-2 gap-sm">
            <ProviderButton icon="g_mobiledata" label="Google" />
            <ProviderButton icon="business_center" label="SSO" />
          </div>
        </div>
      </div>
    </div>
  );
}

// SSO/OAuth is not implemented in the backend yet (email + password only), so
// these providers render as disabled placeholders.
function ProviderButton({ icon, label }: { icon: string; label: string }) {
  return (
    <button
      type="button"
      disabled
      title="Coming soon"
      className="flex w-full cursor-not-allowed justify-center rounded-lg border border-border-subtle bg-surface-bright px-md py-sm font-ui-sm text-ui-sm font-medium text-text-primary opacity-60"
    >
      <Icon name={icon} className="mr-xs text-[18px]" /> {label}
    </button>
  );
}

function Field({
  id,
  label,
  icon,
  placeholder,
  type,
  value,
  onChange,
}: {
  id: string;
  label: string;
  icon: string;
  placeholder: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-xs block font-ui-sm text-ui-sm font-medium text-text-primary" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-sm">
          <Icon name={icon} className="text-[20px] text-outline" />
        </div>
        <input
          className="block w-full rounded-lg border border-border-subtle bg-surface-bright py-sm pl-[36px] pr-sm font-ui-base text-ui-base text-text-primary transition-colors placeholder:text-text-muted focus:border-primary-container focus:ring-1 focus:ring-primary-container"
          id={id}
          name={id}
          placeholder={placeholder}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
