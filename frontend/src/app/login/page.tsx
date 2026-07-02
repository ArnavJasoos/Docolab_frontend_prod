"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Icon } from "@/components/icon";
import * as auth from "@/lib/api/auth";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [remember, setRemember] = React.useState(false);
  const [loading, setLoading] = React.useState<null | "form">(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim()) return setError("Please enter your email.");
    if (!password) return setError("Please enter your password.");

    setLoading("form");
    try {
      const user = await auth.login({ username, password });
      toast.success(`Welcome back, ${user.name.split(" ")[0]}`);
      router.push("/browser");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign you in.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-app-bg text-on-surface">
      {/* Left: branding */}
      <div className="relative hidden w-1/2 flex-col justify-center overflow-hidden border-r border-border-subtle bg-[#ECEEF2] p-xxl lg:flex">
        <div className="relative z-10 w-full max-w-[420px]">
          <div className="mb-xxl flex items-center gap-sm">
            <div className="flex size-8 items-center justify-center rounded bg-primary">
              <Icon name="description" fill className="text-[20px] text-on-primary" />
            </div>
            <span className="font-display-sm text-display-sm font-bold tracking-tight text-primary">
              Docflow
            </span>
          </div>
          <h1 className="mb-xl font-display-lg text-display-lg text-text-primary">
            Documents that move at your team&apos;s speed.
          </h1>
          <p className="mb-xxl font-ui-lg text-ui-lg text-text-secondary">
            Secure, collaborative workspaces designed for high-performance teams
            to ideate, review, and finalize without friction.
          </p>
          <ul className="flex flex-col gap-md border-t border-border-strong pt-lg">
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
        <div
          className="pointer-events-none absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              "radial-gradient(circle at 2px 2px, #CBD5E1 1px, transparent 0)",
            backgroundSize: "24px 24px",
          }}
        />
      </div>

      {/* Right: form */}
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto bg-document-surface px-lg py-xl">
        <div className="mb-xl flex items-center gap-sm lg:hidden">
          <div className="flex size-8 items-center justify-center rounded bg-primary">
            <Icon name="description" fill className="text-[20px] text-on-primary" />
          </div>
          <span className="font-display-sm text-display-sm font-bold tracking-tight text-primary">
            Docolab
          </span>
        </div>
        <div className="w-full max-w-[400px]">
          <div className="mb-lg text-center lg:text-left">
            <h2 className="mb-xs font-ui-xl text-ui-xl text-text-primary">
              Sign in to your account
            </h2>
            <p className="font-ui-base text-ui-base text-text-secondary">
              Welcome back. Please enter your details.
            </p>
          </div>

          {error && (
            <div className="mb-lg flex items-center gap-2 rounded-lg border border-status-destructive/30 bg-deletion-bg px-3 py-2 font-ui-sm text-ui-sm text-deletion-text">
              <Icon name="error" size={18} />
              {error}
            </div>
          )}

          <form className="space-y-lg" onSubmit={handleSubmit} noValidate>
            <div>
              <label
                className="mb-xs block font-ui-sm text-ui-sm font-medium text-text-primary"
                htmlFor="username"
              >
                Email
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <Icon name="mail" className="text-[20px] text-text-muted" />
                </div>
                <input
                  className="block h-[44px] w-full rounded-lg border border-border-subtle bg-document-surface pl-10 pr-3 font-ui-base text-ui-base text-text-primary transition-shadow placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  id="username"
                  name="username"
                  placeholder="you@company.com"
                  type="email"
                  autoComplete="email"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label
                className="mb-xs block font-ui-sm text-ui-sm font-medium text-text-primary"
                htmlFor="password"
              >
                Password
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <Icon name="lock" className="text-[20px] text-text-muted" />
                </div>
                <input
                  className="block h-[44px] w-full rounded-lg border border-border-subtle bg-document-surface pl-10 pr-10 font-ui-base text-ui-base text-text-primary transition-shadow placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  id="password"
                  name="password"
                  placeholder="••••••••"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-text-muted transition-colors hover:text-text-primary focus:outline-none"
                >
                  <Icon name={showPassword ? "visibility" : "visibility_off"} className="text-[20px]" />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 font-ui-sm text-ui-sm text-text-secondary">
                <input
                  className="size-4 rounded border-border-subtle text-primary focus:ring-primary"
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember for 30 days
              </label>
              <a
                href="#"
                className="font-ui-sm text-ui-sm font-semibold text-primary transition-colors hover:text-accent-hover"
              >
                Forgot password?
              </a>
            </div>

            <button
              type="submit"
              disabled={loading !== null}
              className="flex h-[44px] w-full items-center justify-center rounded-lg border border-transparent bg-primary-container px-4 font-ui-base text-ui-base font-semibold text-on-primary shadow-sm transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-70"
            >
              {loading === "form" ? "Signing in…" : "Sign In"}
            </button>
          </form>

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

          <p className="mt-xl text-center font-ui-sm text-ui-sm text-text-secondary">
            Don&apos;t have an account?{" "}
            <Link
              className="font-semibold text-primary underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
              href="/"
            >
              Request access
            </Link>
          </p>
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
      className="flex h-[44px] w-full cursor-not-allowed items-center justify-center rounded-lg border border-border-subtle bg-document-surface px-md font-ui-sm text-ui-sm font-medium text-text-primary opacity-60 shadow-sm"
    >
      <Icon name={icon} className="mr-xs text-[18px]" /> {label}
    </button>
  );
}
