"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { OmpWordmark } from "@/components/OmpWordmark";
import styles from "./login.module.css";

/**
 * Sign-in, reached from `proxy.ts` when a locked server turns away a navigation.
 *
 * The page posts the password to `/api/web-access/login`, which sets an
 * `httpOnly` session cookie, and then hands the browser back to `/`. The
 * username is fixed at `omp` and is not asked for.
 */

export default function LoginPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    if (password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/web-access/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        setError(data?.error ?? `HTTP ${response.status}`);
        return;
      }
      // `replace` so the browser Back button does not return to a login form
      // that is already satisfied.
      router.replace("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [password, router]);

  return (
    <main className={styles.page}>
      <div className={`${styles.card} omp-pop-in`}>
        <div className={styles.brand}>
          <OmpWordmark markSize={20} />
        </div>

        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.lead}>
          omp-web is locked. Sign in with the username <code>omp</code> and your password.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void signIn();
          }}
        >
          <label className={styles.field}>
            <span>Password</span>
            <div className={styles.control}>
              <input
                ref={inputRef}
                className={styles.input}
                type={revealed ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className={styles.reveal}
                aria-label={revealed ? "Hide password" : "Show password"}
                aria-pressed={revealed}
                onClick={() => {
                  setRevealed((current) => !current);
                  inputRef.current?.focus();
                }}
              >
                {revealed ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <p className={styles.error} role="alert" aria-live="polite">
            {error ?? ""}
          </p>

          <button type="submit" className={styles.primary} disabled={busy || password.length === 0}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className={styles.aside}>
          <Link href="/recover">Forgot password?</Link>
        </p>
      </div>
    </main>
  );
}
